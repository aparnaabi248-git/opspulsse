const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const auth = require('../middleware/auth');
const validate = require('../middleware/validate');
const { authLimiter, sessionLimiter } = require('../middleware/rateLimit');
const {
  registerValidation,
  loginValidation,
  updateProfileValidation,
  changePasswordValidation,
} = require('../validators/authValidators');

// Public — strictly limited because this is the password-guessing door
router.post('/register', authLimiter, validate(registerValidation), authController.register);
router.post('/login', authLimiter, validate(loginValidation), authController.login);

// Protected
// /me runs on every page load, so it gets its own generous limiter instead of
// sharing the strict sign-in budget. Otherwise a busy session could trip the
// limit and look to the client exactly like an expired login — which used to
// bounce people to the login screen with no explanation.
router.get('/me', sessionLimiter, auth, authController.getProfile);
router.put('/profile', auth, validate(updateProfileValidation), authController.updateProfile);
router.put('/change-password', auth, validate(changePasswordValidation), authController.changePassword);
router.post('/logout', auth, authController.logout);

module.exports = router;
