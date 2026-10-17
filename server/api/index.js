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
  if (mongoose.connection.readyState === 1) return Promise.resolve();

  if (!globalThis[CACHE_KEY]) {
    globalThis[CACHE_KEY] = connectWithRetry().catch((error) => {
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
    // The cause is never echoed back, because `error.message` from the Mongo
    // driver embeds the host name and part of the credentials. The exact
    // message is in the function logs; the response only names the two things
    // that are actually configurable.
    logger.error('Database unavailable for this request', {
      message: error.message,
      method: req.method,
      url: req.url,
    });
    return res.status(503).json({
      success: false,
      message:
        'Database is not available. Check that MONGO_URI is set on the API and that this ' +
        "deployment's outbound addresses are allowed by the database's network access rules.",
    });
  }

  // The Express app is a plain (req, res, next) function, so it can be
  // invoked directly — the whole existing middleware chain, routes and error
  // handler run unchanged.
  return app(req, res);
};