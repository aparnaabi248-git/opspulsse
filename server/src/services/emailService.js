const nodemailer = require('nodemailer');
const config = require('../config');
const logger = require('../config/logger');

/**
 * Email service
 * =============
 * Email is OPTIONAL. When SMTP is not configured, in-app notifications still
 * work and this service reports `skipped` — it never pretends an email was
 * sent. Every result carries an explicit status so the caller can record the
 * truth on the notification row.
 */

let transporter = null;

const isConfigured = () =>
  Boolean(config.smtp.host && config.smtp.user && config.smtp.pass);

const getTransporter = () => {
  if (!isConfigured()) return null;
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
    // Do not hang the alert pipeline if the SMTP server is unreachable
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });

  return transporter;
};

/** Human readable alert email body. */
const buildMessage = ({ title, message, url }) => `
<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0f1a;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#151d2e;border:1px solid #233046;border-radius:14px;padding:24px;color:#e8edf7">
    <p style="margin:0 0 4px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#818cf8">OpsPulse alert</p>
    <h1 style="margin:0 0 12px;font-size:20px">${title}</h1>
    <p style="margin:0 0 16px;color:#94a3b8;line-height:1.6">${message}</p>
    ${
      url
        ? `<p style="margin:0"><a href="${url}" style="color:#818cf8">Open in OpsPulse →</a></p>`
        : ''
    }
    <p style="margin:24px 0 0;font-size:12px;color:#64748b">
      You are receiving this because you are a member of this OpsPulse workspace.
    </p>
  </div>
</body></html>`;

/**
 * Send one alert email.
 *
 * @param {{to: string, subject: string, title: string, message: string, url?: string}} params
 * @returns {Promise<{status:'sent'|'skipped'|'failed', error?:string, sentAt?:Date}>}
 */
const sendAlertEmail = async ({ to, subject, title, message, url }) => {
  if (!isConfigured()) {
    return { status: 'skipped_not_configured', error: 'SMTP is not configured' };
  }

  if (!to) {
    return { status: 'no_recipient', error: 'No email address on this account' };
  }

  try {
    const info = await getTransporter().sendMail({
      from: config.smtp.from,
      to,
      subject,
      html: buildMessage({ title, message, url }),
      text: `${title}\n\n${message}${url ? `\n\n${url}` : ''}`,
    });

    logger.info('Alert email sent', { to, subject, id: info.messageId });
    return { status: 'sent', sentAt: new Date() };
  } catch (error) {
    // Never claim success: the failure is recorded on the notification row
    logger.error('Alert email failed', { to, subject, message: error.message });
    return { status: 'failed', error: error.message };
  }
};

const verifySmtp = async () => {
  if (!isConfigured()) return { configured: false, ok: false, error: 'SMTP is not configured' };
  try {
    await getTransporter().verify();
    return { configured: true, ok: true };
  } catch (error) {
    return { configured: true, ok: false, error: error.message };
  }
};

module.exports = { sendAlertEmail, isConfigured, verifySmtp };