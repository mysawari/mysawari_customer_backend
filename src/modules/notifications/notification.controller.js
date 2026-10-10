const notificationService = require('./notification.service');
const ApiResponse = require('../../common/utils/api-response');
const asyncHandler = require('../../common/utils/async-handler');
const AppError = require('../../common/errors/app-error');
const mongoose = require('mongoose');

class NotificationController {
  // GET /api/notifications
  getNotifications = asyncHandler(async (req, res) => {
    // protectOptional may leave req.user undefined for guests — handle gracefully
    const customerId = req.user ? req.user._id : null;
    const guestSessionId = customerId ? null : req.headers['x-guest-session'];
    const notifications = await notificationService.getNotifications(customerId, guestSessionId);
    return ApiResponse.success(res, notifications, 'Notifications fetched');
  });

  // POST /api/notifications (Admin only — protected by requireAdminKey)
  createNotification = asyncHandler(async (req, res) => {
    // Whitelist only allowed fields — never spread raw req.body into the DB.
    const { target, customerId, title, body, payload } = req.body || {};
    if (typeof title !== 'string' || typeof body !== 'string' || !title.trim() || !body.trim()
      || title.length > 200 || body.length > 2000) {
      throw new AppError('title and body are required', 400);
    }
    if (payload !== undefined && (payload === null || typeof payload !== 'object' || JSON.stringify(payload).length > 5000)) {
      throw new AppError('Invalid payload', 400);
    }
    if (!['all', 'specific'].includes(target)) throw new AppError('target must be "all" or "specific"', 400);
    if (target === 'specific' && (!customerId || !mongoose.isValidObjectId(customerId))) {
      throw new AppError('A valid customerId is required for specific notifications', 400);
    }

    const notification = await notificationService.createNotification({
      target, customerId, title, body, payload,
    });
    return ApiResponse.success(res, notification, 'Notification created', 201);
  });

  // PUT /api/notifications/:id/read
  markAsRead = asyncHandler(async (req, res) => {
    const customerId = req.user ? req.user._id : null;
    const notificationId = req.params.id;
    if (!mongoose.isValidObjectId(notificationId)) throw new AppError('Invalid notification', 400);
    const notification = await notificationService.markAsRead(notificationId, customerId);
    return ApiResponse.success(res, notification, 'Marked as read');
  });

  // POST /api/notifications/register-device
  registerDevice = asyncHandler(async (req, res) => {
    const customerId = req.user ? req.user._id : null;
    const { expoPushToken } = req.body || {};
    const deviceType = ['ios', 'android', 'web'].includes(req.body?.deviceType) ? req.body.deviceType : 'unknown';
    if (!expoPushToken || typeof expoPushToken !== 'string' || expoPushToken.length > 200) {
      throw new AppError('A valid Expo Push Token is required', 400);
    }
    // Basic Expo token format validation
    if (!expoPushToken.startsWith('ExponentPushToken[') && !expoPushToken.startsWith('ExpoPushToken[')) {
      throw new AppError('Invalid Expo Push Token format', 400);
    }
    // A login token that was sent but didn't verify (usually just expired: they last 15 minutes) means a
    // signed-in customer whose app was closed for a while — not a sign-out. Their phone stays linked, or
    // their booking pushes would stop reaching it. A phone that sends no login at all is signed out.
    const sentLogin = /^Bearer\s+\S+/i.test(String(req.headers.authorization || ''));
    const device = await notificationService.registerDevice(customerId, expoPushToken, deviceType, undefined, {
      keepCustomerLink: !customerId && sentLogin,
    });
    return ApiResponse.success(res, device, 'Device registered');
  });

  // POST /api/notifications/register-anonymous-device
  registerAnonymousDevice = asyncHandler(async (req, res) => {
    const customerId = null;
    const { expoPushToken, guestSessionId } = req.body || {};
    const deviceType = ['ios', 'android', 'web'].includes(req.body?.deviceType) ? req.body.deviceType : 'unknown';
    if (!expoPushToken || typeof expoPushToken !== 'string' || expoPushToken.length > 200) {
      throw new AppError('A valid Expo Push Token is required', 400);
    }
    // Basic Expo token format validation
    if (!expoPushToken.startsWith('ExponentPushToken[') && !expoPushToken.startsWith('ExpoPushToken[')) {
      throw new AppError('Invalid Expo Push Token format', 400);
    }
    const safeGuestSessionId = notificationService.isGuestSessionId(guestSessionId) ? guestSessionId : undefined;
    // Anonymous registration only records the guest session; it never unlinks a signed-in customer's phone
    // (if the app registers anonymously at launch, that used to cut the customer off from their pushes).
    const device = await notificationService.registerDevice(customerId, expoPushToken, deviceType, safeGuestSessionId, {
      keepCustomerLink: true,
    });
    return ApiResponse.success(res, device, 'Anonymous device registered');
  });

  // POST /api/notifications/unregister-device
  unregisterDevice = asyncHandler(async (req, res) => {
    const customerId = req.user ? req.user._id : null;
    const { expoPushToken } = req.body || {};
    if (!expoPushToken || typeof expoPushToken !== 'string' || expoPushToken.length > 200) {
      throw new AppError('Expo Push Token is required', 400);
    }
    // Only allow unregistering tokens that belong to this customer
    if (customerId) {
      await notificationService.unregisterDeviceForCustomer(customerId, expoPushToken);
    } else {
      await notificationService.unregisterDevice(expoPushToken);
    }
    return ApiResponse.success(res, null, 'Device unregistered successfully');
  });

  // DELETE /api/notifications
  clearAll = asyncHandler(async (req, res) => {
    const customerId = req.user ? req.user._id : null;
    const guestSessionId = customerId ? null : req.headers['x-guest-session'];
    await notificationService.clearAllNotifications(customerId, guestSessionId);
    return ApiResponse.success(res, null, 'All notifications cleared');
  });
}

module.exports = new NotificationController();