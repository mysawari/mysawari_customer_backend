const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema({
  mobileNumber: {
    type: String,
    required: true,
    unique: true
  },
  otp: {
    type: String,
    required: true
  },
  expiresAt: {
    type: Date,
    required: true
  },
  // A 4-digit code only has 9000 possibilities — per-IP rate limiting alone doesn't stop an
  // attacker who spreads guesses across IPs. This bounds guesses per issued code regardless of IP.
  attempts: {
    type: Number,
    default: 0
  }
}, { timestamps: true });

// TTL index to automatically delete expired OTPs (expires after 5 minutes)
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Otp', otpSchema);
