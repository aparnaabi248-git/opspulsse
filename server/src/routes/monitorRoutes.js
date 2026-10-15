const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const validate = require('../middleware/validate');
const loadMonitor = require('../middleware/loadMonitor');
const { requireTeamRole } = require('../middleware/roleCheck');
const monitorController = require('../controllers/monitorController');
const {
  createMonitorValidation,
  updateMonitorValidation,
  listMonitorsValidation,
  getChecksValidation,
} = require('../validators/monitorValidators');

// Every monitor route requires a logged-in user
router.use(auth);

// ── Collection ───────────────────────────────────────────────────────
router.get('/', validate(listMonitorsValidation), monitorController.listMonitors);
// Creating a monitor requires owner or admin rights in the target team
router.post(
  '/',
  validate(createMonitorValidation),
  requireTeamRole('owner', 'admin'),
  monitorController.createMonitor
);

// ── Single monitor ───────────────────────────────────────────────────
router.get('/:monitorId', loadMonitor, monitorController.getMonitor);

router.put(
  '/:monitorId',
  validate(updateMonitorValidation),
  loadMonitor,
  requireTeamRole('owner', 'admin'),
  monitorController.updateMonitor
);

router.patch(
  '/:monitorId/pause',
  loadMonitor,
  requireTeamRole('owner', 'admin'),
  monitorController.pauseMonitor
);

router.patch(
  '/:monitorId/resume',
  loadMonitor,
  requireTeamRole('owner', 'admin'),
  monitorController.resumeMonitor
);

// A manual check only reads the target, so any team member may trigger it
router.post('/:monitorId/check', loadMonitor, monitorController.runManualCheck);

router.get('/:monitorId/checks', validate(getChecksValidation), loadMonitor, monitorController.getCheckHistory);

router.delete(
  '/:monitorId',
  loadMonitor,
  requireTeamRole('owner', 'admin'),
  monitorController.deleteMonitor
);

module.exports = router;