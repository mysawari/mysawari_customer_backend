const express = require('express');
const router = express.Router();
const notificationController = require('./notification.controller');
const protect = require('../../middleware/protect.middleware');
const requireAdminKey = require('../../middleware/adminKey.middleware');
const { createLimiter } = require('../../common/utils/rate-limit');

const deviceLimiter = createLimiter({ name: 'device-register', by: 'user', windowMs: 60 * 60 * 1000, max: 30 });

// Device registration (both require auth — only your own tokens)
router.post('/register-device', protect, deviceLimiter, notificationController.registerDevice);
router.post('/unregister-device', protect, deviceLimiter, notificationController.unregisterDevice);

// Customer fetching their notifications
router.get('/', protect, notificationController.getNotifications);
router.put('/:id/read', protect, notificationController.markAsRead);

// Operation App creating notifications (Admin-only — requires x-admin-key header)
router.post('/', requireAdminKey, notificationController.createNotification);

module.exports = router;
