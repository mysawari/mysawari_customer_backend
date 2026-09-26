const express = require('express');
const CustomerController = require('./customer.controller');
const protect = require('../../middleware/protect.middleware');
const { createLimiter } = require('../../common/utils/rate-limit');

const profileWriteLimiter = createLimiter({ name: 'profile-write', by: 'user', windowMs: 60 * 60 * 1000, max: 30 });
const accountDeleteLimiter = createLimiter({ name: 'account-delete', by: 'user', windowMs: 24 * 60 * 60 * 1000, max: 3 });

const router = express.Router();
const customerController = new CustomerController();

router.get('/profile', protect, customerController.getProfile.bind(customerController));
router.put('/profile', protect, profileWriteLimiter, customerController.updateProfile.bind(customerController));
router.delete('/profile', protect, accountDeleteLimiter, customerController.deleteProfile.bind(customerController));

module.exports = router;
