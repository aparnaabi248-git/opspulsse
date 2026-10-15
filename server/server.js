const http = require('http');
const app = require('./src/app');
const { connectDB, disconnectDB } = require('./src/config/db');
const { startScheduler, stopScheduler } = require('./src/monitoring/scheduler');
const { initSocket, closeSocket } = require('./src/socket');
const config = require('./src/config');
const logger = require('./src/config/logger');

// Socket.IO attaches to this HTTP server
const server = http.createServer(app);

// ── Graceful shutdown ────────────────────────────────────────────────
let shuttingDown = false;

const gracefulShutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`${signal} received — starting graceful shutdown`);

  // Hard stop if anything hangs
  const forceTimer = setTimeout(() => {
    logger.error('Forced shutdown after 10 s timeout');
    process.exit(1);
  }, 10_000);
  forceTimer.unref();

  try {
    await new Promise((resolve) => server.close(resolve));
    logger.info('HTTP server closed');

    // Stop the monitoring jobs BEFORE closing the database, otherwise an
    // in-flight check would fail while writing its result.
    await stopScheduler();

    // Let connected clients finish before the HTTP server closes
    await closeSocket();

    await disconnectDB();
  } catch (error) {
    logger.error('Error during shutdown', { message: error.message });
  }

  clearTimeout(forceTimer);
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
  // Do not exit on a single rejection — log it and keep serving.
  // A truly broken state will fail the readiness probe instead.
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception — shutting down', { message: error.message });
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

// ── Start ────────────────────────────────────────────────────────────
const startServer = async () => {
  // MongoDB may still be starting (compose, CI, a cold cluster). Retry a few
  // times before giving up, so we fail for a real reason and not a race.
  const attempts = 5;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await connectDB();
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        logger.warn(`Database not ready (attempt ${attempt}/${attempts}), retrying in 3s…`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  if (lastError) {
    logger.error('Server failed to start: could not reach MongoDB', { message: lastError.message });
    process.exit(1);
  }

  try {
    // Monitoring starts only after MongoDB is reachable
    await startScheduler();

    // Real-time updates for signed-in users
    initSocket(server);

    server.listen(config.port, () => {
      logger.info('OpsPulse API server started', {
        environment: config.nodeEnv,
        port: config.port,
        health: `http://localhost:${config.port}/api/health`,
        ready: `http://localhost:${config.port}/api/ready`,
      });
    });
  } catch (error) {
    logger.error('Server failed to start', { message: error.message });
    process.exit(1);
  }
};

startServer();

module.exports = { app, server };