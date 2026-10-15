const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const validate = require('../middleware/validate');
const checkController = require('../controllers/checkController');

router.use(auth);

/**
 * GET /api/checks/recent
 * Recent monitoring activity across every monitor the caller can see.
 * Scoped to the caller's teams — never leaks another workspace's data.
 */
router.get('/recent', validate(checkController.recentChecksValidation), checkController.getRecentChecks);

module.exports = router;