const express = require('express');
const { createLimiter } = require('../../common/utils/rate-limit');
const AuthController = require('./auth.controller');
const protect = require('../../middleware/protect.middleware');

const router = express.Router();
const controller = new AuthController();

// OTPs are 4 digits, so throttle attempts to make guessing impractical.
const otpLimiter = createLimiter({
  name: 'otp', by: 'ip', windowMs: 10 * 60 * 1000, max: 20,
  message: 'Too many attempts, please try again later.',
});

// Adding referrals is throttled so the endpoint can't be used to probe which numbers are already customers.
const referLimiter = createLimiter({
  name: 'refer', by: 'user', windowMs: 60 * 60 * 1000, max: 30,
  message: 'Too many referrals added, please try again later.',
});

// Refresh tokens can be tried without a valid access token, so they need throttling independently.
const refreshLimiter = createLimiter({
  name: 'refresh', by: 'ip', windowMs: 10 * 60 * 1000, max: 30,
  message: 'Too many attempts, please try again later.',
});
// Signing out is cheap and harmless, but still bounded.
const logoutLimiter = createLimiter({ name: 'logout', by: 'ip', windowMs: 10 * 60 * 1000, max: 30 });

router.post('/send-otp', otpLimiter, controller.sendOtp);
router.post('/verify-otp', otpLimiter, controller.verifyOtp);
router.post('/refresh', refreshLimiter, controller.refreshToken);
router.post('/logout', logoutLimiter, controller.logout);
router.get('/my-referrals', protect, controller.getMyReferrals);
router.post('/refer', protect, referLimiter, controller.addReferral);

module.exports = router;
