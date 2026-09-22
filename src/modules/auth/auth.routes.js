const express = require('express');
const rateLimit = require('express-rate-limit');
const AuthController = require('./auth.controller');
const protect = require('../../middleware/protect.middleware');

const router = express.Router();
const controller = new AuthController();

// OTPs are 4 digits, so throttle attempts to make guessing impractical.
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts, please try again later.' },
});

// Adding referrals is throttled so the endpoint can't be used to probe which numbers are already customers.
const referLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many referrals added, please try again later.' },
});

router.post('/send-otp', otpLimiter, controller.sendOtp);
router.post('/verify-otp', otpLimiter, controller.verifyOtp);
router.post('/refresh', controller.refreshToken);
router.get('/my-referrals', protect, controller.getMyReferrals);
router.post('/refer', protect, referLimiter, controller.addReferral);

module.exports = router;
