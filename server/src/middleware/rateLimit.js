const rateLimit = require('express-rate-limit');
const config = require('../config');

/**
 * Rate limiters
 * =============
 * Limits are built by a factory rather than at import time so tests can build
 * one with a small budget instead of the production number.
 *
 * skipSuccessfulRequests matters a lot here: only FAILED attempts count.
 * Otherwise a legitimate user who signs in and out all day would eventually be
 * locked out of their own account, and a whole office behind one NAT address
 * would lock each other out.
 */

/**
 * @param {{authMax?:number, apiMax?:number, windowMs?:number}} [overrides]
 */
function createLimiters(overrides = {}) {
  const windowMs = overrides.windowMs ?? config.rateLimit.windowMs;
  const authMax = overrides.authMax ?? config.rateLimit.authMax;
  const apiMax = overrides.apiMax ?? config.rateLimit.apiMax;
  const minutes = Math.round(windowMs / 60000);

  /** Sign-in / registration: the password-guessing entry point. */
  const authLimiter = rateLimit({
    windowMs,
    max: authMax,
    standardHeaders: true,
    legacyHeaders: false,
    // Successful logins do not consume the budget
    skipSuccessfulRequests: true,
    message: {
      success: false,
      message: `Too many failed sign-in attempts. Please wait ${minutes} minutes and try again.`,
    },
  });

  /**
   * Session lookups (/api/auth/me). This runs on every single page load, so it
   * must never be the thing that logs a signed-in user out.
   */
  const sessionLimiter = rateLimit({
    windowMs,
    max: authMax * 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: {
      success: false,
      message: 'Too many session checks. Please try again shortly.',
    },
  });

  /** General API protection. */
  const apiLimiter = rateLimit({
    windowMs,
    max: apiMax,
    standardHeaders: true,
    legacyHeaders: false,
    // Reads should not eat into the budget of writes
    skipSuccessfulRequests: true,
    message: {
      success: false,
      message: 'Too many requests, please slow down.',
    },
  });

  return { authLimiter, sessionLimiter, apiLimiter };
}

// Built once for the real app
const limiters = createLimiters();

module.exports = { createLimiters, ...limiters };