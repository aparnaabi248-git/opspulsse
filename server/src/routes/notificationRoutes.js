const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const validate = require('../middleware/validate');
const notificationController = require('../controllers/notificationController');
const { listNotificationsValidation } = require('../validators/incidentValidators');

router.use(auth);

router.get('/', validate(listNotificationsValidation), notificationController.listNotifications);
router.get('/unread-count', notificationController.unreadCount);
router.get('/email-status', notificationController.emailStatus);

router.post('/read-all', notificationController.markAllAsRead);

router.post('/:notificationId/read', notificationController.markAsRead);

router.delete('/:notificationId', notificationController.deleteNotification);

module.exports = router;