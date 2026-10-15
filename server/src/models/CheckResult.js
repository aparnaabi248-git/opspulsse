const mongoose = require('mongoose');
const config = require('../config');

/**
 * CheckResult
 * ===========
 * One persisted row per health check. This is the raw evidence that all
 * uptime, downtime and response-time analytics are calculated from — nothing
 * on the dashboard is invented.
 */

const CHECK_STATUSES = ['up', 'down', 'degraded'];
const CHECK_OUTCOMES = ['ok', 'failed', 'timeout', 'blocked'];
const CHECK_SOURCES = ['scheduled', 'manual', 'api'];

const checkResultSchema = new mongoose.Schema(
  {
    monitor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Monitor',
      required: [true, 'Check result must reference a monitor'],
      index: true,
    },
    team: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: { values: CHECK_STATUSES, message: `Status must be one of ${CHECK_STATUSES.join(', ')}` },
      required: true,
    },

    // How the check ended, independent of the pass/fail status
    outcome: {
      type: String,
      enum: { values: CHECK_OUTCOMES, message: `Outcome must be one of ${CHECK_OUTCOMES.join(', ')}` },
      required: true,
    },

    statusCode: { type: Number, default: null },
    responseTimeMs: { type: Number, required: true, min: 0 },
    errorMessage: { type: String, default: null },

    // Request context, useful when debugging a failed check
    method: { type: String, default: 'GET' },
    finalUrl: { type: String, required: true },
    redirected: { type: Boolean, default: false },
    redirects: { type: Number, default: 0 },
    resolvedIp: { type: String, default: null },

    source: {
      type: String,
      enum: { values: CHECK_SOURCES, message: `Source must be one of ${CHECK_SOURCES.join(', ')}` },
      default: 'scheduled',
    },

    checkedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true }
);

// ── Indexes ──────────────────────────────────────────────────────────
// Primary history query: "newest checks for this monitor"
checkResultSchema.index({ monitor: 1, checkedAt: -1 });
// Dashboard / cross-monitor queries
checkResultSchema.index({ team: 1, checkedAt: -1 });
checkResultSchema.index({ team: 1, status: 1, checkedAt: -1 });
checkResultSchema.index({ status: 1, checkedAt: -1 });

// Optional data retention: MongoDB removes the document once it is older.
// Disabled (0 days) by default so nothing is deleted without asking.
if (config.retention.checkResultsDays > 0) {
  checkResultSchema.index(
    { checkedAt: 1 },
    { expireAfterSeconds: config.retention.checkResultsDays * 24 * 60 * 60 }
  );
}

module.exports = mongoose.model('CheckResult', checkResultSchema);
module.exports.CHECK_STATUSES = CHECK_STATUSES;
module.exports.CHECK_OUTCOMES = CHECK_OUTCOMES;