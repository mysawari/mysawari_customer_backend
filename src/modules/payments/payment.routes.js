const express = require('express');
const router = express.Router();
const paymentController = require('./payment.controller');
const protect = require('../../middleware/protect.middleware');
const { createLimiter } = require('../../common/utils/rate-limit');

// Every order is a call to Razorpay; bounded per customer so it can't be scripted.
const orderLimiter = createLimiter({ name: 'payment-order', by: 'user', windowMs: 60 * 60 * 1000, max: 30 });
const verifyLimiter = createLimiter({ name: 'payment-verify', by: 'user', windowMs: 60 * 60 * 1000, max: 60 });

router.post('/create-order', protect, orderLimiter, paymentController.createOrder);
router.post('/verify-signature', protect, verifyLimiter, paymentController.verifySignature);

module.exports = router;
