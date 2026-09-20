const express = require('express');
const router = express.Router();
const paymentController = require('./payment.controller');
const protect = require('../../middleware/protect.middleware');

router.post('/create-order', protect, paymentController.createOrder);
router.post('/verify-signature', protect, paymentController.verifySignature);

module.exports = router;
