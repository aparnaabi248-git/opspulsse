const jwt = require('jsonwebtoken');
const config = require('../config');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');

/**
 * Authentication middleware.
 * Extracts JWT from the Authorization header (Bearer <token>) or from
 * an httpOnly cookie named "token". Attaches the user to req.user.
 */
const auth = async (req, res, next) => {
  try {
    let token;

    // 1) Check Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }
    // 2) Fallback to cookie
    else if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }

    if (!token) {
      throw new ApiError(401, 'Authentication required. Please log in.');
    }

    // Verify token
    const decoded = jwt.verify(token, config.jwt.secret);

    // Fetch user (password excluded by default via select: false)
    const user = await User.findById(decoded.id);
    if (!user) {
      throw new ApiError(401, 'The user belonging to this token no longer exists.');
    }

    req.user = user;
    next();
  } catch (error) {
    if (error instanceof ApiError) return next(error);
    if (error.name === 'JsonWebTokenError') {
      return next(new ApiError(401, 'Invalid authentication token.'));
    }
    if (error.name === 'TokenExpiredError') {
      return next(new ApiError(401, 'Your session has expired. Please log in again.'));
    }
    next(error);
  }
};

module.exports = auth;
