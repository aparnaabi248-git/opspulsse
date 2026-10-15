const { query } = require('express-validator');
const mongoose = require('mongoose');

const TeamMember = require('../models/TeamMember');
const CheckResult = require('../models/CheckResult');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

/**
 * Check history controller (cross-monitor views).
 * Single-monitor history lives in monitorController.getCheckHistory.
 */

const recentChecksValidation = [
  query('teamId').optional().isMongoId().withMessage('Invalid team id'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100')
    .toInt(),
  query('status').optional().isIn(['up', 'down', 'degraded']).withMessage('Invalid status filter'),
];

/**
 * GET /api/checks/recent
 * Latest checks across all monitors the caller is a member of.
 */
const getRecentChecks = asyncHandler(async (req, res) => {
  const { teamId, status } = req.query;
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : 30;

  const memberships = await TeamMember.find({ user: req.user._id }).select('team');
  let teamIds = memberships.map((m) => String(m.team));

  if (teamIds.length === 0) {
    return res.json({ success: true, data: { activity: [] } });
  }

  if (teamId) {
    if (!teamIds.includes(teamId)) {
      throw new ApiError(403, 'You are not a member of that team.');
    }
    teamIds = [teamId];
  }

  const filter = { team: { $in: teamIds.map((id) => new mongoose.Types.ObjectId(id)) } };
  if (status) filter.status = status;

  // $lookup brings the monitor name without a second round trip
  const activity = await CheckResult.aggregate([
    { $match: filter },
    { $sort: { checkedAt: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: 'monitors',
        localField: 'monitor',
        foreignField: '_id',
        as: 'monitorRef',
      },
    },
    {
      $project: {
        _id: 1,
        monitor: 1,
        status: 1,
        outcome: 1,
        statusCode: 1,
        responseTimeMs: 1,
        errorMessage: 1,
        source: 1,
        checkedAt: 1,
        monitorName: { $arrayElemAt: ['$monitorRef.name', 0] },
        monitorUrl: { $arrayElemAt: ['$monitorRef.url', 0] },
      },
    },
  ]);

  res.json({ success: true, data: { activity } });
});

module.exports = { getRecentChecks, recentChecksValidation };