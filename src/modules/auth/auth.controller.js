const AuthService = require('./auth.service');
const ApiResponse = require('../../common/utils/api-response');
const asyncHandler = require('../../common/utils/async-handler');
const { sendOtpSchema, verifyOtpSchema } = require('./auth.validation');
const AppError = require('../../common/errors/app-error');
const Booking = require('../../models/booking.model');

class AuthController {
  constructor() {
    this.service = new AuthService();
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

    const result = await this.service.verifyOtp(value);
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
    const userId = req.user._id.toString();
    const myReferrals = (global.referralStore || []).filter(r => r.referrerId === userId);

    const enrichedReferrals = await Promise.all(
      myReferrals.map(async (ref) => {
        const completedRides = await Booking.countDocuments({
          mobileNumber: ref.referredMobile,
          status: 'completed'
        });
        return {
          id: ref.id,
          referredName: ref.referredName,
          signupAt: ref.signupAt,
          status: completedRides > 0 ? 'REWARDED' : 'SIGNED_UP'
        };
      })
    );

    return ApiResponse.success(res, enrichedReferrals);
  });
}

module.exports = AuthController;
