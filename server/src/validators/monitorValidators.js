const { body, query, param, validationResult } = require('express-validator');
const config = require('../config');
const { MONITOR_METHODS } = require('../models/Monitor');
const ApiError = require('../utils/ApiError');
const { SSRFBlockedError, normalizeUrl } = require('../services/ssrfGuard');

/**
 * Synchronous shape check for a monitor URL.
 * The full SSRF / DNS validation happens in the controller through
 * `parseAndValidateUrl` so that errors are reported with a clear 400 message.
 */
const isWellFormedUrl = (value) => {
  try {
    const parsed = normalizeUrl(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    if (!parsed.hostname) return false;
    return true;
  } catch (error) {
    if (error instanceof SSRFBlockedError) return false;
    return false;
  }
};

/**
 * Validates the URL fully (including DNS + IP checks) and throws an
 * ApiError the error handler can turn into a clean 400 response.
 */
const parseAndValidateUrl = async (rawUrl) => {
  const { validateMonitorUrl } = require('../services/ssrfGuard');
  try {
    return await validateMonitorUrl(rawUrl);
  } catch (error) {
    if (error instanceof SSRFBlockedError) {
      throw new ApiError(400, `This URL cannot be monitored: ${error.message}`);
    }
    throw error;
  }
};

const optionalString = (field, { max = 200, label = field } = {}) =>
  body(field)
    .optional({ values: 'falsy' })
    .isString()
    .withMessage(`${label} must be text`)
    .bail()
    .trim()
    .isLength({ max })
    .withMessage(`${label} cannot exceed ${max} characters`);

const intervalRules = (field = 'intervalSeconds') =>
  body(field)
    .optional({ values: 'falsy' })
    .isInt({ min: config.monitor.minIntervalSeconds, max: config.monitor.maxIntervalSeconds })
    .withMessage(
      `Interval must be between ${config.monitor.minIntervalSeconds} and ${config.monitor.maxIntervalSeconds} seconds`
    )
    .toInt();

const timeoutRules = (field = 'timeoutMs') =>
  body(field)
    .optional({ values: 'falsy' })
    .isInt({ min: config.monitor.minTimeoutMs, max: config.monitor.maxTimeoutMs })
    .withMessage(`Timeout must be between ${config.monitor.minTimeoutMs} and ${config.monitor.maxTimeoutMs} ms`)
    .toInt();

const failureThresholdRules = (field = 'failureThreshold') =>
  body(field)
    .optional({ values: 'falsy' })
    .isInt({ min: 1, max: 20 })
    .withMessage('Failure threshold must be between 1 and 20')
    .toInt();

const recoveryThresholdRules = (field = 'recoveryThreshold') =>
  body(field)
    .optional({ values: 'falsy' })
    .isInt({ min: 1, max: 10 })
    .withMessage('Recovery threshold must be between 1 and 10')
    .toInt();

const createMonitorValidation = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Monitor name is required')
    .isLength({ min: 2, max: 80 })
    .withMessage('Monitor name must be 2–80 characters'),

  body('url')
    .trim()
    .notEmpty()
    .withMessage('URL is required')
    .isLength({ max: 2048 })
    .withMessage('URL is too long')
    .custom(isWellFormedUrl)
    .withMessage('Enter a valid http:// or https:// URL without credentials'),

  body('method')
    .optional()
    .customSanitizer((v) => (typeof v === 'string' ? v.toUpperCase() : v))
    .bail()
    .isIn(MONITOR_METHODS)
    .withMessage(`Method must be one of ${MONITOR_METHODS.join(', ')}`),

  body('team')
    .notEmpty()
    .withMessage('A team must be selected')
    .isMongoId()
    .withMessage('Invalid team id'),

  intervalRules(),
  timeoutRules(),

  body('expectedStatusCodes')
    .optional()
    .isArray({ min: 1, max: 20 })
    .withMessage('Expected status codes must be an array with 1–20 entries')
    .bail()
    .custom((codes) => codes.every((c) => Number.isInteger(Number(c)) && Number(c) >= 100 && Number(c) <= 599))
    .withMessage('Status codes must be numbers between 100 and 599')
    .customSanitizer((codes) => codes.map(Number)),

  optionalString('expectedBodyText', { max: 200, label: 'Expected text' }),

  body('degradedThresholdMs')
    .optional({ values: 'falsy' })
    .isInt({ min: 0, max: config.monitor.maxTimeoutMs * 10 })
    .withMessage('Degraded threshold must be a positive number of milliseconds (0 disables it)')
    .toInt(),

  failureThresholdRules(),
  recoveryThresholdRules(),
];

const updateMonitorValidation = [
  param('monitorId').isMongoId().withMessage('Invalid monitor id'),

  body('name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 80 })
    .withMessage('Monitor name must be 2–80 characters'),

  body('url')
    .optional()
    .trim()
    .isLength({ max: 2048 })
    .withMessage('URL is too long')
    .custom(isWellFormedUrl)
    .withMessage('Enter a valid http:// or https:// URL without credentials'),

  body('method')
    .optional()
    .customSanitizer((v) => (typeof v === 'string' ? v.toUpperCase() : v))
    .bail()
    .isIn(MONITOR_METHODS)
    .withMessage(`Method must be one of ${MONITOR_METHODS.join(', ')}`),

  intervalRules(),
  timeoutRules(),

  body('expectedStatusCodes')
    .optional()
    .isArray({ min: 1, max: 20 })
    .withMessage('Expected status codes must be an array with 1–20 entries')
    .bail()
    .custom((codes) => codes.every((c) => Number.isInteger(Number(c)) && Number(c) >= 100 && Number(c) <= 599))
    .withMessage('Status codes must be numbers between 100 and 599')
    .customSanitizer((codes) => codes.map(Number)),

  optionalString('expectedBodyText', { max: 200, label: 'Expected text' }),

  body('degradedThresholdMs')
    .optional({ values: 'falsy' })
    .isInt({ min: 0, max: config.monitor.maxTimeoutMs * 10 })
    .withMessage('Degraded threshold must be a positive number of milliseconds')
    .toInt(),

  failureThresholdRules(),
  recoveryThresholdRules(),

  // Reject an empty update instead of silently doing nothing
  body().custom((value) => {
    if (Object.keys(value || {}).length === 0) {
      throw new Error('Provide at least one field to update');
    }
    return true;
  }),
];

const listMonitorsValidation = [
  query('status')
    .optional()
    .isIn(['pending', 'up', 'down', 'degraded', 'paused', 'all'])
    .withMessage('Invalid status filter'),
  query('search')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Search text is too long'),
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be 1 or greater').toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100').toInt(),
  query('teamId').optional().isMongoId().withMessage('Invalid team id'),
];

const getChecksValidation = [
  param('monitorId').isMongoId().withMessage('Invalid monitor id'),
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be 1 or greater').toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100').toInt(),
  query('status').optional().isIn(['up', 'down', 'degraded']).withMessage('Invalid status filter'),
];

/** Returns true when express-validator found problems. */
const hasErrors = (req) => !validationResult(req).isEmpty();

module.exports = {
  createMonitorValidation,
  updateMonitorValidation,
  listMonitorsValidation,
  getChecksValidation,
  parseAndValidateUrl,
  isWellFormedUrl,
  hasErrors,
};