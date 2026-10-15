const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');

const config = require('./config');
const errorHandler = require('./middleware/errorHandler');
const { apiLimiter } = require('./middleware/rateLimit');

// ── Import routes ────────────────────────────────────────────────────
const authRoutes = require('./routes/authRoutes');
const teamRoutes = require('./routes/teamRoutes');
const monitorRoutes = require('./routes/monitorRoutes');
const checkRoutes = require('./routes/checkRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const incidentRoutes = require('./routes/incidentRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const settingsRoutes = require('./routes/settingsRoutes');

const app = express();

// Required for correct req.ip (and therefore rate limiting) behind a proxy
app.set('trust proxy', 1);

// ── Security ─────────────────────────────────────────────────────────
app.use(
  helmet({
    // The API serves JSON only; CSP is enforced by the frontend host
    contentSecurityPolicy: false,
  })
);
app.use(
  cors({
    origin(origin, callback) {
      // Allow same-origin/non-browser callers (curl, health checks, Docker)
      if (!origin) return callback(null, true);
      if (config.cors.origins.includes('*') || config.cors.origins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin "${origin}" is not allowed by CORS`));
    },
    credentials: true,
  })
);

// ── Body parsing ─────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cookieParser());

// ── Logging ──────────────────────────────────────────────────────────
if (config.nodeEnv === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

// ── Health / readiness ───────────────────────────────────────────────
// Liveness: is the process itself alive? (no database needed)
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'OpsPulse API is running',
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
    uptime: Math.floor(process.uptime()),
  });
});

// Readiness: can the process actually serve requests? (needs MongoDB)
app.get('/api/ready', (req, res) => {
  const dbState = mongoose.connection.readyState; // 1 === connected
  const ready = dbState === 1;
  const { getSchedulerStatus } = require('./monitoring/scheduler');

  res.status(ready ? 200 : 503).json({
    success: ready,
    message: ready ? 'OpsPulse API is ready' : 'Database connection is not ready',
    database: ['disconnected', 'connected', 'connecting', 'disconnecting'][dbState] || 'unknown',
    uptime: Math.floor(process.uptime()),
    scheduler: getSchedulerStatus(),
  });
});

// ── API routes ───────────────────────────────────────────────────────
// The auth router applies its own per-route limiters: /login and /register
// are strictly limited, while /me (which runs on every page load) gets its own
// generous allowance so a signed-in user can never be locked out.
app.use('/api/auth', authRoutes);
app.use('/api/teams', apiLimiter, teamRoutes);
app.use('/api/monitors', apiLimiter, monitorRoutes);
app.use('/api/checks', apiLimiter, checkRoutes);
app.use('/api/analytics', apiLimiter, analyticsRoutes);
app.use('/api/incidents', apiLimiter, incidentRoutes);
app.use('/api/notifications', apiLimiter, notificationRoutes);
app.use('/api/settings', apiLimiter, settingsRoutes);

// ── 404 catch-all ────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.originalUrl} not found`,
  });
});

// ── Global error handler ─────────────────────────────────────────────
app.use(errorHandler);

module.exports = app;