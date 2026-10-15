const mongoose = require('mongoose');
const Incident = require('../models/Incident');
const TeamMember = require('../models/TeamMember');
const Monitor = require('../models/Monitor');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { getPagination, buildPaginationMeta } = require('../utils/pagination');
const incidentService = require('../services/incidentService');
const { emitToUser } = require('../socket');

/**
 * Incident controller.
 * Every route is scoped to teams the caller belongs to.
 */

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Loads an incident and verifies membership.
 * An incident from another workspace returns 404, not 403 — we must not
 * confirm that it exists.
 */
const loadIncident = async (incidentId, userId) => {
  if (!mongoose.isValidObjectId(incidentId)) {
    throw new ApiError(404, 'Incident not found.');
  }

  const incident = await Incident.findById(incidentId);
  if (!incident) throw new ApiError(404, 'Incident not found.');

  const membership = await TeamMember.findOne({ team: incident.team, user: userId });
  if (!membership) throw new ApiError(404, 'Incident not found.');

  return { incident, role: membership.role };
};

// ── GET /api/incidents ───────────────────────────────────────────────
const listIncidents = asyncHandler(async (req, res) => {
  const { status, severity, monitor, search } = req.query;
  const { page, limit, skip } = getPagination(req.query);

  const memberships = await TeamMember.find({ user: req.user._id }).select('team');
  let teamIds = memberships.map((m) => String(m.team));

  if (req.query.teamId) {
    if (!teamIds.includes(req.query.teamId)) {
      throw new ApiError(403, 'You are not a member of that team.');
    }
    teamIds = [req.query.teamId];
  }

  if (teamIds.length === 0) {
    return res.json({
      success: true,
      data: { incidents: [], pagination: buildPaginationMeta({ page, limit, total: 0 }) },
    });
  }

  const filter = { team: { $in: teamIds.map((id) => new mongoose.Types.ObjectId(id)) } };

  if (status === 'active') filter.active = true;
  else if (status && status !== 'all') filter.status = status;

  if (severity && severity !== 'all') filter.severity = severity;
  if (monitor) filter.monitor = monitor;
  if (search) filter.title = new RegExp(escapeRegex(search), 'i');

  const [incidents, total] = await Promise.all([
    Incident.find(filter)
      .sort({ startedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('monitor', 'name url status')
      .populate('acknowledgedBy', 'name')
      .populate('resolvedBy', 'name')
      .lean(),
    Incident.countDocuments(filter),
  ]);

  const now = Date.now();
  const shaped = incidents.map((incident) => ({
    ...incident,
    durationMs: incident.resolvedAt
      ? new Date(incident.resolvedAt).getTime() - new Date(incident.startedAt).getTime()
      : now - new Date(incident.startedAt).getTime(),
  }));

  res.json({
    success: true,
    data: { incidents: shaped, pagination: buildPaginationMeta({ page, limit, total }) },
  });
});

// ── GET /api/incidents/summary ───────────────────────────────────────
const getIncidentSummary = asyncHandler(async (req, res) => {
  const memberships = await TeamMember.find({ user: req.user._id }).select('team');
  const teamIds = memberships.map((m) => m.team);

  if (teamIds.length === 0) {
    return res.json({ success: true, data: { open: 0, acknowledged: 0, resolved: 0, total: 0 } });
  }

  const rows = await Incident.aggregate([
    { $match: { team: { $in: teamIds } } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  const summary = { open: 0, acknowledged: 0, resolved: 0, total: 0 };
  for (const row of rows) {
    summary[row._id] = row.count;
    summary.total += row.count;
  }

  res.json({ success: true, data: summary });
});

// ── GET /api/incidents/:incidentId ───────────────────────────────────
const getIncident = asyncHandler(async (req, res) => {
  const { incident, role } = await loadIncident(req.params.incidentId, req.user._id);

  const full = await Incident.findById(incident._id)
    .populate('monitor', 'name url status method')
    .populate('acknowledgedBy', 'name email')
    .populate('resolvedBy', 'name email')
    .populate('timeline.actor', 'name')
    .lean();

  // `incident.monitor` is already a populated object (or a raw id if the
  // monitor was deleted), so unwrap it before looking the monitor up.
  const monitorDoc = await Monitor.findById(full.monitor?._id ?? incident.monitor)
    .select('name')
    .lean();

  const now = Date.now();
  res.json({
    success: true,
    data: {
      incident: {
        ...full,
        durationMs: full.resolvedAt
          ? new Date(full.resolvedAt).getTime() - new Date(full.startedAt).getTime()
          : now - new Date(full.startedAt).getTime(),
      },
      monitorName: monitorDoc?.name ?? null,
      myRole: role,
    },
  });
});

// ── POST /api/incidents/:incidentId/acknowledge ──────────────────────
const acknowledgeIncident = asyncHandler(async (req, res) => {
  const { incident } = await loadIncident(req.params.incidentId, req.user._id);

  const result = await incidentService.acknowledgeIncident(incident._id, req.user);

  if (result.error === 'NOT_FOUND') throw new ApiError(404, 'Incident not found.');
  if (result.error === 'ALREADY_RESOLVED') {
    throw new ApiError(409, 'This incident is already resolved.');
  }
  if (result.error === 'ALREADY_ACKNOWLEDGED') {
    throw new ApiError(409, 'This incident is already acknowledged.');
  }

  res.json({
    success: true,
    message: 'Incident acknowledged. Your team can see you are on it.',
    data: { incident: result.incident },
  });
});

// ── POST /api/incidents/:incidentId/resolve ──────────────────────────
const resolveIncident = asyncHandler(async (req, res) => {
  const { incident } = await loadIncident(req.params.incidentId, req.user._id);

  const result = await incidentService.resolveIncidentManually(
    incident._id,
    req.user,
    req.body.notes || ''
  );

  if (result.error === 'NOT_FOUND') throw new ApiError(404, 'Incident not found.');
  if (result.error === 'ALREADY_RESOLVED') {
    throw new ApiError(409, 'This incident is already resolved.');
  }

  res.json({
    success: true,
    message: 'Incident resolved.',
    data: { incident: result.incident },
  });
});

// ── POST /api/incidents/:incidentId/note ─────────────────────────────
const addNote = asyncHandler(async (req, res) => {
  const { incident } = await loadIncident(req.params.incidentId, req.user._id);

  const message = req.body.note?.trim();
  if (!message || message.length < 2) {
    throw new ApiError(400, 'A note is required (at least 2 characters).');
  }

  const result = await incidentService.addNote(incident._id, req.user, message);

  if (result.error === 'NOT_FOUND') throw new ApiError(404, 'Incident not found.');
  if (result.error === 'ALREADY_RESOLVED') {
    throw new ApiError(409, 'This incident is resolved, so notes can no longer be added.');
  }

  res.status(201).json({
    success: true,
    message: 'Note added to the timeline.',
    data: { incident: result.incident },
  });
});

void emitToUser;

module.exports = {
  listIncidents,
  getIncidentSummary,
  getIncident,
  acknowledgeIncident,
  resolveIncident,
  addNote,
  loadIncident,
};