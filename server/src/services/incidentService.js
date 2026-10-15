const Incident = require('../models/Incident');
const { notifyTeam } = require('./alertService');
const { emitToTeam, emitToUser } = require('../socket');
const logger = require('../config/logger');

/**
 * Incident service
 * ================
 * An incident is ONE outage episode for one monitor.
 *
 * Deduplication
 * -------------
 * While a check fails we do NOT create a new incident every time. Instead:
 *   - if there is an ACTIVE incident for the monitor, it is updated and a
 *     `failed_check` entry is appended to its timeline
 *   - only when there is none, and the monitor has failed `failureThreshold`
 *     times in a row, is a new incident opened
 *
 * Two database-level guards back this up:
 *   1. a unique partial index (monitor + active:true) makes a second active
 *      incident impossible, even if two schedulers race
 *   2. every open/acknowledge/resolve also emits an idempotent alert key
 */

const severityFromFailures = (consecutiveFailures) => {
  if (consecutiveFailures >= 5) return 'critical';
  if (consecutiveFailures >= 2) return 'warning';
  return 'info';
};

const findActiveIncident = (monitorId) =>
  Incident.findOne({ monitor: monitorId, active: true });

/**
 * Record a failed check. Opens a new incident when the failure threshold is
 * met, otherwise updates the one that is already open.
 *
 * @returns {Promise<{incident: object|null, created: boolean, suppressed?: boolean}>}
 */
async function recordFailure(monitor, checkResult) {
  const threshold = Math.max(monitor.failureThreshold || 1, 1);
  const belowThreshold = monitor.consecutiveFailures < threshold;

  let incident = await findActiveIncident(monitor._id);

  // ── Still inside the grace period: do not open an incident yet ─────
  if (belowThreshold && !incident) {
    logger.info('Check failed, threshold not reached yet', {
      monitorId: String(monitor._id),
      consecutiveFailures: monitor.consecutiveFailures,
      failureThreshold: threshold,
    });
    return { incident: null, created: false };
  }

  let justCreated = false;
  const now = checkResult?.checkedAt ? new Date(checkResult.checkedAt) : new Date();

  if (!incident) {
    try {
      incident = await Incident.create({
        title: `${monitor.name} is not responding`,
        description: buildDescription(monitor, checkResult),
        monitor: monitor._id,
        team: monitor.team,
        severity: severityFromFailures(monitor.consecutiveFailures),
        status: 'open',
        active: true,
        startedAt: now,
        // The threshold may be > 1, so the incident already covers several
        // failed checks at the moment it is opened.
        failureCount: Math.max(monitor.consecutiveFailures, 1),
        lastError: checkResult?.errorMessage ?? monitor.lastError ?? 'Check failed',
        timeline: [
          {
            at: now,
            type: 'created',
            message: `Opened automatically after ${monitor.consecutiveFailures} consecutive failed checks.`,
            actor: null,
          },
        ],
      });
      justCreated = true;
    } catch (error) {
      // 11000 = another writer opened one first. Use theirs.
      if (error.code === 11000) {
        incident = await findActiveIncident(monitor._id);
      } else {
        throw error;
      }
    }
  }

  if (!incident) return { incident: null, created: false };

  const created = justCreated;

  // A newly created incident already counted this failure in failureCount: 1,
  // so only pre-existing incidents are incremented here.
  if (!justCreated) {
    incident.failureCount += 1;
    incident.lastError = checkResult?.errorMessage ?? monitor.lastError ?? 'Check failed';

    // A worsening outage escalates, it never de-escalates while still failing
    const nextSeverity = severityFromFailures(monitor.consecutiveFailures);
    const order = { info: 0, warning: 1, critical: 2 };
    if (order[nextSeverity] > order[incident.severity]) {
      incident.severity = nextSeverity;
    }

    incident.addTimelineEntry(
      'failed_check',
      `Check #${incident.failureCount} failed — ${incident.lastError}${
        checkResult?.statusCode ? ` (HTTP ${checkResult.statusCode})` : ''
      }`
    );
  }

  await incident.save();

  const alert = await notifyTeam({
    type: 'incident_created',
    dedupeKey: `incident_created:${incident._id}`,
    title: created ? `Incident opened: ${monitor.name}` : `${monitor.name} still down`,
    message: created
      ? `${monitor.name} failed ${monitor.consecutiveFailures} checks in a row. ${incident.lastError}`
      : `Check #${incident.failureCount} failed for ${monitor.name}. ${incident.lastError}`,
    severity: incident.severity,
    team: monitor.team,
    monitor: monitor._id,
    incident: incident._id,
    cooldownMs: 5 * 60 * 1000,
  });

  broadcastIncident(incident, created ? 'incident:created' : 'incident:updated');

  return { incident, created: alert.created > 0, suppressed: alert.suppressed > 0 };
}

/**
 * The monitor recovered. Resolve any incident that is still open.
 */
async function recordRecovery(monitor, checkResult) {
  const incident = await findActiveIncident(monitor._id);
  if (!incident) return { incident: null, resolved: false };

  const now = checkResult?.checkedAt ? new Date(checkResult.checkedAt) : new Date();

  incident.status = 'resolved';
  incident.active = false;
  incident.resolvedAt = now;
  incident.resolutionNotes = 'Automatically resolved — the monitor is responding normally again.';
  incident.downtimeMs = Math.max(0, now.getTime() - new Date(incident.startedAt).getTime());

  incident.addTimelineEntry(
    'recovery',
    `Monitor responded normally again (HTTP ${checkResult?.statusCode ?? '—'}).`
  );
  incident.addTimelineEntry('resolved', 'Incident resolved automatically.');
  await incident.save();

  await notifyTeam({
    type: 'incident_resolved',
    dedupeKey: `incident_resolved:${incident._id}`,
    title: `Resolved: ${monitor.name}`,
    message: `"${monitor.name}" recovered after ${formatDuration(incident.downtimeMs)}.`,
    severity: 'info',
    team: monitor.team,
    monitor: monitor._id,
    incident: incident._id,
  });

  // Somebody watching that monitor should see it green again
  emitToTeam(monitor.team, 'monitor:status', {
    monitorId: String(monitor._id),
    name: monitor.name,
    status: 'up',
    previousStatus: 'down',
    isRecovering: false,
    at: now.toISOString(),
  });

  broadcastIncident(incident, 'incident:resolved');

  return { incident, resolved: true };
}

/**
 * The monitor turned degraded (slow but responding).
 */
async function recordDegraded(monitor, checkResult) {
  const alert = await notifyTeam({
    type: 'monitor_degraded',
    dedupeKey: `monitor_degraded:${monitor._id}`,
    title: `Degraded: ${monitor.name}`,
    message: checkResult?.errorMessage ?? `${monitor.name} is responding slowly.`,
    severity: 'warning',
    team: monitor.team,
    monitor: monitor._id,
    cooldownMs: 10 * 60 * 1000,
  });

  return { notified: alert.created > 0, suppressed: alert.suppressed > 0 };
}

// ── Manual actions ───────────────────────────────────────────────────

async function acknowledgeIncident(incidentId, user) {
  const incident = await Incident.findById(incidentId);
  if (!incident) return { error: 'NOT_FOUND' };

  if (incident.status === 'resolved') {
    return { error: 'ALREADY_RESOLVED' };
  }
  if (incident.status === 'acknowledged') {
    return { error: 'ALREADY_ACKNOWLEDGED' };
  }

  incident.status = 'acknowledged';
  incident.acknowledgedAt = new Date();
  incident.acknowledgedBy = user._id;
  incident.addTimelineEntry('acknowledged', `Acknowledged by ${user.name}.`, user._id);
  await incident.save();

  await notifyTeam({
    type: 'incident_acknowledged',
    dedupeKey: `incident_acknowledged:${incident._id}`,
    title: `Acknowledged: ${incident.title}`,
    message: `${user.name} is looking into "${incident.title}".`,
    severity: incident.severity,
    team: incident.team,
    monitor: incident.monitor,
    incident: incident._id,
    onlyUsers: [user._id],
  });

  broadcastIncident(incident, 'incident:updated');
  return { incident };
}

async function resolveIncidentManually(incidentId, user, notes = '') {
  const incident = await Incident.findById(incidentId);
  if (!incident) return { error: 'NOT_FOUND' };

  if (incident.status === 'resolved') {
    return { error: 'ALREADY_RESOLVED' };
  }

  const now = new Date();
  incident.status = 'resolved';
  incident.active = false;
  incident.resolvedAt = now;
  incident.resolvedBy = user._id;
  incident.resolutionNotes = notes || 'Resolved manually.';
  incident.downtimeMs = Math.max(0, now.getTime() - new Date(incident.startedAt).getTime());

  incident.addTimelineEntry(
    'resolved',
    `Resolved manually by ${user.name}.${notes ? ` ${notes}` : ''}`,
    user._id
  );
  await incident.save();

  await notifyTeam({
    type: 'incident_resolved',
    dedupeKey: `incident_resolved:${incident._id}`,
    title: `Resolved: ${incident.title}`,
    message: `${user.name} closed this incident.`,
    severity: 'info',
    team: incident.team,
    monitor: incident.monitor,
    incident: incident._id,
  });

  broadcastIncident(incident, 'incident:resolved');
  return { incident };
}

async function addNote(incidentId, user, message) {
  const incident = await Incident.findById(incidentId);
  if (!incident) return { error: 'NOT_FOUND' };
  if (incident.status === 'resolved') return { error: 'ALREADY_RESOLVED' };

  incident.addTimelineEntry('note', message, user._id);
  await incident.save();

  broadcastIncident(incident, 'incident:updated');
  return { incident };
}

// ── Helpers ──────────────────────────────────────────────────────────

const buildDescription = (monitor, checkResult) => {
  const parts = [
    `Monitor "${monitor.name}" (${monitor.method} ${monitor.url}) failed ${monitor.consecutiveFailures} consecutive checks.`,
  ];
  if (checkResult?.errorMessage) parts.push(`Last error: ${checkResult.errorMessage}`);
  if (checkResult?.responseTimeMs) parts.push(`Last check took ${checkResult.responseTimeMs} ms.`);
  return parts.join(' ');
};

const formatDuration = (ms) => {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};

/**
 * Push the incident to every team member.
 * The payload contains no secrets — just what a dashboard needs to render.
 */
const broadcastIncident = (incident, event) => {
  emitToTeam(incident.team, event, {
    id: String(incident._id),
    monitor: String(incident.monitor),
    title: incident.title,
    severity: incident.severity,
    status: incident.status,
    failureCount: incident.failureCount,
    startedAt: incident.startedAt,
    resolvedAt: incident.resolvedAt,
    at: new Date().toISOString(),
  });

  // Personal nudge for anyone who has not read their notifications yet
  emitToUser(incident.team, 'incident:changed', { id: String(incident._id) });
};

module.exports = {
  recordFailure,
  recordRecovery,
  recordDegraded,
  acknowledgeIncident,
  resolveIncidentManually,
  addNote,
  findActiveIncident,
  severityFromFailures,
};