const dotenv = require('dotenv');
const path = require('path');

// Load .env from the server root (server/.env)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * Parse an integer env var with a fallback.
 */
const toInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const nodeEnv = process.env.NODE_ENV || 'development';
const isProd = nodeEnv === 'production';

// ── JWT secret handling ──────────────────────────────────────────────
// A weak or missing secret must never silently work in production,
// otherwise anyone could forge login tokens.
const WEAK_SECRETS = new Set([
  '',
  'change-this-to-a-strong-random-secret',
  'dev-fallback-secret-change-me',
]);

let jwtSecret = process.env.JWT_SECRET;
if (WEAK_SECRETS.has(jwtSecret)) {
  if (isProd) {
    throw new Error(
      'FATAL: JWT_SECRET is missing or set to a placeholder value while NODE_ENV=production. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
  }
  jwtSecret = 'dev-fallback-secret-change-me';
}

// A secret that still contains "change" was clearly never meant for production
if (isProd && (jwtSecret.length < 32 || /change/i.test(jwtSecret))) {
  throw new Error(
    'FATAL: JWT_SECRET looks like a development placeholder. Use at least 32 random characters. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
  );
}

// ── CORS ─────────────────────────────────────────────────────────────
// Accepts a comma separated list so Docker/proxy setups can use several
// origins: CORS_ORIGIN=http://localhost:5173,https://app.example.com
const corsOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const config = {
  port: toInt(process.env.PORT, 5000),
  nodeEnv,
  isProd,
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/opspulse',

  jwt: {
    secret: jwtSecret,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  cors: {
    origins: corsOrigins,
    // Kept for backwards compatibility with the original single-value shape
    origin: corsOrigins[0],
  },

  // ── Health checking defaults ───────────────────────────────────────
  monitor: {
    // Never allow a faster interval than this, it would hammer targets
    minIntervalSeconds: toInt(process.env.MONITOR_MIN_INTERVAL_SECONDS, 30),
    maxIntervalSeconds: toInt(process.env.MONITOR_MAX_INTERVAL_SECONDS, 86400),
    defaultIntervalSeconds: toInt(process.env.MONITOR_DEFAULT_INTERVAL_SECONDS, 300),
    minTimeoutMs: toInt(process.env.MONITOR_MIN_TIMEOUT_MS, 1000),
    maxTimeoutMs: toInt(process.env.MONITOR_MAX_TIMEOUT_MS, 30000),
    defaultTimeoutMs: toInt(process.env.MONITOR_DEFAULT_TIMEOUT_MS, 10000),
    defaultDegradedThresholdMs: toInt(process.env.MONITOR_DEGRADED_MS, 3000),
    maxRedirects: toInt(process.env.MONITOR_MAX_REDIRECTS, 3),
    maxResponseBodyBytes: toInt(process.env.MONITOR_MAX_BODY_BYTES, 32 * 1024),
    userAgent: process.env.MONITOR_USER_AGENT || 'OpsPulse-Monitor/1.0 (+https://github.com/opspulse)',
  },

  // ── Security / SSRF ────────────────────────────────────────────────
  security: {
    // DANGEROUS: when true the SSRF guard allows private/loopback targets.
    // Off by default. Only enable it when you intentionally want to monitor
    // services inside your own private network.
    allowPrivateTargets:
      String(process.env.ALLOW_PRIVATE_TARGETS || 'false').toLowerCase() === 'true',
  },

  // ── Rate limiting ──────────────────────────────────────────────────
  rateLimit: {
    windowMs: toInt(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    authMax: toInt(process.env.RATE_LIMIT_AUTH_MAX, 20),
    apiMax: toInt(process.env.RATE_LIMIT_API_MAX, 300),
  },

  // ── Data retention ─────────────────────────────────────────────────
  retention: {
    // 0 = keep check results forever
    checkResultsDays: toInt(process.env.CHECK_RETENTION_DAYS, 0),
  },

  // ── Scheduler (Phase 3) ────────────────────────────────────────────
  scheduler: {
    enabled: String(process.env.SCHEDULER_ENABLED || 'true').toLowerCase() === 'true',
    tickSeconds: toInt(process.env.SCHEDULER_TICK_SECONDS, 30),
    maxConcurrentChecks: toInt(process.env.SCHEDULER_MAX_CONCURRENCY, 10),
  },

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: toInt(process.env.SMTP_PORT, 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'OpsPulse <noreply@opspulse.dev>',
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    // When false the email service reports "skipped" instead of faking success
    enabled: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
  },

  logLevel: process.env.LOG_LEVEL || (nodeEnv === 'production' ? 'info' : 'debug'),
};

module.exports = config;