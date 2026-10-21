const mongoose = require('mongoose');
const config = require('./index');
const logger = require('./logger');
const { sanitizeError } = require('../utils/sanitizeError');
const { normalizeMongoUri } = require('../utils/normalizeMongoUri');

/**
 * Connect to MongoDB.
 *
 * `options.maxPoolSize` / `options.bufferCommands` exist because a serverless
 * function creates one pool per concurrent instance. Leaving the default of 20
 * would multiply into far more connections than a small cluster allows, and
 * buffering commands while the database is unreachable makes a cold start look
 * like a hanging request instead of a fast, clear error.
 *
 * NOTE: this function throws on failure instead of calling process.exit().
 * A library function should never kill the process — the entry point
 * (server.js) decides what to do. That also makes the function usable
 * from automated tests.
 */
const connectDB = async (uri = config.mongoUri, options = {}) => {
  mongoose.set('strictQuery', true);

  try {
    // Normalise before connecting. A value pasted into a dashboard env var
    // often arrives with surrounding quotes, stray whitespace, or a password
    // that was not percent-encoded — all of which make Atlas reject the
    // credentials with `bad auth` even though the string looks right.
    const conn = await mongoose.connect(normalizeMongoUri(uri), {
      serverSelectionTimeoutMS: 10_000,
      maxPoolSize: options.maxPoolSize || 20,
      bufferCommands: options.bufferCommands !== false,
    });

    logger.info('MongoDB connected', {
      host: conn.connection.host,
      port: conn.connection.port,
      database: conn.connection.name,
    });

    return conn;
  } catch (error) {
    // Sanitized: the driver's raw message can embed the connection string,
    // which would put the database credentials into the logs.
    logger.error('MongoDB connection failed', sanitizeError(error, config.mongoUri));
    throw error;
  }
};

const disconnectDB = async () => {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.connection.close(false);
  logger.info('MongoDB connection closed');
};

module.exports = connectDB;
module.exports.connectDB = connectDB;
module.exports.disconnectDB = disconnectDB;