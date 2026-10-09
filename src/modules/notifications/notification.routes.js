const express = require('express');
const router = express.Router();
const notificationController = require('./notification.controller');
const protect = require('../../middleware/protect.middleware');
const protectOptional = protect.protectOptional || protect;
const requireAdminKey = require('../../middleware/adminKey.middleware');
const { createLimiter } = require('../../common/utils/rate-limit');

const deviceLimiter = createLimiter({ name: 'device-register', by: 'user', windowMs: 60 * 60 * 1000, max: 30 });

// Device registration
router.post('/register-device', protect, deviceLimiter, notificationController.registerDevice);
router.post('/register-anonymous-device', deviceLimiter, notificationController.registerAnonymousDevice);
router.post('/unregister-device', protect, deviceLimiter, notificationController.unregisterDevice);

// Customer fetching their notifications
router.get('/', protectOptional, notificationController.getNotifications);
router.delete('/', protectOptional, notificationController.clearAll);
router.put('/:id/read', protectOptional, notificationController.markAsRead);

// Operation App creating notifications (Admin-only — requires x-admin-key header)
router.post('/', requireAdminKey, notificationController.createNotification);

module.exports = router;
