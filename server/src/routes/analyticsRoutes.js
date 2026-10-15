const express = require('express');
const { query } = require('express-validator');
const router = express.Router();

const auth = require('../middleware/auth');
const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const analytics = require('../services/analyticsService');
const reports = require('../services/reportService');

/**
 * Analytics routes.
 * Every response is computed from real CheckResult documents — no estimates,
 * no sample data. Buckets with no recorded checks come back with null values
 * so the chart shows a gap instead of an invented straight line.
 */

const RANGE_VALUES = ['1h', '24h', '7d', '30d'];

const analyticsQueryValidation = [
  query('teamId').optional().isMongoId().withMessage('Invalid team id'),
  query('range')
    .optional()
    .isIn(RANGE_VALUES)
    .withMessage(`Range must be one of ${RANGE_VALUES.join(', ')}`),
];

// ── GET /api/analytics/dashboard/summary ─────────────────────────────
router.get(
  '/dashboard/summary',
  auth,
  validate(analyticsQueryValidation),
  asyncHandler(async (req, res) => {
    const result = await analytics.getSummary(req.user._id, {
      teamId: req.query.teamId || null,
      range: req.query.range || '24h',
    });

    if (result.error === 'FORBIDDEN') {
      throw new ApiError(403, 'You are not a member of that team.');
    }

    res.json({ success: true, data: result });
  })
);

// ── GET /api/analytics/monitors ──────────────────────────────────────
router.get(
  '/monitors',
  auth,
  validate(analyticsQueryValidation),
  asyncHandler(async (req, res) => {
    const result = await analytics.getMonitorTable(req.user._id, {
      teamId: req.query.teamId || null,
      range: req.query.range || '24h',
    });

    if (result.error === 'FORBIDDEN') {
      throw new ApiError(403, 'You are not a member of that team.');
    }

    res.json({ success: true, data: result });
  })
);

// ── GET /api/analytics/monitors/:monitorId ───────────────────────────
router.get(
  '/monitors/:monitorId',
  auth,
  validate(analyticsQueryValidation),
  asyncHandler(async (req, res) => {
    if (!/^[a-f\d]{24}$/i.test(req.params.monitorId)) {
      throw new ApiError(404, 'Monitor not found.');
    }

    const result = await analytics.getMonitorAnalytics(req.params.monitorId, {
      range: req.query.range || '24h',
    });

    if (result.error === 'NOT_FOUND') {
      throw new ApiError(404, 'Monitor not found.');
    }

    res.json({ success: true, data: result });
  })
);

const reportQueryValidation = [
  query('teamId').optional().isMongoId().withMessage('Invalid team id'),
  query('monitor').optional().isMongoId().withMessage('Invalid monitor id'),
];

// ── GET /api/analytics/reports/daily ────────────────────────────────
router.get(
  '/reports/daily',
  auth,
  validate([
    ...reportQueryValidation,
    query('days')
      .optional()
      .isInt({ min: 1, max: 90 })
      .withMessage('Days must be between 1 and 90')
      .toInt(),
  ]),
  asyncHandler(async (req, res) => {
    const result = await reports.getDailyReport(req.user._id, {
      teamId: req.query.teamId || null,
      days: req.query.days,
      monitorId: req.query.monitor || null,
    });

    if (result.error) throw new ApiError(403, 'You are not a member of that team.');

    res.json({ success: true, data: result });
  })
);

// ── GET /api/analytics/reports/weekly ───────────────────────────────
router.get(
  '/reports/weekly',
  auth,
  validate([
    ...reportQueryValidation,
    query('weeks')
      .optional()
      .isInt({ min: 1, max: 52 })
      .withMessage('Weeks must be between 1 and 52')
      .toInt(),
  ]),
  asyncHandler(async (req, res) => {
    const result = await reports.getWeeklyReport(req.user._id, {
      teamId: req.query.teamId || null,
      weeks: req.query.weeks,
      monitorId: req.query.monitor || null,
    });

    if (result.error) throw new ApiError(403, 'You are not a member of that team.');

    res.json({ success: true, data: result });
  })
);

// ── GET /api/analytics/reports/lifetime/:monitorId ─────────────────
router.get(
  '/reports/lifetime/:monitorId',
  auth,
  asyncHandler(async (req, res) => {
    const result = await reports.getLifetimeReport(req.user._id, req.params.monitorId);

    if (result.error === 'NOT_FOUND') throw new ApiError(404, 'Monitor not found.');

    res.json({ success: true, data: result });
  })
);

module.exports = router;