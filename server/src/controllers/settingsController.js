const User = require('../models/User');
const config = require('../config');
const asyncHandler = require('../utils/asyncHandler');
const emailService = require('../services/emailService');

/**
 * Settings controller — personal preferences for the signed-in user only.
 * Nobody can read or change anybody else's settings.
 */

// ── GET /api/settings ───────────────────────────────────────────────
const getSettings = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);

  res.json({
    success: true,
    data: {
      user: {
        id: String(user._id),
        name: user.name,
        email: user.email,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      },
      preferences: {
        inAppEnabled: user.preferences?.inAppEnabled ?? true,
        emailEnabled: user.preferences?.emailEnabled ?? false,
        emailTypes: user.preferences?.emailTypes ?? [],
      },
      // Honest report of what the server can actually do
      capabilities: {
        smtpConfigured: emailService.isConfigured(),
        smtpHost: config.smtp.host ? config.smtp.host.replace(/:\d+$/, '') : null,
        smtpFrom: config.smtp.from,
        // Never expose credentials
        smtpUser: config.smtp.user ? maskEmail(config.smtp.user) : null,
      },
    },
  });
});

// ── PUT /api/settings/preferences ───────────────────────────────────
const updatePreferences = asyncHandler(async (req, res) => {
  const { inAppEnabled, emailEnabled, emailTypes } = req.body;

  const user = await User.findById(req.user._id);

  if (inAppEnabled !== undefined) user.preferences.inAppEnabled = inAppEnabled;
  if (emailEnabled !== undefined) user.preferences.emailEnabled = emailEnabled;
  if (emailTypes !== undefined) user.preferences.emailTypes = emailTypes;

  await user.save();

  res.json({
    success: true,
    message: 'Preferences saved.',
    data: {
      preferences: {
        inAppEnabled: user.preferences.inAppEnabled,
        emailEnabled: user.preferences.emailEnabled,
        emailTypes: user.preferences.emailTypes,
      },
    },
  });
});

// ── POST /api/settings/test-email ───────────────────────────────────
/**
 * Sends a real test email and reports exactly what happened.
 * If SMTP is not configured it says so instead of pretending.
 */
const testEmail = asyncHandler(async (req, res) => {
  const to = req.body.to || req.user.email;

  if (!emailService.isConfigured()) {
    return res.status(503).json({
      success: false,
      message:
        'SMTP is not configured on this server, so no email was sent. Set SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS in the server environment and restart it.',
      data: { sent: false, reason: 'smtp_not_configured' },
    });
  }

  const result = await emailService.sendAlertEmail({
    to,
    subject: '[OpsPulse] Test email',
    title: 'OpsPulse test email',
    message: `If you are reading this, SMTP is working for ${to}. Alerts will be delivered once you switch email alerts on in your settings.`,
  });

  if (result.status === 'sent') {
    return res.json({
      success: true,
      message: `Test email sent to ${to}.`,
      data: { sent: true, to, sentAt: result.sentAt },
    });
  }

  // Failed delivery is reported as a failure, never as success
  return res.status(502).json({
    success: false,
    message: `Could not send the test email: ${result.error}`,
    data: { sent: false, reason: result.status, error: result.error },
  });
});

// ── DELETE /api/settings/notifications ──────────────────────────────
const clearNotifications = asyncHandler(async (req, res) => {
  const Notification = require('../models/Notification');
  const result = await Notification.deleteMany({ user: req.user._id });

  res.json({
    success: true,
    message: `${result.deletedCount} notification(s) deleted.`,
    data: { deleted: result.deletedCount },
  });
});

/** Show only the first and last characters of an address. */
const maskEmail = (email) => {
  const [local, domain] = String(email).split('@');
  if (!domain) return '***';
  const head = local.slice(0, 1);
  const tail = local.slice(-1);
  return `${head}${'*'.repeat(Math.max(local.length - 2, 1))}${tail}@${domain}`;
};

module.exports = { getSettings, updatePreferences, testEmail, clearNotifications, maskEmail };