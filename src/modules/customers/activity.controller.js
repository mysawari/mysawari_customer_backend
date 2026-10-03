const CustomerActivity = require('../../models/customer_activity.model');
const ApiResponse = require('../../common/utils/api-response');
const asyncHandler = require('../../common/utils/async-handler');
const mongoose = require('mongoose');

class CustomerActivityController {
  // POST /api/activity
  logActivity = asyncHandler(async (req, res) => {
    const { action, screen, details, sessionId } = req.body;
    
    // Support both guests and logged-in users
    const customerId = req.user ? req.user._id : null;
    const mobileNumber = req.user ? req.user.mobileNumber : null;

    if (!action) {
      return ApiResponse.error(res, 'Action is required', 400);
    }

    const activity = await CustomerActivity.create({
      customerId,
      mobileNumber,
      sessionId,
      action,
      screen,
      details,
    });

    return ApiResponse.success(res, activity, 'Activity logged', 201);
  });
}

module.exports = new CustomerActivityController();
