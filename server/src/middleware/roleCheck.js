const TeamMember = require('../models/TeamMember');
const ApiError = require('../utils/ApiError');

/**
 * Middleware factory: checks the authenticated user has one of the
 * allowed roles within the team the request targets.
 *
 * The team ID is looked up in this order:
 *   1. req.params.teamId    -> /api/teams/:teamId/...
 *   2. req.monitor.team     -> /api/monitors/:monitorId/...  (set by loadMonitor)
 *   3. req.body.team        -> creating a resource inside a team
 *   4. req.query.teamId     -> filtering
 *
 * Usage:
 *   router.put('/:teamId', requireTeamRole('owner', 'admin'), handler);
 */
const requireTeamRole = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      const teamId =
        req.params?.teamId ||
        req.monitor?.team ||
        req.body?.team ||
        req.query?.teamId ||
        req.body?.teamId;

      if (!teamId) {
        throw new ApiError(400, 'A team must be specified for this action.');
      }

      const membership = await TeamMember.findOne({
        team: teamId,
        user: req.user._id,
      });

      if (!membership) {
        throw new ApiError(403, 'You are not a member of this team.');
      }

      if (!allowedRoles.includes(membership.role)) {
        throw new ApiError(
          403,
          `Your role in this team is "${membership.role}". This action requires: ${allowedRoles.join(' or ')}.`
        );
      }

      // Downstream handlers can reuse the membership without another query
      req.teamMembership = membership;
      req.teamId = String(membership.team);
      next();
    } catch (error) {
      next(error);
    }
  };
};

/**
 * Ensures the user is a member of the team (any role).
 */
const requireTeamMember = requireTeamRole('owner', 'admin', 'viewer');

module.exports = { requireTeamRole, requireTeamMember };