const mongoose = require('mongoose');
const Team = require('../models/Team');
const TeamMember = require('../models/TeamMember');
const User = require('../models/User');
const Monitor = require('../models/Monitor');
const Incident = require('../models/Incident');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

// ── POST /api/teams ──────────────────────────────────
exports.createTeam = async (req, res, next) => {
  try {
    const { name, description } = req.body;

    const team = await Team.create({
      name,
      description,
      owner: req.user._id,
    });

    await TeamMember.create({
      team: team._id,
      user: req.user._id,
      role: 'owner',
    });

    res.status(201).json({
      success: true,
      message: 'Team created successfully',
      data: { team },
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/teams ───────────────────────────────────
exports.getMyTeams = async (req, res, next) => {
  try {
    const memberships = await TeamMember.find({ user: req.user._id }).populate('team');

    const teams = memberships.map((m) => ({
      ...m.team.toObject(),
      role: m.role,
    }));

    res.json({ success: true, data: { teams } });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/teams/:teamId ───────────────────────────
exports.getTeam = async (req, res, next) => {
  try {
    const team = await Team.findById(req.params.teamId).populate('owner', 'name email');
    if (!team) throw new ApiError(404, 'Team not found.');

    // Verify membership
    const membership = await TeamMember.findOne({
      team: team._id,
      user: req.user._id,
    });
    if (!membership) throw new ApiError(403, 'You are not a member of this team.');

    // Fetch all members
    const members = await TeamMember.find({ team: team._id }).populate('user', 'name email');

    res.json({
      success: true,
      data: {
        team,
        members: members.map((m) => ({
          id: m.user._id,
          name: m.user.name,
          email: m.user.email,
          role: m.role,
          joinedAt: m.createdAt,
        })),
        myRole: membership.role,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── PUT /api/teams/:teamId ───────────────────────────
exports.updateTeam = async (req, res, next) => {
  try {
    const { name, description } = req.body;

    const team = await Team.findByIdAndUpdate(
      req.params.teamId,
      { name, description },
      { new: true, runValidators: true }
    );
    if (!team) throw new ApiError(404, 'Team not found.');

    res.json({
      success: true,
      message: 'Team updated successfully',
      data: { team },
    });
  } catch (error) {
    next(error);
  }
};

// ── DELETE /api/teams/:teamId ────────────────────────
exports.deleteTeam = async (req, res, next) => {
  try {
    const team = await Team.findById(req.params.teamId);
    if (!team) throw new ApiError(404, 'Team not found.');

    if (team.owner.toString() !== req.user._id.toString()) {
      throw new ApiError(403, 'Only the team owner can delete the team.');
    }

    await TeamMember.deleteMany({ team: team._id });
    await Team.deleteOne({ _id: team._id });

    res.json({ success: true, message: 'Team deleted successfully' });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/teams/:teamId/members ──────────────────
exports.addMember = async (req, res, next) => {
  try {
    const { email, role } = req.body;

    const user = await User.findOne({ email });
    if (!user) throw new ApiError(404, 'No user found with that email address.');

    const existing = await TeamMember.findOne({
      team: req.params.teamId,
      user: user._id,
    });
    if (existing) throw new ApiError(409, 'User is already a member of this team.');

    // Never allow adding as owner via API
    const memberRole = role === 'owner' ? 'admin' : role || 'viewer';

    await TeamMember.create({
      team: req.params.teamId,
      user: user._id,
      role: memberRole,
    });

    res.status(201).json({
      success: true,
      message: `${user.name} added to the team as ${memberRole}`,
      data: {
        member: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: memberRole,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── PUT /api/teams/:teamId/members/:userId ───────────
exports.updateMemberRole = async (req, res, next) => {
  try {
    const { role } = req.body;

    if (role === 'owner') {
      throw new ApiError(400, 'Cannot assign owner role. Transfer ownership instead.');
    }

    const membership = await TeamMember.findOne({
      team: req.params.teamId,
      user: req.params.userId,
    });
    if (!membership) throw new ApiError(404, 'Member not found in this team.');
    if (membership.role === 'owner') {
      throw new ApiError(400, "Cannot change the owner's role.");
    }

    membership.role = role;
    await membership.save();

    res.json({
      success: true,
      message: 'Member role updated',
      data: { role: membership.role },
    });
  } catch (error) {
    next(error);
  }
};

// ── DELETE /api/teams/:teamId/members/:userId ────────
exports.removeMember = async (req, res, next) => {
  try {
    const membership = await TeamMember.findOne({
      team: req.params.teamId,
      user: req.params.userId,
    });
    if (!membership) throw new ApiError(404, 'Member not found in this team.');
    if (membership.role === 'owner') {
      throw new ApiError(400, 'Cannot remove the team owner.');
    }

    await TeamMember.deleteOne({ _id: membership._id });

    res.json({ success: true, message: 'Member removed from team' });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/teams/:teamId/stats ─────────────────────────────────────
/**
 * Real counts for the team management screen. Every number is a live query,
 * nothing is estimated.
 */
exports.getTeamStats = asyncHandler(async (req, res) => {
  const teamId = req.params.teamId;

  const [memberCount, monitorCount, activeIncidents, totalIncidents, statusRows] =
    await Promise.all([
      TeamMember.countDocuments({ team: teamId }),
      Monitor.countDocuments({ team: teamId }),
      Incident.countDocuments({ team: teamId, active: true }),
      Incident.countDocuments({ team: teamId }),
      Monitor.aggregate([
        { $match: { team: new mongoose.Types.ObjectId(String(teamId)) } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ]);

  const monitorsByStatus = { up: 0, down: 0, degraded: 0, paused: 0, pending: 0 };
  for (const row of statusRows) monitorsByStatus[row._id] = row.count;

  res.json({
    success: true,
    data: {
      members: memberCount,
      monitors: monitorCount,
      monitorsByStatus,
      activeIncidents,
      totalIncidents,
    },
  });
});

// ── POST /api/teams/:teamId/transfer-ownership ──────────────────────
/**
 * Hand the team to another member. The current owner becomes an admin so the
 * team is never left without someone able to manage it.
 */
exports.transferOwnership = asyncHandler(async (req, res) => {
  const { teamId, newOwnerId } = req.body;
  const current = req.teamMembership;

  if (String(current.team) !== String(teamId)) {
    throw new ApiError(403, 'You are not a member of this team.');
  }
  if (current.role !== 'owner') {
    throw new ApiError(403, 'Only the team owner can transfer ownership.');
  }

  const target = await TeamMember.findOne({ team: teamId, user: newOwnerId });
  if (!target) throw new ApiError(404, 'That person is not a member of this team.');
  if (target.role === 'owner') throw new ApiError(409, 'They already own this team.');

  const [newOwner] = await Promise.all([
    User.findById(newOwnerId).select('name email'),
  ]);

  target.role = 'owner';
  await target.save();

  current.role = 'admin';
  await current.save();

  await Team.updateOne({ _id: teamId }, { $set: { owner: newOwnerId } });

  res.json({
    success: true,
    message: `${newOwner?.name || 'The new owner'} now owns this team.`,
    data: { newOwner: { id: String(newOwnerId), name: newOwner?.name, email: newOwner?.email } },
  });
});

// ── POST /api/teams/:teamId/leave ───────────────────────────────────
/**
 * A non-owner can walk away. The owner cannot — they must transfer first or
 * delete the team.
 */
exports.leaveTeam = asyncHandler(async (req, res) => {
  const current = req.teamMembership;

  if (current.role === 'owner') {
    throw new ApiError(
      400,
      'You own this team. Transfer ownership or delete the team before leaving.'
    );
  }

  await TeamMember.deleteOne({ _id: current._id });

  res.json({ success: true, message: 'You have left this workspace.' });
});
