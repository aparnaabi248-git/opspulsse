const { body } = require('express-validator');
const { NOTIFICATION_TYPES } = require('../models/User');

/**
 * Settings validation.
 * Preferences decide whether OpsPulse may email somebody, so the input is
 * checked strictly rather than trusted.
 */

const updatePreferencesValidation = [
  body('inAppEnabled')
    .optional()
    .isBoolean()
    .withMessage('inAppEnabled must be true or false')
    .toBoolean(),

  body('emailEnabled')
    .optional()
    .isBoolean()
    .withMessage('emailEnabled must be true or false')
    .toBoolean(),

  body('emailTypes')
    .optional()
    .isArray({ min: 1, max: NOTIFICATION_TYPES.length })
    .withMessage(`emailTypes must be an array of 1–${NOTIFICATION_TYPES.length} alert types`)
    .bail()
    .custom((types) => types.every((t) => NOTIFICATION_TYPES.includes(t)))
    .withMessage(`emailTypes may only contain: ${NOTIFICATION_TYPES.join(', ')}`)
    .customSanitizer((types) => [...new Set(types)]),
];

const testEmailValidation = [
  body('to')
    .optional()
    .trim()
    .isEmail()
    .withMessage('Enter a valid email address')
    .normalizeEmail(),
];

module.exports = { updatePreferencesValidation, testEmailValidation, NOTIFICATION_TYPES };