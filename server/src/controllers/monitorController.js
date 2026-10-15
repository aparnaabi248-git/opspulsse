const Monitor = require('../models/Monitor');
const CheckResult = require('../models/CheckResult');
const TeamMember = require('../models/TeamMember');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { getPagination, buildPaginationMeta } = require('../utils/pagination');
const { parseAndValidateUrl } = require('../validators/monitorValidators');
const { executeCheck, scheduleNextCheck } = require('../services/monitorService');

/**
 * Monitor controller
 * ==================
 * Every action is scoped to the teams the caller is a member of. req.monitor
 * and req.teamMembership are populated by the loadMonitor middleware.
 */

// Escape user input before putting it inside a RegExp
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const EDITABLE_FIELDS = [
  'name',
  'method',
  'intervalSeconds',
  'timeoutMs',
  'expectedStatusCodes',
  'expectedBodyText',
  'degradedThresholdMs',
  'failureThreshold',
  'recoveryThreshold',
];

// ── GET /api/monitors ────────────────────────────────────────────────
const listMonitors = asyncHandler(async (req, res) => {
  const { status, search, teamId } = req.query;
  const { page, limit, skip } = getPagination(req.query);

  // Only teams the user actually belongs to
  const memberships = await TeamMember.find({ user: req.user._id }).select('team');
  let teamIds = memberships.map((m) => String(m.team));

  if (teamIds.length === 0) {
    return res.json({
      success: true,
      message: 'You are not a member of any team yet.',
      data: { monitors: [], pagination: buildPaginationMeta({ page, limit, total: 0 }) },
    });
  }

  if (teamId) {
    if (!teamIds.includes(teamId)) {
      throw new ApiError(403, 'You are not a member of that team.');
    }
    teamIds = [teamId];
  }

  const filter = { team: { $in: teamIds } };

  if (status && status !== 'all') {
    if (status === 'paused') filter.isPaused = true;
    filter.status = status;
  }

  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: rx }, { url: rx }];
  }

  const [monitors, total] = await Promise.all([
    Monitor.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Monitor.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: {
      monitors: monitors.map((m) => m.toPublicJSON()),
      pagination: buildPaginationMeta({ page, limit, total }),
    },
  });
});

// ── GET /api/monitors/:monitorId ─────────────────────────────────────
const getMonitor = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: {
      monitor: req.monitor.toPublicJSON(),
      myRole: req.teamMembership.role,
    },
  });
});

// ── POST /api/monitors ───────────────────────────────────────────────
const createMonitor = asyncHandler(async (req, res) => {
  const {
    name,
    url,
    method,
    team,
    intervalSeconds,
    timeoutMs,
    expectedStatusCodes,
    expectedBodyText,
    degradedThresholdMs,
    failureThreshold,
  } = req.body;

  // Full SSRF validation happens here (DNS + IP range checks)
  const safeUrl = await parseAndValidateUrl(url);

  const monitor = await Monitor.create({
    name,
    url: safeUrl,
    method: method || 'GET',
    team,
    createdBy: req.user._id,
    intervalSeconds: intervalSeconds || undefined,
    timeoutMs: timeoutMs || undefined,
    expectedStatusCodes: expectedStatusCodes?.length ? expectedStatusCodes : undefined,
    expectedBodyText: expectedBodyText || '',
    degradedThresholdMs: degradedThresholdMs === undefined ? undefined : degradedThresholdMs,
    failureThreshold: failureThreshold || undefined,
    status: 'pending',
    nextCheckAt: new Date(),
  });

  res.status(201).json({
    success: true,
    message: `Monitor "${monitor.name}" created.`,
    data: { monitor: monitor.toPublicJSON() },
  });
});

// ── PUT /api/monitors/:monitorId ─────────────────────────────────────
const updateMonitor = asyncHandler(async (req, res) => {
  const monitor = req.monitor;

  for (const field of EDITABLE_FIELDS) {
    if (req.body[field] !== undefined) monitor[field] = req.body[field];
  }

  if (req.body.url !== undefined) {
    monitor.url = await parseAndValidateUrl(req.body.url);
  }

  // Changing the interval invalidates the old schedule
  if (req.body.intervalSeconds !== undefined) {
    scheduleNextCheck(monitor);
  }

  await monitor.save();

  res.json({
    success: true,
    message: 'Monitor updated.',
    data: { monitor: monitor.toPublicJSON() },
  });
});

// ── POST /api/monitors/:monitorId/pause ──────────────────────────────
const pauseMonitor = asyncHandler(async (req, res) => {
  const monitor = req.monitor;

  if (monitor.isPaused) {
    throw new ApiError(409, 'This monitor is already paused.');
  }

  monitor.statusBeforePause = monitor.status;
  monitor.isPaused = true;
  monitor.pausedAt = new Date();
  monitor.status = 'paused';
  monitor.nextCheckAt = null;
  await monitor.save();

  res.json({
    success: true,
    message: `Monitor "${monitor.name}" paused. Scheduled checks are stopped until you resume it.`,
    data: { monitor: monitor.toPublicJSON() },
  });
});

// ── POST /api/monitors/:monitorId/resume ─────────────────────────────
const resumeMonitor = asyncHandler(async (req, res) => {
  const monitor = req.monitor;

  if (!monitor.isPaused) {
    throw new ApiError(409, 'This monitor is not paused.');
  }

  monitor.isPaused = false;
  monitor.pausedAt = null;
  // Restore the last known real status; a fresh check is scheduled immediately
  monitor.status = monitor.statusBeforePause || 'pending';
  monitor.statusBeforePause = null;
  monitor.nextCheckAt = new Date();
  await monitor.save();

  res.json({
    success: true,
    message: `Monitor "${monitor.name}" resumed. A fresh check runs on the next scheduler tick.`,
    data: { monitor: monitor.toPublicJSON() },
  });
});

// ── POST /api/monitors/:monitorId/check ──────────────────────────────
const runManualCheck = asyncHandler(async (req, res) => {
  if (req.monitor.isPaused) {
    throw new ApiError(
      409,
      `"${req.monitor.name}" is paused. Resume it before running a check.`
    );
  }

  // Viewers may trigger a check (read-only side effect: it only reads data)
  const { checkResult, raw, transition } = await executeCheck(req.monitor, { source: 'manual' });

  res.json({
    success: true,
    message: `Check finished: monitor is ${raw.status.toUpperCase()}.`,
    data: {
      checkResult,
      status: raw.status,
      responseTimeMs: raw.responseTimeMs,
      statusCode: raw.statusCode,
      errorMessage: raw.errorMessage || null,
      resolvedIp: raw.resolvedIp,
      redirected: raw.redirected,
      statusChanged: transition.changed,
      previousStatus: transition.previousStatus,
      isRecovering: req.monitor.isRecovering,
      monitor: req.monitor.toPublicJSON(),
    },
  });
});

// ── GET /api/monitors/:monitorId/checks ──────────────────────────────
const getCheckHistory = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const { status } = req.query;

  const filter = { monitor: req.monitor._id };
  if (status) filter.status = status;

  const [checks, total] = await Promise.all([
    CheckResult.find(filter).sort({ checkedAt: -1 }).skip(skip).limit(limit).lean(),
    CheckResult.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: {
      checks,
      pagination: buildPaginationMeta({ page, limit, total }),
    },
  });
});

// ── DELETE /api/monitors/:monitorId ──────────────────────────────────
const deleteMonitor = asyncHandler(async (req, res) => {
  const monitor = req.monitor;

  // Check history is meaningless without its monitor, so it goes too.
  const deletedChecks = await CheckResult.deleteMany({ monitor: monitor._id });
  await Monitor.deleteOne({ _id: monitor._id });

  res.json({
    success: true,
    message: `Monitor "${monitor.name}" and its ${deletedChecks.deletedCount} check result(s) were deleted.`,
    data: { deletedChecks: deletedChecks.deletedCount },
  });
});

module.exports = {
  listMonitors,
  getMonitor,
  createMonitor,
  updateMonitor,
  pauseMonitor,
  resumeMonitor,
  runManualCheck,
  getCheckHistory,
  deleteMonitor,
};