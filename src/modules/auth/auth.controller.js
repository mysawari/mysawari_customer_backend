const AuthService = require('./auth.service');
const ApiResponse = require('../../common/utils/api-response');
const asyncHandler = require('../../common/utils/async-handler');
const { sendOtpSchema, verifyOtpSchema, referSchema, refreshSchema } = require('./auth.validation');
const ReferralService = require('../referrals/referral.service');
const AppError = require('../../common/errors/app-error');
const Booking = require('../../models/booking.model');
const { clientIp } = require('../../common/utils/client-ip');
const { deviceInfoFor, installId } = require('../../common/utils/device');
const { securityLog } = require('../../common/utils/security-log');

class AuthController {
  constructor() {
    this.service = new AuthService();
    this.referrals = new ReferralService();
  }

  sendOtp = asyncHandler(async (req, res) => {
    const { error, value } = sendOtpSchema.validate(req.body || {});
    if (error) throw new AppError(error.details[0].message, 400);

    let result;
    try {
      result = await this.service.sendOtp(value);
    } catch (e) {
      if (e.statusCode === 429) securityLog('otp_send_throttled', req, { mobile: value.mobileNumber });
      throw e;
    }
    return ApiResponse.success(res, result, 'OTP sent successfully');
  });

  verifyOtp = asyncHandler(async (req, res) => {
    const { error, value } = verifyOtpSchema.validate(req.body || {});
    if (error) throw new AppError(error.details[0].message, 400);
    // The client IP as Express resolves it through the configured, trusted proxies only (TRUST_PROXY) —
    // never the raw X-Forwarded-For header, which any client can fill in.
    const ipAddress = clientIp(req);
    const deviceInfo = deviceInfoFor(req);
    let result;
    try {
      result = await this.service.verifyOtp({ ...value, ipAddress, deviceInfo, installId: installId(req) });
    } catch (e) {
      const event = /blocked/i.test(e.message) ? 'login_blocked' : /Too many/i.test(e.message) ? 'otp_locked' : 'otp_failed';
      securityLog(event, req, { mobile: value.mobileNumber, reason: e.message });
      throw e;
    }
    securityLog('login', req, { mobile: value.mobileNumber, newAccount: !!result.isNewAccount, referralFlagged: !!result.referralFlagged });
    delete result.isNewAccount;
    delete result.referralFlagged;
    return ApiResponse.success(res, result, 'Logged in successfully');
  });

  refreshToken = asyncHandler(async (req, res) => {
    const { error, value } = refreshSchema.validate(req.body || {});
    if (error) throw new AppError('Refresh token is required', 400);

    const result = await this.service.refreshToken(value.refreshToken, deviceInfoFor(req));
    
    return ApiResponse.success(res, result, 'Token refreshed successfully');
  });

  /** Ends this session on the server too: the refresh token stops working immediately. */
  logout = asyncHandler(async (req, res) => {
    const { error, value } = refreshSchema.validate(req.body || {});
    if (!error) {
      const revoked = await this.service.revokeRefreshToken(value.refreshToken);
      if (revoked) securityLog('session_revoked', req, {});
    }
    // Always the same answer, so the endpoint reveals nothing about which tokens exist.
    return ApiResponse.success(res, null, 'Logged out');
  });

  getMyReferrals = asyncHandler(async (req, res) => {
    // Pay out any commission that has become due (a referred person's trip completing) before listing.
    await this.referrals.settle(req.user._id);
    return ApiResponse.success(res, await this.referrals.list(req.user._id));
  });

  addReferral = asyncHandler(async (req, res) => {
    const { error, value } = referSchema.validate(req.body || {});
    if (error) throw new AppError(error.details[0].message, 400);

    const referral = await this.referrals.addReferral(req.user, value);
    return ApiResponse.success(res, { id: String(referral._id), mobileNumber: referral.mobileNumber }, 'Referral added', 201);
  });
}

module.exports = AuthController;
