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
const { connectDB } = require('../src/config/db');
const logger = require('../src/config/logger');

// Cache the in-flight promise on globalThis. Node reuses the module registry
// between warm invocations, but globalThis also survives the cases where the
// bundle is re-evaluated, so a warm instance still avoids reconnecting.
const CACHE_KEY = Symbol.for('opspulse.dbConnection');
const MAX_POOL_SIZE = 5; // one pool per concurrent instance, not 20

const ensureDatabase = () => {
  if (mongoose.connection.readyState === 1) return Promise.resolve();

  if (!globalThis[CACHE_KEY]) {
    globalThis[CACHE_KEY] = connectDB(undefined, {
      maxPoolSize: MAX_POOL_SIZE,
      // Fail fast instead of queueing queries for 10s when the database is
      // unreachable — a cold start should answer clearly, not hang.
      bufferCommands: false,
    }).catch((error) => {
      // Do not cache a failure: the next request should retry.
      globalThis[CACHE_KEY] = null;
      throw error;
    });
  }

  return globalThis[CACHE_KEY];
};

// Vercel calls this for every HTTP request.
module.exports = async (req, res) => {
  try {
    await ensureDatabase();
  } catch (error) {
    logger.error('Database unavailable for this request', { message: error.message });
    return res.status(503).json({
      success: false,
      message: 'Database is not available. Please try again shortly.',
    });
  }

  // The Express app is a plain (req, res, next) function, so it can be
  // invoked directly — the whole existing middleware chain, routes and error
  // handler run unchanged.
  return app(req, res);
};