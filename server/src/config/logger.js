const config = require('./index');

/**
 * Tiny dependency-free structured logger.
 *
 * Production -> one JSON object per line (easy to ship to ELK / Loki / CloudWatch)
 * Development -> human readable, colour free text
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LEVELS[config.logLevel] ?? LEVELS.info;

const emit = (level, message, meta) => {
  if (LEVELS[level] > currentLevel) return;

  if (config.isProd) {
     
    console.log(
      JSON.stringify({
        level,
        time: new Date().toISOString(),
        message,
        ...(meta || {}),
      })
    );
    return;
  }

  const stamp = new Date().toISOString().slice(11, 23);
  const extras = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
   
  console[level === 'debug' ? 'log' : level](`${stamp} ${level.toUpperCase().padEnd(5)} ${message}${extras}`);
};

module.exports = {
  info: (message, meta) => emit('info', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  error: (message, meta) => emit('error', message, meta),
  debug: (message, meta) => emit('debug', message, meta),
};