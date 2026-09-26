const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const watiService = require('../../integrations/wati.service');
const Customer = require('../../models/customer.model');
const Otp = require('../../models/otp.model');
const Token = require('../../models/token.model');
const Referral = require('../../models/referral.model');
const AppError = require('../../common/errors/app-error');
const secrets = require('../../config/secrets');
const publicCustomer = require('../../common/utils/public-customer');
const { normalizeIp, sameNetwork } = require('../../common/utils/client-ip');
const { installIdFromDeviceInfo } = require('../../common/utils/device');

/**
 * Is this referral suspicious? Checked when the referred person creates their account.
 *  1. Same network as the referrer's own signup (IPv4 address / IPv6 /64).
 *  2. Same phone: the referrer has a session from the very same app install.
 *  3. Farming: the referrer already has 2+ referred signups from this network in the last 24 hours.
 * Carrier NAT means one shared IP alone is only a signal; the same-install check is the strongest one.
 */
async function isSuspiciousReferral(referrer, ipAddress, installId) {
  if (sameNetwork(referrer.signupIp, ipAddress)) return 'same_network_as_referrer';
  if (installId) {
    const sessions = await Token.find({ customerId: referrer._id }).select('deviceInfo').limit(50).lean();
    if (sessions.some((t) => installIdFromDeviceInfo(t.deviceInfo) === installId)) return 'same_device_as_referrer';
  }
  if (ipAddress) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await Customer.find({ referredBy: referrer._id, createdAt: { $gte: since } })
      .select('signupIp').limit(100).lean();
    if (recent.filter((c) => sameNetwork(c.signupIp, ipAddress)).length >= 2) return 'referral_burst_same_network';
  }
  return null;
}

const MAX_OTP_ATTEMPTS = 5;
// Per-number send limits (on top of the per-IP route limiter), so rotating IPs can't be used to
// flood one person with WhatsApp codes or to keep issuing fresh codes to brute-force.
const OTP_RESEND_COOLDOWN_MS = 30 * 1000;
const OTP_SENDS_PER_HOUR = 5;
const otpSendLog = new Map(); // mobileNumber -> [timestamps]

function checkOtpSendAllowed(mobileNumber, now = Date.now()) {
  const recent = (otpSendLog.get(mobileNumber) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length && now - recent[recent.length - 1] < OTP_RESEND_COOLDOWN_MS) {
    throw new AppError('Please wait a few seconds before requesting another OTP', 429);
  }
  if (recent.length >= OTP_SENDS_PER_HOUR) {
    throw new AppError('Too many OTP requests for this number. Please try again later.', 429);
  }
  recent.push(now);
  otpSendLog.set(mobileNumber, recent);
  if (otpSendLog.size > 50000) otpSendLog.delete(otpSendLog.keys().next().value);
}

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
    checkOtpSendAllowed(mobileNumber);
    const otp = crypto.randomInt(1000, 10000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    
    await Otp.findOneAndUpdate(
      { mobileNumber },
      { otp, expiresAt, attempts: 0 },
      { upsert: true, new: true }
    );
    
    try {
      // Call WATI API to send WhatsApp message
      await watiService.sendWhatsAppOtp(mobileNumber, otp);

      // Never log the OTP itself in production.
      console.log(`💬 WhatsApp OTP Request Queued: ${mobileNumber}`);
      if (secrets.isDevelopment) {
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

  async verifyOtp({ mobileNumber, otp, customerName, referredByCode, deviceInfo = 'Unknown', ipAddress = '', installId = '' }) {
    ipAddress = normalizeIp(ipAddress);
    let isNewAccount = false;
    let referralFlagged = null;
    // Count the attempt atomically BEFORE comparing. The old read-compare-then-increment let many
    // parallel guesses all read attempts=0 and bypass the 5-attempt limit on a 4-digit code.
    const storedData = await Otp.findOneAndUpdate(
      { mobileNumber, attempts: { $lt: MAX_OTP_ATTEMPTS } },
      { $inc: { attempts: 1 } },
      { new: true }
    );

    if (!storedData) {
      const exists = await Otp.exists({ mobileNumber });
      if (exists) {
        await Otp.deleteOne({ mobileNumber });
        throw new AppError('Too many incorrect attempts. Please request a new OTP.', 400);
      }
      throw new AppError('Please request a new OTP first', 400);
    }
    if (new Date() > storedData.expiresAt) {
      await Otp.deleteOne({ mobileNumber });
      throw new AppError('OTP has expired', 400);
    }
    // Timing-safe comparison to prevent side-channel attacks
    const storedOtpBuf = Buffer.from(String(storedData.otp || ''));
    const providedOtpBuf = Buffer.from(String(otp || ''));
    const isValid = storedOtpBuf.length === providedOtpBuf.length && crypto.timingSafeEqual(storedOtpBuf, providedOtpBuf);
    if (!isValid) {
      throw new AppError('Invalid OTP', 400);
    }

    // Single use: only the request that actually deletes this exact code may log in with it.
    const consumed = await Otp.findOneAndDelete({ _id: storedData._id, otp: storedData.otp });
    if (!consumed) {
      throw new AppError('Please request a new OTP first', 400);
    }

    let user = await Customer.findOne({ mobileNumber });
    
    if (!user) {
      isNewAccount = true;
      const generateUniqueCode = () => {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let code = '';
        const bytes = crypto.randomBytes(6);
        for (let i = 0; i < 6; i++) {
          code += chars[bytes[i] % chars.length];
        }
        return code;
      };
      let referrer = null;
      if (referredByCode && referredByCode.trim().length > 0) {
        referrer = await Customer.findOne({ referralCode: referredByCode.trim().toUpperCase() });
      }

      user = await Customer.create({
        customerName: (customerName || '').trim().slice(0, 60) || 'New Customer',
        mobileNumber: mobileNumber,
        referralCode: generateUniqueCode(),
        walletBalance: 100,
        rewardsPoints: 0,
        email: '',
        dob: '',
        gender: '',
        signupIp: ipAddress,
        referredBy: referrer ? referrer._id : null
      });

      // Log 100 SawariCash signup bonus (Expires in 30 days)
      const SawariCashTransaction = require('../../models/sawaricash_transaction.model');
      try {
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 30);
        await SawariCashTransaction.create({
          customerId: user._id,
          amount: 100,
          transactionType: 'credit',
          reason: 'Signup Bonus',
          status: 'completed',
          expiresAt
        });
      } catch (err) {
        console.error('Failed to log signup bonus transaction:', err);
      }

      // Track referral
      if (referrer) {
        referralFlagged = await isSuspiciousReferral(referrer, ipAddress, installId);
        const isFraud = Boolean(referralFlagged);
        
        await Referral.findOneAndUpdate(
          { referrerId: referrer._id, referredMobile: mobileNumber },
          {
            $set: {
              referredId: user._id,
              referredName: user.customerName,
              status: isFraud ? 'fraudulent' : 'invited',
            }
          },
          { upsert: true }
        );
      }
    }

    if (user.status === 'blocked') {
      throw new AppError('Account is blocked', 403);
    }

    const { accessToken, refreshToken } = this.generateTokens(user);

    // Save refresh token to DB
    await Token.create({
      customerId: user._id,
      token: refreshToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      deviceInfo
    });
    
    return { token: accessToken, refreshToken, customer: publicCustomer(user), isNewAccount, referralFlagged };
  }

  /** Server-side logout: the refresh token is deleted, so it can't be used again even if it was copied. */
  async revokeRefreshToken(refreshTokenStr) {
    let decoded;
    try {
      decoded = jwt.verify(refreshTokenStr, this.JWT_REFRESH_SECRET, { issuer: this.JWT_ISSUER, audience: this.JWT_AUDIENCE });
    } catch {
      return false;
    }
    const removed = await Token.findOneAndDelete({ token: refreshTokenStr, customerId: decoded.id });
    return !!removed;
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

    // Atomically take the stored token out, so two parallel refreshes with the same token can't both
    // mint a new session (only the request that deletes it continues).
    const storedToken = await Token.findOneAndDelete({ token: refreshTokenStr, customerId: decoded.id });
    if (!storedToken || storedToken.revoked) {
      throw new AppError('Invalid refresh token', 401);
    }

    const user = await Customer.findById(decoded.id);
    if (!user || user.status === 'blocked') {
      throw new AppError('User not found or blocked', 401);
    }

    const { accessToken, refreshToken } = this.generateTokens(user);

    await Token.create({
      customerId: user._id,
      token: refreshToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      deviceInfo
    });

    return { token: accessToken, refreshToken, customer: publicCustomer(user) };
  }
}

module.exports = AuthService;
