const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const validate = require('../middleware/validate');
const settingsController = require('../controllers/settingsController');
const {
  updatePreferencesValidation,
  testEmailValidation,
} = require('../validators/settingsValidators');

router.use(auth);

router.get('/', settingsController.getSettings);

router.put('/preferences', validate(updatePreferencesValidation), settingsController.updatePreferences);

router.post('/test-email', validate(testEmailValidation), settingsController.testEmail);

router.delete('/notifications', settingsController.clearNotifications);

module.exports = router;