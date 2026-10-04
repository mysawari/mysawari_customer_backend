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

    // Auto push notification logic for immediate transactional events
    if (customerId) {
      const NotificationService = require('../notifications/notification.service');
      let title = null;
      let body = null;

      // Keep only transaction failures instant; marketing is handled by CRON jobs
      if (action === 'payment_failed') {
        title = "Payment Failed";
        body = "Oops! Your payment couldn't be processed. Please try again to confirm your booking.";
      }

      if (title && body) {
        NotificationService.createNotification({
          target: 'specific',
          customerId: customerId,
          title,
          body,
          payload: { action, screen }
        }).catch(err => console.error("Activity auto-notification failed", err));
      }
    }

    return ApiResponse.success(res, activity, 'Activity logged', 201);
  });
}

module.exports = new CustomerActivityController();
