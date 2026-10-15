/**
 * Custom API error class.
 * Use this instead of generic Error to include an HTTP status code.
 *
 * Example:
 *   throw new ApiError(404, 'Monitor not found');
 */
class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true; // distinguishes expected errors from bugs
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = ApiError;
