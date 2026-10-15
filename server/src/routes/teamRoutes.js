const express = require('express');
const router = express.Router();
const teamController = require('../controllers/teamController');
const auth = require('../middleware/auth');
const { requireTeamRole } = require('../middleware/roleCheck');
const validate = require('../middleware/validate');
const {
  createTeamValidation,
  addMemberValidation,
  updateMemberRoleValidation,
  updateTeamValidation,
  transferOwnershipValidation,
} = require('../validators/teamValidators');

// All team routes require authentication
router.use(auth);

// Team CRUD
router.post('/', validate(createTeamValidation), teamController.createTeam);
router.get('/', teamController.getMyTeams);
router.get('/:teamId', teamController.getTeam);
router.put(
  '/:teamId',
  requireTeamRole('owner', 'admin'),
  validate(updateTeamValidation),
  teamController.updateTeam
);
router.delete('/:teamId', requireTeamRole('owner'), teamController.deleteTeam);

// Team dashboard numbers
router.get('/:teamId/stats', requireTeamRole('owner', 'admin', 'viewer'), teamController.getTeamStats);

// Ownership + leaving
router.post(
  '/:teamId/transfer-ownership',
  requireTeamRole('owner'),
  validate(transferOwnershipValidation),
  teamController.transferOwnership
);
router.post('/:teamId/leave', requireTeamRole('owner', 'admin', 'viewer'), teamController.leaveTeam);

// Member management (owner & admin only)
router.post(
  '/:teamId/members',
  requireTeamRole('owner', 'admin'),
  validate(addMemberValidation),
  teamController.addMember
);
router.put(
  '/:teamId/members/:userId',
  requireTeamRole('owner', 'admin'),
  validate(updateMemberRoleValidation),
  teamController.updateMemberRole
);
router.delete(
  '/:teamId/members/:userId',
  requireTeamRole('owner', 'admin'),
  teamController.removeMember
);

module.exports = router;
