const mongoose = require('mongoose');
const config = require('./index');
const logger = require('./logger');

/**
 * Connect to MongoDB.
 *
 * NOTE: this function throws on failure instead of calling process.exit().
 * A library function should never kill the process — the entry point
 * (server.js) decides what to do. That also makes the function usable
 * from automated tests.
 */
const connectDB = async (uri = config.mongoUri) => {
  mongoose.set('strictQuery', true);

  try {
    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10_000,
      maxPoolSize: 20,
    });

    logger.info('MongoDB connected', {
      host: conn.connection.host,
      port: conn.connection.port,
      database: conn.connection.name,
    });

    return conn;
  } catch (error) {
    logger.error('MongoDB connection failed', { message: error.message });
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