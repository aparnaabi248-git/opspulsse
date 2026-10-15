const { body } = require('express-validator');

const createTeamValidation = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Team name is required')
    .isLength({ min: 2, max: 100 })
    .withMessage('Team name must be 2–100 characters'),
  body('description')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Description cannot exceed 500 characters'),
];

const updateTeamValidation = [
  body('name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Team name must be 2–100 characters'),
  body('description')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Description cannot exceed 500 characters'),
];

const addMemberValidation = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Please provide a valid email'),
  body('role')
    .optional()
    .isIn(['admin', 'viewer'])
    .withMessage('Role must be admin or viewer'),
];

const updateMemberRoleValidation = [
  body('role')
    .notEmpty()
    .withMessage('Role is required')
    .isIn(['admin', 'viewer'])
    .withMessage('Role must be admin or viewer'),
];

const transferOwnershipValidation = [
  body('teamId')
    .notEmpty()
    .withMessage('Team id is required')
    .isMongoId()
    .withMessage('Invalid team id'),
  body('newOwnerId')
    .notEmpty()
    .withMessage('Choose who should become the owner')
    .isMongoId()
    .withMessage('Invalid user id'),
];

module.exports = {
  createTeamValidation,
  updateTeamValidation,
  addMemberValidation,
  updateMemberRoleValidation,
  transferOwnershipValidation,
};
