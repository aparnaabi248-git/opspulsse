const mongoose = require('mongoose');
const Monitor = require('../models/Monitor');
const TeamMember = require('../models/TeamMember');
const ApiError = require('../utils/ApiError');

/**
 * Loads :monitorId (or :id) into req.monitor and verifies the caller belongs
 * to the monitor's team.
 *
 * Ordering matters: an unknown id and a monitor belonging to somebody else's
 * team must not be distinguishable from the outside, so both return 404.
 */
const loadMonitor = async (req, res, next) => {
  try {
    const monitorId = req.params.monitorId || req.params.id;

    if (!mongoose.isValidObjectId(monitorId)) {
      throw new ApiError(404, 'Monitor not found.');
    }

    const monitor = await Monitor.findById(monitorId);
    if (!monitor) {
      throw new ApiError(404, 'Monitor not found.');
    }

    const membership = await TeamMember.findOne({ team: monitor.team, user: req.user._id });
    if (!membership) {
      // Do not reveal that the monitor exists
      throw new ApiError(404, 'Monitor not found.');
    }

    req.monitor = monitor;
    req.teamMembership = membership;
    req.teamId = String(monitor.team);
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = loadMonitor;