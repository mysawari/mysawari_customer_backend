const express = require('express');
const router = express.Router();
const activityController = require('./activity.controller');
const jwt = require('jsonwebtoken');
const Customer = require('../../models/customer.model');
const asyncHandler = require('../../common/utils/async-handler');
const { JWT_SECRET, JWT_ISSUER, JWT_AUDIENCE } = require('../../config/secrets');

/**
 * Works out who logged the activity. The token's signature, issuer and audience are checked like
 * everywhere else, but an expired access token (they last 15 minutes) still identifies the customer —
 * otherwise most activity was saved as a guest with no customer id or number. Nothing is read or changed
 * with it; it only labels the activity row.
 */
const identifyCustomer = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE, ignoreExpiration: true });
    const customer = await Customer.findById(decoded.id).select('_id mobileNumber status').lean();
    if (customer && customer.status !== 'blocked') req.user = customer;
  } catch (error) {
    // A forged or malformed token is simply treated as a guest.
  }
  next();
});

router.post('/', identifyCustomer, activityController.logActivity);

module.exports = router;
