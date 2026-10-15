const mongoose = require('mongoose');
const config = require('../config');

/**
 * Monitor
 * =======
 * One website / API endpoint that OpsPulse checks on a schedule.
 * Belongs to a Team; every read and write is authorised through team
 * membership (owner / admin / viewer).
 */

const MONITOR_STATUSES = ['pending', 'up', 'down', 'degraded', 'paused'];
const MONITOR_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

const monitorSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Monitor name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [80, 'Name cannot exceed 80 characters'],
    },

    url: {
      type: String,
      required: [true, 'Monitor URL is required'],
      trim: true,
      maxlength: [2048, 'URL is too long'],
    },

    method: {
      type: String,
      enum: { values: MONITOR_METHODS, message: `Method must be one of ${MONITOR_METHODS.join(', ')}` },
      default: 'GET',
    },

    // ── Team ownership ───────────────────────────────────────────────
    team: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
      required: [true, 'A monitor must belong to a team'],
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // ── Check configuration ──────────────────────────────────────────
    intervalSeconds: {
      type: Number,
      required: true,
      min: [config.monitor.minIntervalSeconds, `Interval must be at least ${config.monitor.minIntervalSeconds}s`],
      max: [config.monitor.maxIntervalSeconds, `Interval cannot exceed ${config.monitor.maxIntervalSeconds}s`],
      default: config.monitor.defaultIntervalSeconds,
    },
    timeoutMs: {
      type: Number,
      required: true,
      min: [config.monitor.minTimeoutMs, `Timeout must be at least ${config.monitor.minTimeoutMs} ms`],
      max: [config.monitor.maxTimeoutMs, `Timeout cannot exceed ${config.monitor.maxTimeoutMs} ms`],
      default: config.monitor.defaultTimeoutMs,
    },
    expectedStatusCodes: {
      type: [Number],
      default: [200],
      validate: {
        validator: (codes) => Array.isArray(codes) && codes.length > 0 && codes.every((c) => Number.isInteger(c) && c >= 100 && c <= 599),
        message: 'Expected status codes must be a non-empty list of HTTP codes (100–599)',
      },
    },
    expectedBodyText: {
      type: String,
      trim: true,
      maxlength: [200, 'Expected text cannot exceed 200 characters'],
      default: '',
    },
    degradedThresholdMs: {
      type: Number,
      min: [0, 'Degraded threshold cannot be negative'],
      max: [config.monitor.maxTimeoutMs * 10, 'Degraded threshold is too large'],
      default: config.monitor.defaultDegradedThresholdMs,
    },
    failureThreshold: {
      type: Number,
      min: [1, 'At least 1 failed check is required'],
      max: [20, 'Failure threshold cannot exceed 20'],
      default: 3,
    },
    // Consecutive successes needed before a DOWN monitor is trusted again.
    // 1 = recover immediately, 2 = one extra confirmation.
    recoveryThreshold: {
      type: Number,
      min: [1, 'Recovery threshold must be at least 1'],
      max: [10, 'Recovery threshold cannot exceed 10'],
      default: 1,
    },

    // ── Live state (written by the scheduler / manual checks) ─────────
    status: {
      type: String,
      enum: { values: MONITOR_STATUSES, message: `Status must be one of ${MONITOR_STATUSES.join(', ')}` },
      default: 'pending',
    },
    lastCheckAt: { type: Date, default: null },
    lastStatusChangeAt: { type: Date, default: null },
    lastStatusCode: { type: Number, default: null },
    lastResponseTimeMs: { type: Number, default: null },
    lastError: { type: String, default: null },
    lastResolvedIp: { type: String, default: null },
    consecutiveFailures: { type: Number, default: 0, min: 0 },
    consecutiveSuccesses: { type: Number, default: 0, min: 0 },
    // True while a DOWN monitor is being confirmed back up
    isRecovering: { type: Boolean, default: false },

    // ── Downtime accounting (real, derived from check timestamps) ─────
    downSince: { type: Date, default: null },
    totalDowntimeMs: { type: Number, default: 0, min: 0 },
    lastDowntimeMs: { type: Number, default: 0, min: 0 },
    degradedSince: { type: Date, default: null },

    // ── Cheap running totals for instant dashboard numbers ───────────
    totalChecks: { type: Number, default: 0, min: 0 },
    totalUp: { type: Number, default: 0, min: 0 },
    totalDown: { type: Number, default: 0, min: 0 },
    totalDegraded: { type: Number, default: 0, min: 0 },

    // ── Scheduling ───────────────────────────────────────────────────
    isPaused: { type: Boolean, default: false },
    pausedAt: { type: Date, default: null },
    // Remembers the live status so "Resume" can restore it instead of
    // pretending the monitor is healthy before the first check runs.
    statusBeforePause: {
      type: String,
      enum: { values: MONITOR_STATUSES },
      default: null,
    },
    nextCheckAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ── Indexes ──────────────────────────────────────────────────────────
monitorSchema.index({ team: 1, status: 1 });
monitorSchema.index({ team: 1, createdAt: -1 });
monitorSchema.index({ status: 1, isPaused: 1, nextCheckAt: 1 }); // scheduler lookup
monitorSchema.index({ name: 'text', url: 'text' }); // search

// ── Instance helpers ─────────────────────────────────────────────────

/** Is this monitor scheduled for another check right now? */
monitorSchema.methods.isDue = function isDue(now = new Date()) {
  if (this.isPaused || this.status === 'paused') return false;
  if (!this.nextCheckAt) return true;
  return this.nextCheckAt.getTime() <= now.getTime();
};

/** Public JSON shape — never leaks internal scheduling fields. */
monitorSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id,
    name: this.name,
    url: this.url,
    method: this.method,
    team: this.team,
    status: this.status,
    intervalSeconds: this.intervalSeconds,
    timeoutMs: this.timeoutMs,
    expectedStatusCodes: this.expectedStatusCodes,
    expectedBodyText: this.expectedBodyText,
    degradedThresholdMs: this.degradedThresholdMs,
    failureThreshold: this.failureThreshold,
    recoveryThreshold: this.recoveryThreshold,
    isPaused: this.isPaused,
    pausedAt: this.pausedAt,
    nextCheckAt: this.isPaused ? null : this.nextCheckAt,
    lastCheckAt: this.lastCheckAt,
    lastStatusChangeAt: this.lastStatusChangeAt,
    lastStatusCode: this.lastStatusCode,
    lastResponseTimeMs: this.lastResponseTimeMs,
    lastError: this.lastError,
    lastResolvedIp: this.lastResolvedIp,
    consecutiveFailures: this.consecutiveFailures,
    consecutiveSuccesses: this.consecutiveSuccesses,
    isRecovering: this.isRecovering,
    recoveryProgress: this.isRecovering
      ? { done: this.consecutiveSuccesses, needed: this.recoveryThreshold }
      : null,
    downtime: {
      currentSince: this.downSince,
      totalMs: this.totalDowntimeMs + (this.downSince ? Date.now() - this.downSince.getTime() : 0),
      lastEpisodeMs: this.lastDowntimeMs,
    },
    totals: {
      checks: this.totalChecks,
      up: this.totalUp,
      down: this.totalDown,
      degraded: this.totalDegraded,
    },
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

module.exports = mongoose.model('Monitor', monitorSchema);
module.exports.MONITOR_STATUSES = MONITOR_STATUSES;
module.exports.MONITOR_METHODS = MONITOR_METHODS;