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
      if (device.customerId.toString() !== customerId.toString()) {
        device.customerId = customerId;
        device.deviceType = deviceType || device.deviceType;
        await device.save();
      }
    } else {
      device = new CustomerDevice({ customerId, expoPushToken, deviceType });
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
    const notifications = await Notification.find({
      $or: [
        { target: 'all' },
        { customerId: customerId }
      ]
    }).sort({ createdAt: -1 }).limit(50);
    
    // Map them to include dynamic isRead based on the readBy array for 'all'
    return notifications.map(notif => {
      const n = notif.toJSON();
      if (n.target === 'all') {
        n.isRead = notif.readBy.some((id) => String(id) === String(customerId));
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

    // Trigger Expo push
    let tokens = [];
    let customerPhone = null;

    if (target === 'all') {
      const devices = await CustomerDevice.find({}, 'expoPushToken');
      tokens = devices.map(d => d.expoPushToken);
    } else if (customerId) {
      const devices = await CustomerDevice.find({ customerId }, 'expoPushToken');
      tokens = devices.map(d => d.expoPushToken);
      
      // Fetch customer phone number for potential WATI message
      if (payload && payload.watiTemplate) {
        const customer = await Customer.findById(customerId);
        if (customer && customer.mobileNumber) {
          customerPhone = customer.mobileNumber;
        }
      }
    }

    if (tokens.length > 0) {
      // Chunking for Expo API limit (100 per request) is best practice, but kept simple here
      this._sendExpoPushNotification(tokens, title, body, payload);
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
