/**
 * Wraps an async route handler so rejected promises are forwarded to the
 * Express error handler instead of crashing the process.
 *
 * Usage:
 *   router.get('/', asyncHandler(controller.list));
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;