const config = require('../config');
const logger = require('../config/logger');

/**
 * Centralized Express error handler.
 * Converts every error into one predictable JSON shape:
 *   { success: false, message: string, errors?: [{field, message}] }
 */
const errorHandler = (err, req, res, _next) => {
  let statusCode = err.statusCode || err.status || 500;
  let message = err.message || 'Internal Server Error';
  let errors = err.errors;

  // ── Malformed JSON body ──────────────────────────────────────
  if (err instanceof SyntaxError && 'body' in err) {
    statusCode = 400;
    message = 'Request body is not valid JSON.';
  }

  // ── Mongoose validation error ────────────────────────────────
  if (err.name === 'ValidationError' && err.errors) {
    statusCode = 400;
    errors = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
    message = errors.map((e) => e.message).join('. ');
  }

  // ── Mongoose duplicate key ───────────────────────────────────
  if (err.code === 11000) {
    statusCode = 409;
    if (err.keyPattern && 'monitor' in err.keyPattern && 'active' in err.keyPattern) {
      message = 'This monitor already has an active incident.';
    } else {
      const field = Object.keys(err.keyValue || {})[0] || 'field';
      message = `A record with that ${field} already exists.`;
    }
  }

  // ── Mongoose bad ObjectId / bad cast ─────────────────────────
  if (err.name === 'CastError') {
    statusCode = 400;
    message = `Invalid value for "${err.path}".`;
  }

  // ── SSRF block surfaced from a service ───────────────────────
  if (err.code === 'SSRF_BLOCKED') {
    statusCode = 400;
  }

  // Anything unexpected is a bug on our side — log it with the stack,
  // but never leak internals to the client in production.
  if (statusCode >= 500) {
    logger.error(`[${statusCode}] ${req.method} ${req.originalUrl}`, {
      message: err.message,
      stack: err.stack,
    });
  } else {
    logger.warn(`[${statusCode}] ${req.method} ${req.originalUrl} — ${message}`);
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(errors ? { errors } : {}),
    ...(config.nodeEnv === 'development' && statusCode >= 500 && { stack: err.stack }),
  });
};

module.exports = errorHandler;