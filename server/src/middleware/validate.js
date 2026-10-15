const { validationResult } = require('express-validator');

/**
 * Middleware factory: runs an array of express-validator checks and
 * returns 400 with structured errors if any fail.
 *
 * Usage:
 *   router.post('/register', validate(registerRules), controller.register);
 */
const validate = (validations) => {
  return async (req, res, next) => {
    // Run every validation rule
    await Promise.all(validations.map((v) => v.run(req)));

    const errors = validationResult(req);
    if (errors.isEmpty()) return next();

    const extracted = errors.array().map((err) => ({
      field: err.path,
      message: err.msg,
    }));

    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: extracted,
    });
  };
};

module.exports = validate;
