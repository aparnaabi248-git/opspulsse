const mongoose = require('mongoose');

/**
 * Notification
 * ============
 * In-app alert shown in the notification centre. Always persisted, even if
 * SMTP is not configured, so an alert is never silently lost.
 *
 * Deduplication: every notification carries a deterministic `dedupeKey`.
 * A cooldown window plus this key stops one flapping monitor from flooding
 * the bell icon every few seconds.
 */

const NOTIFICATION_TYPES = [
  'monitor_down',
  'monitor_recovered',
  'monitor_degraded',
  'incident_created',
  'incident_acknowledged',
  'incident_resolved',
  'info',
];

const NOTIFICATION_SEVERITIES = ['info', 'warning', 'critical'];

const notificationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Notification must belong to a user'],
    },
    team: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', default: null },
    monitor: { type: mongoose.Schema.Types.ObjectId, ref: 'Monitor', default: null },
    incident: { type: mongoose.Schema.Types.ObjectId, ref: 'Incident', default: null },

    type: {
      type: String,
      enum: { values: NOTIFICATION_TYPES, message: `Type must be one of ${NOTIFICATION_TYPES.join(', ')}` },
      required: true,
    },
    severity: {
      type: String,
      enum: { values: NOTIFICATION_SEVERITIES, message: `Severity must be one of ${NOTIFICATION_SEVERITIES.join(', ')}` },
      default: 'info',
    },

    title: { type: String, required: [true, 'Notification title is required'], maxlength: 160 },
    message: { type: String, required: true, maxlength: 1000 },

    read: { type: Boolean, default: false },
    readAt: { type: Date, default: null },

    // Deterministic key such as "monitor_down:<monitorId>:<incidentId>"
    dedupeKey: { type: String, required: true },

    // Outcome of the optional email delivery attempt.
    // We never claim an email was sent when SMTP is off or delivery failed.
    email: {
      status: {
        type: String,
        enum: ['not_attempted', 'sent', 'failed', 'skipped_not_configured', 'no_recipient'],
        default: 'not_attempted',
      },
      error: { type: String, default: null },
      sentAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

// ── Indexes ──────────────────────────────────────────────────────────
notificationSchema.index({ user: 1, read: 1, createdAt: -1 }); // notification centre + unread badge
notificationSchema.index({ dedupeKey: 1 }); // cooldown / dedup lookups
notificationSchema.index({ user: 1, dedupeKey: 1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 }); // keep 90 days

module.exports = mongoose.model('Notification', notificationSchema);
module.exports.NOTIFICATION_TYPES = NOTIFICATION_TYPES;