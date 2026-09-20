const express = require('express');
const CustomerController = require('./customer.controller');
const protect = require('../../middleware/protect.middleware');

const router = express.Router();
const customerController = new CustomerController();

router.get('/profile', protect, customerController.getProfile.bind(customerController));
router.put('/profile', protect, customerController.updateProfile.bind(customerController));

module.exports = router;
