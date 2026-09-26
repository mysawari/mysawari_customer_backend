const Joi = require('joi');

// Indian mobile numbers only (the app always sends the bare 10 digits). Rejecting anything else stops
// the OTP endpoint from being used to fire WhatsApp messages at arbitrary / international numbers.
const mobileNumber = Joi.string().trim().pattern(/^[6-9]\d{9}$/).required()
  .messages({ 'string.pattern.base': 'Enter a valid 10-digit mobile number' });

const sendOtpSchema = Joi.object({
  mobileNumber,
});

const verifyOtpSchema = Joi.object({
  mobileNumber,
  otp: Joi.string().pattern(/^\d{4}$/).required().messages({ 'string.pattern.base': 'Invalid OTP' }),
  customerName: Joi.string().trim().allow('').max(60).optional(),
  referredByCode: Joi.string().trim().allow('').max(20).pattern(/^[A-Za-z0-9]*$/).optional(),
});

const referSchema = Joi.object({
  mobileNumber: Joi.string().max(20).required(),
  name: Joi.string().allow('').max(60).optional(),
});

const refreshSchema = Joi.object({
  refreshToken: Joi.string().max(2048).required(),
});

module.exports = {
  sendOtpSchema,
  verifyOtpSchema,
  referSchema,
  refreshSchema,
};
