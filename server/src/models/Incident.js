const mongoose = require('mongoose');

/**
 * Incident
 * ========
 * A single outage episode for one monitor.
 *
 * Deduplication rule: a monitor can have at most ONE active incident
 * (open or acknowledged). This is enforced by a database index, not just by
 * application code, so even two schedulers racing each other cannot create
 * two open incidents for the same monitor.
 *
 *   unique index on { monitor, active } where active === true
 */

const INCIDENT_STATUSES = ['open', 'acknowledged', 'resolved'];
const INCIDENT_SEVERITIES = ['info', 'warning', 'critical'];
const TIMELINE_TYPES = ['created', 'failed_check', 'acknowledged', 'note', 'recovery', 'resolved'];

const timelineSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true, default: Date.now },
    type: { type: String, enum: { values: TIMELINE_TYPES }, required: true },
    message: { type: String, required: true },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { _id: false }
);

const incidentSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Incident title is required'],
      trim: true,
      maxlength: [160, 'Title cannot exceed 160 characters'],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [2000, 'Description cannot exceed 2000 characters'],
      default: '',
    },

    monitor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Monitor',
      required: [true, 'Incident must reference a monitor'],
    },
    team: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
      required: true,
    },

    severity: {
      type: String,
      enum: { values: INCIDENT_SEVERITIES, message: `Severity must be one of ${INCIDENT_SEVERITIES.join(', ')}` },
      default: 'critical',
    },
    status: {
      type: String,
      enum: { values: INCIDENT_STATUSES, message: `Status must be one of ${INCIDENT_STATUSES.join(', ')}` },
      default: 'open',
    },

    // True while the incident is not yet resolved.
    // The unique partial index below depends on this field.
    active: { type: Boolean, default: true, index: true },

    startedAt: { type: Date, required: true, default: Date.now },
    acknowledgedAt: { type: Date, default: null },
    acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolutionNotes: { type: String, trim: true, maxlength: [2000, 'Notes cannot exceed 2000 characters'], default: '' },

    // Evidence of the outage
    failureCount: { type: Number, default: 1, min: 0 },
    lastError: { type: String, default: null },
    downtimeMs: { type: Number, default: null },

    timeline: { type: [timelineSchema], default: [] },
  },
  { timestamps: true }
);

// ── Indexes ──────────────────────────────────────────────────────────
incidentSchema.index({ team: 1, status: 1, startedAt: -1 });
incidentSchema.index({ monitor: 1, startedAt: -1 });
// ONE active incident per monitor — enforced by MongoDB itself
incidentSchema.index(
  { monitor: 1, active: 1 },
  { unique: true, partialFilterExpression: { active: true }, name: 'one_active_incident_per_monitor' }
);

/** Convenience duration in ms, still counting while the incident is open. */
incidentSchema.methods.getDurationMs = function getDurationMs(now = Date.now()) {
  const end = this.resolvedAt ? new Date(this.resolvedAt).getTime() : now;
  return Math.max(0, end - new Date(this.startedAt).getTime());
};

incidentSchema.methods.addTimelineEntry = function addTimelineEntry(type, message, actor = null) {
  this.timeline.push({ at: new Date(), type, message, actor });
  return this;
};

module.exports = mongoose.model('Incident', incidentSchema);
module.exports.INCIDENT_STATUSES = INCIDENT_STATUSES;
module.exports.INCIDENT_SEVERITIES = INCIDENT_SEVERITIES;