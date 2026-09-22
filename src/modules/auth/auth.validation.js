const Joi = require('joi');

const sendOtpSchema = Joi.object({
  mobileNumber: Joi.string().required(),
});

const verifyOtpSchema = Joi.object({
  mobileNumber: Joi.string().required(),
  otp: Joi.string().length(4).required(),
  customerName: Joi.string().allow('').optional(),
  referredByCode: Joi.string().allow('').optional(),
});

const referSchema = Joi.object({
  mobileNumber: Joi.string().required(),
  name: Joi.string().allow('').max(60).optional(),
});

module.exports = {
  sendOtpSchema,
  verifyOtpSchema,
  referSchema
};
