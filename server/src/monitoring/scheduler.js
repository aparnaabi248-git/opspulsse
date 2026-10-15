const cron = require('node-cron');
const Monitor = require('../models/Monitor');
const { executeCheck } = require('../services/monitorService');
const { Lease } = require('./lease');
const config = require('../config');
const logger = require('../config/logger');

/**
 * Monitoring scheduler
 * ====================
 * A background job that checks every monitor when it is due.
 *
 * How one tick works
 * ------------------
 *   1. Ask MongoDB for the lease. Only the holder schedules anything.
 *   2. Find monitors whose nextCheckAt has passed and that are not paused.
 *   3. Skip any monitor already being checked (see "No overlapping checks").
 *   4. Run the checks, at most SCHEDULER_MAX_CONCURRENCY at a time.
 *
 * No overlapping checks
 * ---------------------
 * If a target takes 30 s to respond but the interval is 30 s, the next tick
 * must NOT start a second request for the same monitor. Every running monitor
 * ID is kept in the `inFlight` set for exactly as long as its check runs, and
 * a monitor already in that set is skipped.
 *
 * Single instance rule
 * --------------------
 * Set SCHEDULER_ENABLED=false on every replica except one, or let the MongoDB
 * lease decide automatically. Never run the scheduler on all replicas.
 */

const state = {
  started: false,
  isLeader: false,
  instanceId: null,
  task: null,
  lease: null,
  ticking: false,
  inFlight: new Map(), // monitorId -> startedAt
  stats: {
    ticks: 0,
    checksRun: 0,
    checksSkippedOverlap: 0,
    checksFailed: 0,
    monitorsExamined: 0,
    lastTickAt: null,
    lastCheckAt: null,
    lastError: null,
  },
};

const LEASE_TTL_MS = Math.max(config.scheduler.tickSeconds * 1000 * 3, 30_000);

/**
 * Simple concurrency limiter.
 * The returned function resolves only when its task has finished, so
 * `await limit(fn)` really waits for the check to complete.
 */
function createLimiter(max) {
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= max || queue.length === 0) return;
    active += 1;
    const { task: run, resolve, reject } = queue.shift();
    run().then(resolve, reject).finally(() => {
      active -= 1;
      next();
    });
  };

  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      next();
    });
}

/**
 * Find every monitor that is due for a check right now.
 *
 * NOTE: the full document is loaded on purpose. A projected document would be
 * missing team / expectedStatusCodes / degradedThresholdMs, which would make
 * the check write an incomplete result row.
 */
async function findDueMonitors(now = new Date()) {
  return Monitor.find({
    isPaused: false,
    status: { $ne: 'paused' },
    $or: [{ nextCheckAt: null }, { nextCheckAt: { $lte: now } }],
  })
    .sort({ nextCheckAt: 1 })
    .limit(500);
}

/**
 * Run every check that is currently due.
 * Exported so tests (and a future "run now" admin endpoint) can trigger it
 * without waiting for the cron tick.
 */
async function runDueChecks() {
  // Guard against two ticks overlapping each other
  if (state.ticking) return { skippedTick: true };
  state.ticking = true;

  try {
    state.stats.ticks += 1;
    state.stats.lastTickAt = new Date();
    state.stats.lastError = null;

    const monitors = await findDueMonitors();
    state.stats.monitorsExamined = monitors.length;

    if (monitors.length === 0) return { due: 0, run: 0, skipped: 0 };

    const limit = createLimiter(config.scheduler.maxConcurrentChecks);
    let run = 0;
    let skipped = 0;

    await Promise.all(
      monitors.map(async (monitor) => {
        const key = String(monitor._id);

        // ── Overlap protection ──────────────────────────────────────
        if (state.inFlight.has(key)) {
          skipped += 1;
          state.stats.checksSkippedOverlap += 1;
          logger.debug('Skipping monitor: a check is already running', {
            monitorId: key,
            runningSince: state.inFlight.get(key),
          });
          return;
        }

        state.inFlight.set(key, new Date());
        run += 1;

        await limit(async () => {
          try {
            state.stats.checksRun += 1;
            await executeCheck(monitor, { source: 'scheduled' });
            state.stats.lastCheckAt = new Date();
          } catch (error) {
            state.stats.checksFailed += 1;
            state.stats.lastError = `${monitor.name}: ${error.message}`;
            logger.error('Scheduled check failed', {
              monitorId: key,
              name: monitor.name,
              message: error.message,
            });
          } finally {
            state.inFlight.delete(key);
          }
        });
      })
    );

    return { due: monitors.length, run, skipped };
  } catch (error) {
    state.stats.lastError = error.message;
    logger.error('Scheduler tick failed', { message: error.message });
    return { error: error.message };
  } finally {
    state.ticking = false;
  }
}

/**
 * Promote this instance to the one that does the monitoring work.
 * Called on boot when the lease is free, and later when a previously passive
 * instance notices that the lease holder died.
 */
function promoteToLeader() {
  if (state.isLeader) return;

  state.isLeader = true;
  state.lease.startRenewal();

  logger.info('This instance is now the scheduler leader', {
    instance: state.instanceId,
    tickSeconds: config.scheduler.tickSeconds,
  });

  // Catch up immediately instead of waiting for the next cron tick
  runDueChecks().catch((error) => logger.error('Leader promotion tick failed', { message: error.message }));
}

/** Stop doing monitoring work but keep serving API traffic. */
function demoteToLeader() {
  if (!state.isLeader) return;

  state.isLeader = false;
  state.lease.stopRenewal();

  logger.warn('This instance is no longer the scheduler leader — standing by', {
    instance: state.instanceId,
  });
}

const tick = async () => {
  // Re-check the lease: the holder may have died since the last tick
  if (state.lease && !state.lease.held) {
    const acquired = await state.lease.acquire().catch(() => false);
    if (!acquired) {
      demoteToLeader();
      return;
    }
    promoteToLeader();
  }

  if (!state.isLeader) return;

  await runDueChecks();
};

/**
 * Start the scheduler.
 * @returns {Promise<{started:boolean, isLeader:boolean, reason?:string}>}
 */
async function startScheduler() {
  if (state.started) return { started: true, isLeader: state.isLeader };
  if (!config.scheduler.enabled) {
    logger.warn('Scheduler is disabled (SCHEDULER_ENABLED=false)');
    return { started: false, isLeader: false, reason: 'disabled' };
  }

  state.lease = new Lease({ ttlMs: LEASE_TTL_MS });
  state.instanceId = state.lease.instanceId;

  state.isLeader = await state.lease.acquire();
  state.lease.onLost = demoteToLeader;

  state.task = cron.schedule(
    `*/${config.scheduler.tickSeconds} * * * * *`,
    () => {
      tick().catch((error) => logger.error('Scheduler tick crashed', { message: error.message }));
    },
    { timezone: 'UTC' }
  );

  if (state.isLeader) {
    logger.info('Monitoring scheduler started', {
      instance: state.instanceId,
      tickSeconds: config.scheduler.tickSeconds,
      maxConcurrency: config.scheduler.maxConcurrentChecks,
    });
    // Run one tick immediately so new monitors are checked without waiting
    state.lease.startRenewal();
    runDueChecks().catch((error) => logger.error('Initial scheduler tick failed', { message: error.message }));
  } else {
    logger.info('Backend started as a PASSIVE instance (no monitoring jobs)', {
      instance: state.instanceId,
      note: 'This replica serves API traffic only',
    });
  }

  state.started = true;
  return { started: true, isLeader: state.isLeader };
}

/**
 * Stop the scheduler and release the lease.
 */
async function stopScheduler() {
  if (state.task) {
    state.task.stop();
    state.task = null;
  }
  if (state.lease) {
    await state.lease.release().catch(() => {});
    state.lease = null;
  }
  state.started = false;
  state.isLeader = false;
  state.inFlight.clear();
  logger.info('Monitoring scheduler stopped');
}

/** Diagnostics for the health/readiness endpoints. */
function getSchedulerStatus() {
  return {
    started: state.started,
    enabled: config.scheduler.enabled,
    isLeader: state.isLeader,
    instanceId: state.instanceId,
    tickSeconds: config.scheduler.tickSeconds,
    maxConcurrency: config.scheduler.maxConcurrentChecks,
    runningChecks: state.inFlight.size,
    stats: { ...state.stats },
  };
}

module.exports = {
  startScheduler,
  stopScheduler,
  runDueChecks,
  getSchedulerStatus,
  findDueMonitors,
  promoteToLeader,
  demoteToLeader,
  _internal: state, // exposed for tests only
};