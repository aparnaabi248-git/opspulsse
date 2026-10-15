const Notification = require('../models/Notification');
const TeamMember = require('../models/TeamMember');
const emailService = require('./emailService');
const { emitToUser } = require('../socket');
const logger = require('../config/logger');

/**
 * Alert service
 * =============
 * Turns an event (monitor down, incident opened, …) into in-app notifications.
 *
 * Anti-spam rules
 * ---------------
 *  1. Deduplication key — every alert type has a deterministic key such as
 *     "monitor_down:<monitorId>". A repeat inside the cooldown window is
 *     skipped, so a target that flaps every 5 seconds cannot flood anyone.
 *  2. Cooldown per type — a DOWN alert is re-sent at most every 5 minutes,
 *     a DEGRADED alert every 10 minutes.
 *  3. Notifications are always persisted. If SMTP is off or delivery fails,
 *     the row is still written and the email status says exactly what
 *     happened. Nothing is ever reported as "sent" when it was not.
 */

/** Cooldown windows in milliseconds, per notification type. */
const COOLDOWN_MS = {
  monitor_down: 5 * 60 * 1000,
  monitor_recovered: 60 * 1000,
  monitor_degraded: 10 * 60 * 1000,
  // An outage that keeps failing must not send a fresh alert every check.
  // The incident itself is still updated; only the notification is throttled.
  incident_created: 5 * 60 * 1000,
  incident_acknowledged: 60 * 1000,
  incident_resolved: 0,
  info: 0,
};

const DEFAULT_COOLDOWN = 5 * 60 * 1000;

/**
 * Notify every member of a team (plus optionally one extra user).
 *
 * @param {object} params
 * @param {string} params.type              notification type
 * @param {string} params.dedupeKey         deterministic dedupe key
 * @param {string} params.title
 * @param {string} params.message
 * @param {string} [params.severity]
 * @param {string} params.team              team ObjectId
 * @param {string} [params.monitor]
 * @param {string} [params.incident]
 * @param {number} [params.cooldownMs]
 * @param {string[]} [params.onlyUsers]     restrict to these user ids
 * @returns {Promise<{created:number, suppressed:number, deliveries:{sent:number, failed:number, skipped:number}>}>}
 */
async function notifyTeam({
  type,
  dedupeKey,
  title,
  message,
  severity = 'info',
  team,
  monitor = null,
  incident = null,
  cooldownMs,
  onlyUsers = null,
}) {
  const cooldown = cooldownMs ?? COOLDOWN_MS[type] ?? DEFAULT_COOLDOWN;

  let userIds;
  if (onlyUsers?.length) {
    userIds = onlyUsers.map(String);
  } else {
    const memberships = await TeamMember.find({ team }).select('user');
    userIds = memberships.map((m) => String(m.user));
  }

  if (userIds.length === 0) {
    return { created: 0, suppressed: 0, deliveries: { sent: 0, failed: 0, skipped: 0 } };
  }

  // ── Dedupe check: one query for the whole team ────────────────────
  const recent = await Notification.find({
    user: { $in: userIds },
    dedupeKey,
  }).select('user createdAt');

  const lastSentByUser = new Map();
  for (const row of recent) {
    const key = String(row.user);
    const time = new Date(row.createdAt).getTime();
    if (!lastSentByUser.has(key) || time > lastSentByUser.get(key)) {
      lastSentByUser.set(key, time);
    }
  }

  const now = Date.now();
  const toNotify = [];
  let suppressed = 0;

  for (const userId of userIds) {
    const last = lastSentByUser.get(userId);
    if (cooldown > 0 && last && now - last < cooldown) {
      suppressed += 1;
      continue;
    }
    toNotify.push(userId);
  }

  if (toNotify.length === 0) {
    return { created: 0, suppressed, deliveries: { sent: 0, failed: 0, skipped: 0 } };
  }

  // ── Persist + deliver ────────────────────────────────────────────
  const recipients = await TeamMember.find({ user: { $in: toNotify } })
    .select('user')
    .populate('user', 'email name preferences');

  // Keep the order stable (the user list order) and drop users with no team row
  const byId = new Map(recipients.map((r) => [String(r.user._id), r.user]));

  const created = [];
  const deliveries = { sent: 0, failed: 0, skipped: 0 };
  let skippedByPreference = 0;

  for (const userId of toNotify) {
    const user = byId.get(userId);

    // A user can switch off in-app alerts entirely
    if (user?.preferences && user.preferences.inAppEnabled === false) {
      skippedByPreference += 1;
      continue;
    }

    const notification = await Notification.create({
      user: userId,
      team,
      monitor,
      incident,
      type,
      severity,
      title,
      message,
      dedupeKey,
      email: { status: 'not_attempted' },
    });
    created.push(notification);

    // ── Optional email ─────────────────────────────────────────────
    // Email is opt-in per user AND per alert type. Anything else is recorded
    // as a skip, never as a successful send.
    const wantsEmail = typeof user?.wantsEmailFor === 'function' && user.wantsEmailFor(type);

    const delivery = wantsEmail
      ? await emailService.sendAlertEmail({
          to: user?.email,
          subject: `[OpsPulse ${severity.toUpperCase()}] ${title}`,
          title,
          message,
        })
      : {
          status: 'skipped_not_configured',
          error: emailService.isConfigured()
            ? 'Email alerts are disabled for this type by the recipient'
            : 'SMTP is not configured',
        };

    notification.email = {
      status: delivery.status,
      error: delivery.error ?? null,
      sentAt: delivery.sentAt ?? null,
    };
    await notification.save();

    if (delivery.status === 'sent') deliveries.sent += 1;
    else if (delivery.status === 'failed') deliveries.failed += 1;
    else deliveries.skipped += 1;

    // ── Real-time push to this user's private room ──────────────────
    emitToUser(userId, 'notification:new', {
      id: String(notification._id),
      type,
      severity,
      title,
      message,
      monitor: monitor ? String(monitor) : null,
      incident: incident ? String(incident) : null,
      read: false,
      createdAt: notification.createdAt,
    });
  }

  logger.info('Alert dispatched', {
    type,
    dedupeKey,
    created: created.length,
    suppressed,
    skippedByPreference,
    emailSent: deliveries.sent,
    emailSkipped: deliveries.skipped,
    emailFailed: deliveries.failed,
  });

  return {
    created: created.length,
    suppressed,
    skippedByPreference,
    deliveries,
  };
}

/** Unread count badge for one user. */
async function getUnreadCount(userId) {
  return Notification.countDocuments({ user: userId, read: false });
}

module.exports = { notifyTeam, getUnreadCount, COOLDOWN_MS };