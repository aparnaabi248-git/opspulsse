const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const validate = require('../middleware/validate');
const incidentController = require('../controllers/incidentController');
const {
  createIncidentValidation,
  resolveIncidentValidation,
  listIncidentsValidation,
} = require('../validators/incidentValidators');

router.use(auth);

// ── Collection ───────────────────────────────────────────────────────
router.get('/', validate(listIncidentsValidation), incidentController.listIncidents);
router.get('/summary', incidentController.getIncidentSummary);

// ── Single incident ──────────────────────────────────────────────────
// Note: :incidentId is validated by loadIncident() in the controller, which
// returns 404 for a malformed or unknown id — the same response a user gets
// for an incident that belongs to somebody else, so ids cannot be probed.

router.get('/:incidentId', incidentController.getIncident);

router.post('/:incidentId/acknowledge', incidentController.acknowledgeIncident);

router.post('/:incidentId/resolve', validate(resolveIncidentValidation), incidentController.resolveIncident);

router.post('/:incidentId/note', validate(createIncidentValidation), incidentController.addNote);

module.exports = router;