const Notification = require('../../models/notification.model');
const CustomerDevice = require('../../models/customer_device.model');
const axios = require('axios'); // for Expo Push API

class NotificationService {
  /**
   * Register a customer device token
   */
  async registerDevice(customerId, expoPushToken, deviceType) {
    let device = await CustomerDevice.findOne({ expoPushToken });
    if (device) {
      if ((!device.customerId && customerId) || (device.customerId && customerId && device.customerId.toString() !== customerId.toString())) {
        device.customerId = customerId;
        device.deviceType = deviceType || device.deviceType;
        await device.save();
      } else if (!device.customerId && !customerId) {
        // already anonymous
      }
    } else {
      device = new CustomerDevice({ customerId: customerId || undefined, expoPushToken, deviceType });
      await device.save();
    }
    return device;
  }

  /**
   * Unregister a device token (internal use only — no ownership check)
   */
  async unregisterDevice(expoPushToken) {
    return await CustomerDevice.findOneAndDelete({ expoPushToken });
  }

  /**
   * Unregister a device token — only if it belongs to the given customer.
   */
  async unregisterDeviceForCustomer(customerId, expoPushToken) {
    return await CustomerDevice.findOneAndDelete({ customerId, expoPushToken });
  }

  /**
   * Fetch notifications for a specific customer
   * Includes both 'all' target and 'specific' target notifications
   */
  async getNotifications(customerId) {
    // Build query: guests only see broadcasts, logged-in users see broadcasts + their specific ones
    const query = customerId
      ? { $or: [{ target: 'all' }, { customerId: customerId }] }
      : { target: 'all' };

    const notifications = await Notification.find(query).sort({ createdAt: -1 }).limit(50);
    
    // Map them to include dynamic isRead based on the readBy array for 'all'
    return notifications.map(notif => {
      const n = notif.toJSON();
      if (n.target === 'all' && customerId) {
        n.isRead = notif.readBy.some((id) => String(id) === String(customerId));
      } else if (n.target === 'all') {
        n.isRead = false; // Guests always see broadcasts as unread
      }
      delete n.readBy; // the list of every customer who read a broadcast is not for customers
      return n;
    });
  }

  /**
   * Mark a notification as read
   */
  async markAsRead(notificationId, customerId) {
    const AppError = require('../../common/errors/app-error');
    const notification = await Notification.findById(notificationId);
    if (!notification) throw new AppError('Notification not found', 404);

    if (notification.target === 'all') {
      // $addToSet is atomic and never duplicates the reader.
      await Notification.updateOne({ _id: notification._id }, { $addToSet: { readBy: customerId } });
    } else {
      // Someone else's notification is reported as "not found", never confirmed to exist.
      if (!notification.customerId || notification.customerId.toString() !== customerId.toString()) {
        throw new AppError('Notification not found', 404);
      }
      notification.isRead = true;
      await notification.save();
    }
    const n = notification.toJSON();
    if (n.target === 'all') n.isRead = true;
    delete n.readBy; // other customers' ids are never sent to a customer
    return n;
  }

  /**
   * Send a push notification via Expo Push API
   */
  async _sendExpoPushNotification(tokens, title, body, data) {
    if (!tokens || tokens.length === 0) return;

    const messages = tokens.map(token => ({
      to: token,
      sound: 'default',
      title,
      body,
      data: data || {},
    }));

    try {
      await axios.post('https://exp.host/--/api/v2/push/send', messages, {
        headers: {
          Accept: 'application/json',
          'Accept-encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        }
      });
    } catch (error) {
      console.error('Error sending Expo push notification:', error.message);
    }
  }

  /**
   * Create a notification and push it to devices
   */
  async createNotification(data) {
    const { target, customerId, title, body, payload } = data;
    const Customer = require('../../models/customer.model');
    const watiService = require('../../integrations/wati.service');

    const notification = new Notification({
      target,
      customerId: target === 'specific' ? customerId : null,
      title,
      body,
      data: payload
    });

    await notification.save();

    // Fetch customer details if targeting a specific customer
    let customerPhone = null;
    if (customerId) {
      const customer = await Customer.findById(customerId);
      if (customer && customer.mobileNumber) {
        customerPhone = customer.mobileNumber;
      }
    }

    // Trigger Firebase Cloud Function for FCM Push Notifications (fire-and-forget)
    const FIREBASE_URL = process.env.FIREBASE_FUNCTIONS_URL || 'https://us-central1-mysawari-customer-app.cloudfunctions.net';
    
    if (target === 'all') {
      // Send to all customers via FCM topic
      axios.post(`${FIREBASE_URL}/sendToAllCustomers`, {
        title,
        body,
        data: payload || {}
      }).catch(err => console.error("Firebase broadcast failed:", err.message));
    } else if (target === 'specific' && customerPhone) {
      // Send to specific customer via FCM topic (customer_<mobile>)
      axios.post(`${FIREBASE_URL}/sendToSpecificCustomer`, {
        mobile: customerPhone,
        title,
        body,
        data: payload || {}
      }).catch(err => console.error("Firebase specific notification failed:", err.message));
    }

    // Trigger WATI message if configured in payload
    if (customerPhone && payload && payload.watiTemplate) {
      const watiParams = payload.watiParams || [];
      // Don't await this so it doesn't block the API response
      watiService.sendTemplateMessage(customerPhone, payload.watiTemplate, watiParams).catch(err => {
        console.error('WATI trigger failed:', err.message);
      });
    }

    return notification;
  }
}

module.exports = new NotificationService();
