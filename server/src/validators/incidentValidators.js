const { body, query } = require('express-validator');
const { INCIDENT_SEVERITIES } = require('../models/Incident');

const createIncidentValidation = [
  body('note')
    .optional()
    .trim()
    .isLength({ min: 2, max: 1000 })
    .withMessage('Note must be between 2 and 1000 characters'),
];

const resolveIncidentValidation = [
  body('notes')
    .optional()
    .trim()
    .isLength({ max: 2000 })
    .withMessage('Resolution notes cannot exceed 2000 characters'),
];

const listIncidentsValidation = [
  query('status')
    .optional()
    .isIn(['open', 'acknowledged', 'resolved', 'active', 'all'])
    .withMessage('Invalid status filter'),
  query('severity')
    .optional()
    .isIn([...INCIDENT_SEVERITIES, 'all'])
    .withMessage('Invalid severity filter'),
  query('monitor').optional().isMongoId().withMessage('Invalid monitor id'),
  query('teamId').optional().isMongoId().withMessage('Invalid team id'),
  query('search').optional().trim().isLength({ max: 100 }).withMessage('Search text is too long'),
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be 1 or greater').toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100').toInt(),
];

const listNotificationsValidation = [
  query('unread')
    .optional()
    .isIn(['true', 'false'])
    .withMessage('Unread filter must be true or false'),
  query('type').optional().isLength({ max: 40 }).withMessage('Invalid notification type'),
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be 1 or greater').toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100').toInt(),
];

module.exports = {
  createIncidentValidation,
  resolveIncidentValidation,
  listIncidentsValidation,
  listNotificationsValidation,
};