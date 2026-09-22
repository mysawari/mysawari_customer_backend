const AuthService = require('./auth.service');
const ApiResponse = require('../../common/utils/api-response');
const asyncHandler = require('../../common/utils/async-handler');
const { sendOtpSchema, verifyOtpSchema, referSchema } = require('./auth.validation');
const ReferralService = require('../referrals/referral.service');
const AppError = require('../../common/errors/app-error');
const Booking = require('../../models/booking.model');

class AuthController {
  constructor() {
    this.service = new AuthService();
    this.referrals = new ReferralService();
  }

  sendOtp = asyncHandler(async (req, res) => {
    const { error, value } = sendOtpSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);

    const result = await this.service.sendOtp(value);
    return ApiResponse.success(res, result, 'OTP sent successfully');
  });

  verifyOtp = asyncHandler(async (req, res) => {
    const { error, value } = verifyOtpSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);
    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip || 'Unknown';
    const result = await this.service.verifyOtp({ ...value, ipAddress });
    return ApiResponse.success(res, result, 'Logged in successfully');
  });

  refreshToken = asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) throw new AppError('Refresh token is required', 400);

    const deviceInfo = req.headers['user-agent'] || 'Unknown';
    const result = await this.service.refreshToken(refreshToken, deviceInfo);
    
    return ApiResponse.success(res, result, 'Token refreshed successfully');
  });

  getMyReferrals = asyncHandler(async (req, res) => {
    // Pay out any commission that has become due (a referred person's trip completing) before listing.
    await this.referrals.settle(req.user._id);
    return ApiResponse.success(res, await this.referrals.list(req.user._id));
  });

  addReferral = asyncHandler(async (req, res) => {
    const { error, value } = referSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);

    const referral = await this.referrals.addReferral(req.user, value);
    return ApiResponse.success(res, { id: String(referral._id), mobileNumber: referral.mobileNumber }, 'Referral added', 201);
  });
}

module.exports = AuthController;
