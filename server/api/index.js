/**
 * Vercel Functions adapter
 * ========================
 * Vercel never runs `server.listen()`. A function only exists for the
 * duration of a request, so the steps in `server.js` — connect to MongoDB,
 * start the cron scheduler, attach Socket.IO — are exactly the steps a
 * function cannot perform:
 *
 *   • `connectDB()` is never awaited, which is why the deployed API reports
 *     `database: "disconnected"` on /api/ready and every query fails.
 *   • `startScheduler()` never runs, so no monitor is ever checked.
 *   • `initSocket()` never runs, so /socket.io returns 404.
 *
 * This adapter restores only the first of those: it opens a MongoDB
 * connection lazily, per invocation, and caches it on `globalThis` so warm
 * invocations reuse the same pool.
 *
 * WHAT THIS STILL CANNOT DO
 * -------------------------
 * Monitoring (node-cron) and Socket.IO realtime require a long-lived
 * process. No adapter fixes that on a serverless platform. Run the backend
 * on a host with a persistent process for those two features; use this
 * adapter only if you accept losing them.
 *
 * It has no effect on local runs — `npm start` still uses server.js.
 */

const mongoose = require('mongoose');

const app = require('../src/app');
const config = require('../src/config');
const { connectDB } = require('../src/config/db');
const logger = require('../src/config/logger');
const { sanitizeError } = require('../src/utils/sanitizeError');

// Cache the in-flight promise on globalThis. Node reuses the module registry
// between warm invocations, but globalThis also survives the cases where the
// bundle is re-evaluated, so a warm instance still avoids reconnecting.
const CACHE_KEY = Symbol.for('opspulse.dbConnection');
const MAX_POOL_SIZE = 5; // one pool per concurrent instance, not 20

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A cold Vercel instance has no warm connection, and the first attempt
 * regularly races the database cluster's own startup or a briefly dropped
 * idle connection. One short retry converts most of those cold-start
 * failures into an ordinary successful request.
 */
const connectWithRetry = async () => {
  const options = { maxPoolSize: MAX_POOL_SIZE, bufferCommands: false };

  try {
    await connectDB(undefined, options);
  } catch (error) {
    logger.warn('MongoDB connect failed, retrying once', { message: error.message });
    await sleep(1500);
    await connectDB(undefined, options);
  }
};

const ensureDatabase = () => {
  // 1 === connected. Anything else means we must (re)establish a connection.
  if (mongoose.connection.readyState === 1) return Promise.resolve();

  // A cached promise is only valid while the connection it produced is still
  // alive. Atlas idle timeouts and Vercel instance recycling drop the socket
  // without clearing `globalThis`, so a stale resolved promise would be handed
  // back forever and the function would never reconnect.
  globalThis[CACHE_KEY] = connectWithRetry().catch((error) => {
    // Do not cache a failure: the next request should retry.
    globalThis[CACHE_KEY] = null;
    throw error;
  });

  return globalThis[CACHE_KEY];
};

// Vercel calls this for every HTTP request.
module.exports = async (req, res) => {
  try {
    await ensureDatabase();
  } catch (error) {
    // Sanitized: the raw Mongo error can embed the connection string, which
    // would put credentials into the function logs.
    const detail = sanitizeError(error, config.mongoUri);

    logger.error('Database unavailable for this request', {
      ...detail,
      method: req.method,
      url: req.url,
    });

    // The env diagnostics below are booleans and a scheme only — never the
    // connection string itself. Together they separate the two causes that
    // look identical from the outside:
    //   mongoUriSet === false  -> the variable never reached the function
    //   mongoUriSet === true   -> the variable is fine; it is a network/cluster issue
    return res.status(503).json({
      success: false,
      message:
        'Database is not available. Check that MONGO_URI is set on the API and that this ' +
        "deployment's outbound addresses are allowed by the database's network access rules.",
      diagnostic: {
        mongoUriSet: Boolean(process.env.MONGO_URI),
        resolvedScheme: String(config.mongoUri || '').split('://')[0] + '://',
        driverError: { name: detail.name, code: detail.code },
        // Sanitized, so it carries the reason without carrying credentials.
        // The full detail (including the cause chain) is in the function log.
        reason: (detail.cause?.message || detail.message || '').slice(0, 200),
      },
    });
  }

  // The Express app is a plain (req, res, next) function, so it can be
  // invoked directly — the whole existing middleware chain, routes and error
  // handler run unchanged.
  return app(req, res);
};