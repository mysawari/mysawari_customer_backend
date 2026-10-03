const express = require('express');
const router = express.Router();
const activityController = require('./activity.controller');
const protect = require('../../middleware/protect.middleware');
const protectOptional = protect.protectOptional || protect; // If optional exists, use it, else protect. Actually wait, protectOptional exists in booking.routes.js.

// We should use the same protectOptional logic. Let me just re-implement a quick optional protect if it's missing, but it is exported.
const jwt = require('jsonwebtoken');
const Customer = require('../../models/customer.model');
const AppError = require('../../common/errors/app-error');
const asyncHandler = require('../../common/utils/async-handler');

const localProtectOptional = asyncHandler(async (req, res, next) => {
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }
  if (!token) {
    return next();
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await Customer.findById(decoded.id).select('-password');
  } catch (error) {
    // ignore invalid token for optional routes
  }
  next();
});

router.post('/', localProtectOptional, activityController.logActivity);

module.exports = router;
