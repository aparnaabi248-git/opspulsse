const CheckResult = require('../models/CheckResult');
const { runHealthCheck } = require('./healthCheck');
const { recordFailure, recordRecovery, recordDegraded } = require('./incidentService');
const { emitToTeam } = require('../socket');
const logger = require('../config/logger');

/**
 * Monitor service
 * ===============
 * Owns "run one check, store the truth, move the status machine".
 *
 * STATUS MACHINE
 * --------------
 *                  first check
 *     pending  ---------------->  up
 *        |                           |  \        /  (flapping)
 *        |                           |   \      /
 *        |                        degraded   down
 *        |                           |       /
 *        +---------------------------+------+
 *
 *   pending   no check has run yet
 *   up        last check succeeded
 *   degraded  succeeded but slower than degradedThresholdMs
 *   down      last check failed, or recovering but not yet trusted
 *   paused    checks are switched off by a human
 *
 * RECOVERY RULE
 * -------------
 * A monitor that was DOWN does not jump back to UP on the first success if
 * `recoveryThreshold` is greater than 1. It stays DOWN but is flagged
 * `isRecovering`, so a target that flaps for one second does not look healthy.
 */

const HEALTHY = ['up', 'degraded'];

/**
 * Decide the new status and update the monitor's counters.
 * Pure with respect to I/O so it can be unit tested on its own.
 *
 * @param {import('mongoose').Document} monitor
 * @param {'up'|'down'|'degraded'} checkStatus
 * @returns {{newStatus:string, previousStatus:string, changed:boolean,
 *            isRecovery:boolean, isFlapping:boolean, recoveryProgress:number}}
 */
function applyStatusTransition(monitor, checkStatus, checkedAt = new Date()) {
  const previousStatus = monitor.status;

  // ── Failure branch ────────────────────────────────────────────────
  if (checkStatus === 'down') {
    monitor.consecutiveFailures += 1;
    monitor.consecutiveSuccesses = 0;
    monitor.isRecovering = false;
    return commit(monitor, 'down', previousStatus, checkedAt);
  }

  // ── Success branch (up or degraded) ───────────────────────────────
  monitor.consecutiveSuccesses += 1;
  monitor.consecutiveFailures = 0;

  const wasDown = previousStatus === 'down';
  const threshold = Math.max(monitor.recoveryThreshold || 1, 1);

  if (wasDown && monitor.consecutiveSuccesses < threshold) {
    // Recovering: trust the target only after enough consecutive successes
    monitor.isRecovering = true;
    const result = commit(monitor, 'down', previousStatus, checkedAt);
    result.recoveryProgress = monitor.consecutiveSuccesses;
    return result;
  }

  monitor.isRecovering = false;
  const result = commit(monitor, checkStatus, previousStatus, checkedAt);
  result.isRecovery = wasDown;
  return result;
}

function commit(monitor, newStatus, previousStatus, checkedAt) {
  const changed = monitor.status !== newStatus;

  if (changed) {
    monitor.status = newStatus;
    monitor.lastStatusChangeAt = checkedAt;
  }

  // Flapping = it was up-ish before and is failing now, or the other way round
  const isFlapping = changed && HEALTHY.includes(newStatus) !== HEALTHY.includes(previousStatus);

  return {
    newStatus,
    previousStatus,
    changed,
    isRecovery: false,
    isFlapping,
    recoveryProgress: 0,
  };
}

/**
 * Run one health check for a monitor, persist the result and apply the
 * status transition.
 *
 * @param {import('mongoose').Document} monitor
 * @param {{source?: 'scheduled'|'manual'|'api'}} [options]
 */
async function executeCheck(monitor, { source = 'scheduled' } = {}) {
  const previousStatus = monitor.status;
  const startedAt = new Date();

  const raw = await runHealthCheck({
    url: monitor.url,
    method: monitor.method,
    timeoutMs: monitor.timeoutMs,
    expectedStatusCodes: monitor.expectedStatusCodes,
    expectedBodyText: monitor.expectedBodyText,
    degradedThresholdMs: monitor.degradedThresholdMs,
  });

  const checkedAt = new Date();

  const checkResult = await CheckResult.create({
    monitor: monitor._id,
    team: monitor.team,
    status: raw.status,
    outcome: raw.outcome,
    statusCode: raw.statusCode,
    responseTimeMs: raw.responseTimeMs,
    errorMessage: raw.errorMessage || raw.degradedReason || null,
    method: monitor.method,
    finalUrl: raw.finalUrl,
    redirected: raw.redirected,
    redirects: raw.redirects,
    resolvedIp: raw.resolvedIp,
    source,
    checkedAt,
  });

  // ── Persist the live state ────────────────────────────────────────
  monitor.lastCheckAt = checkedAt;
  monitor.lastStatusCode = raw.statusCode;
  monitor.lastResponseTimeMs = raw.responseTimeMs;
  monitor.lastResolvedIp = raw.resolvedIp;

  if (raw.status === 'degraded') {
    monitor.lastError = null;
    monitor.degradedSince = monitor.degradedSince || checkedAt;
  } else if (raw.status === 'up') {
    monitor.lastError = null;
    monitor.degradedSince = null;
  } else {
    monitor.lastError = raw.errorMessage || 'Check failed';
  }

  monitor.totalChecks += 1;
  if (raw.status === 'up') monitor.totalUp += 1;
  else if (raw.status === 'down') monitor.totalDown += 1;
  else monitor.totalDegraded += 1;

  // ── Move the status machine ───────────────────────────────────────
  const transition = applyStatusTransition(monitor, raw.status, checkedAt);

  // Downtime bookkeeping for the active outage episode
  if (transition.newStatus === 'down' && !monitor.downSince) {
    monitor.downSince = checkedAt;
  } else if (transition.newStatus !== 'down') {
    if (monitor.downSince) {
      monitor.totalDowntimeMs += Math.max(0, checkedAt.getTime() - monitor.downSince.getTime());
      monitor.lastDowntimeMs = Math.max(0, checkedAt.getTime() - monitor.downSince.getTime());
      monitor.downSince = null;
    }
  }

  // ── Schedule the next run ─────────────────────────────────────────
  monitor.nextCheckAt = new Date(checkedAt.getTime() + monitor.intervalSeconds * 1000);

  await monitor.save();

  if (transition.changed) {
    logger.info('Monitor status changed', {
      monitorId: String(monitor._id),
      name: monitor.name,
      from: previousStatus,
      to: transition.newStatus,
      responseTimeMs: raw.responseTimeMs,
      statusCode: raw.statusCode,
      source,
    });
  }

  // ── Incidents + real-time broadcast ───────────────────────────────
  const incident = { incident: null, created: false };

  // A failure must be handled on EVERY failed check, not only on the first:
  // once a monitor is already DOWN the status does not "change" again, yet
  // the open incident still has to be updated with the new evidence.
  if (raw.status === 'down') {
    const outcome = await recordFailure(monitor, checkResult);
    incident.incident = outcome.incident;
    incident.created = Boolean(outcome.created);
  } else if (raw.status === 'degraded' && transition.changed) {
    await recordDegraded(monitor, checkResult);
  } else if (transition.changed && HEALTHY.includes(raw.status) && !monitor.isRecovering) {
    await recordRecovery(monitor, checkResult);
  }

  if (transition.changed) {
    emitToTeam(monitor.team, 'monitor:status', {
      monitorId: String(monitor._id),
      name: monitor.name,
      status: raw.status,
      previousStatus,
      isRecovering: monitor.isRecovering,
      responseTimeMs: raw.responseTimeMs,
      statusCode: raw.statusCode,
      lastCheckAt: monitor.lastCheckAt,
      at: new Date().toISOString(),
    });
  }

  // A lightweight activity ping for the dashboard feed
  emitToTeam(monitor.team, 'monitor:check', {
    monitorId: String(monitor._id),
    name: monitor.name,
    url: monitor.url,
    status: raw.status,
    outcome: raw.outcome,
    statusCode: raw.statusCode,
    responseTimeMs: raw.responseTimeMs,
    errorMessage: raw.errorMessage ?? null,
    source,
    checkedAt: checkResult.checkedAt,
  });

  return { checkResult, raw, transition, previousStatus, startedAt, incident };
}

/**
 * Recalculate the next scheduled run time (used after an edit or resume).
 */
function scheduleNextCheck(monitor, from = new Date()) {
  monitor.nextCheckAt = new Date(from.getTime() + monitor.intervalSeconds * 1000);
  return monitor;
}

module.exports = {
  executeCheck,
  scheduleNextCheck,
  applyStatusTransition,
  HEALTHY,
};