const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const watiService = require('../../integrations/wati.service');
const Customer = require('../../models/customer.model');
const Otp = require('../../models/otp.model');
const Token = require('../../models/token.model');
const AppError = require('../../common/errors/app-error');
const secrets = require('../../config/secrets');

// Initialize in-memory referral store
global.referralStore = global.referralStore || [];

class AuthService {
  constructor() {
    this.JWT_SECRET = secrets.JWT_SECRET;
    this.JWT_REFRESH_SECRET = secrets.JWT_REFRESH_SECRET;
    this.JWT_ISSUER = secrets.JWT_ISSUER;
    this.JWT_AUDIENCE = secrets.JWT_AUDIENCE;
  }

  generateTokens(user) {
    const payload = { id: user._id, mobileNumber: user.mobileNumber };
    
    // Short-lived Access Token (15 minutes)
    const accessToken = jwt.sign(payload, this.JWT_SECRET, { 
      expiresIn: '15m',
      issuer: this.JWT_ISSUER,
      audience: this.JWT_AUDIENCE
    });

    // Long-lived Refresh Token (30 days)
    const refreshToken = jwt.sign(payload, this.JWT_REFRESH_SECRET, { 
      expiresIn: '30d',
      issuer: this.JWT_ISSUER,
      audience: this.JWT_AUDIENCE
    });

    return { accessToken, refreshToken };
  }

  async sendOtp({ mobileNumber }) {
    const otp = crypto.randomInt(1000, 10000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    
    await Otp.findOneAndUpdate(
      { mobileNumber },
      { otp, expiresAt },
      { upsert: true, new: true }
    );
    
    try {
      // Call WATI API to send WhatsApp message
      await watiService.sendWhatsAppOtp(mobileNumber, otp);

      // Never log the OTP itself in production.
      console.log(`💬 WhatsApp OTP Request Queued: ${mobileNumber}`);
      if (!secrets.isProduction) {
        console.log(`🔒 Developer Override Code: ${otp}`);
      }
      
      const isExistingUser = await Customer.exists({ mobileNumber });
      return { isExistingUser: !!isExistingUser };
    } catch (error) {
      // If sending fails, rollback the OTP from database so the user isn't stuck
      await Otp.deleteOne({ mobileNumber });
      throw error;
    }
  }

  async verifyOtp({ mobileNumber, otp, customerName, referredByCode, deviceInfo = 'Unknown', ipAddress = '' }) {
    const storedData = await Otp.findOne({ mobileNumber });
    
    if (!storedData) {
      throw new AppError('Please request a new OTP first', 400);
    }
    if (new Date() > storedData.expiresAt) {
      await Otp.deleteOne({ mobileNumber });
      throw new AppError('OTP has expired', 400);
    }
    if (storedData.otp !== otp) {
      throw new AppError('Invalid OTP', 400);
    }

    await Otp.deleteOne({ mobileNumber });

    let user = await Customer.findOne({ mobileNumber });
    
    if (!user) {
      const generateUniqueCode = () => {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let code = '';
        const bytes = crypto.randomBytes(6);
        for (let i = 0; i < 6; i++) {
          code += chars[bytes[i] % chars.length];
        }
        return code;
      };
      
      user = await Customer.create({
        customerName: customerName || 'New Customer',
        mobileNumber: mobileNumber,
        referralCode: generateUniqueCode(),
        walletBalance: 100,
        rewardsPoints: 0,
        email: '',
        dob: '',
        gender: '',
        signupIp: ipAddress
      });

      // Log 100 SawariCash signup bonus
      global.walletTransactions = global.walletTransactions || [];
      global.walletTransactions.push({
        id: `tx_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        customerId: user._id.toString(),
        type: 'credit',
        amount: 100,
        description: 'Signup Bonus',
        date: new Date().toISOString()
      });

      // Track referral if referredByCode is provided
      if (referredByCode && referredByCode.trim().length > 0) {
        const referrer = await Customer.findOne({ referralCode: referredByCode.trim().toUpperCase() });
        if (referrer) {
          global.referralStore.push({
            id: `ref_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            referrerId: referrer._id.toString(),
            referredId: user._id.toString(),
            referredName: user.customerName,
            referredMobile: user.mobileNumber,
            signupAt: new Date().toISOString()
          });
        }
      }
    }

    const { accessToken, refreshToken } = this.generateTokens(user);

    // Save refresh token to DB
    await Token.create({
      customerId: user._id,
      token: refreshToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      deviceInfo
    });
    
    return { token: accessToken, refreshToken, customer: user };
  }

  async refreshToken(refreshTokenStr, deviceInfo = 'Unknown') {
    if (!refreshTokenStr) {
      throw new AppError('Refresh token is required', 401);
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshTokenStr, this.JWT_REFRESH_SECRET, {
        issuer: this.JWT_ISSUER,
        audience: this.JWT_AUDIENCE
      });
    } catch (error) {
      throw new AppError('Invalid or expired refresh token', 401);
    }

    const storedToken = await Token.findOne({ token: refreshTokenStr });
    
    if (!storedToken || storedToken.revoked) {
      // If a revoked token is used, it could mean token theft. We could proactively revoke all tokens for this user.
      if (storedToken && storedToken.revoked) {
         await Token.deleteMany({ customerId: decoded.id });
      }
      throw new AppError('Invalid refresh token', 401);
    }

    const user = await Customer.findById(decoded.id);
    if (!user || user.status === 'blocked') {
      throw new AppError('User not found or blocked', 401);
    }

    // Revoke old token and issue a new pair
    await Token.findByIdAndDelete(storedToken._id);

    const { accessToken, refreshToken } = this.generateTokens(user);

    await Token.create({
      customerId: user._id,
      token: refreshToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      deviceInfo
    });

    return { token: accessToken, refreshToken, customer: user };
  }
}

module.exports = AuthService;
