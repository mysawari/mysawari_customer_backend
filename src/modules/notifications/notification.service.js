const Notification = require('../../models/notification.model');
const CustomerDevice = require('../../models/customer_device.model');
const CustomerActivity = require('../../models/customer_activity.model');

// The Firebase project the app's google-services.json belongs to (mysawari-9dec1). The env var wins when set.
const FIREBASE_FUNCTIONS_URL = (process.env.FIREBASE_FUNCTIONS_URL || 'https://us-central1-mysawari-9dec1.cloudfunctions.net').replace(/\/+$/, '');

// Payload keys that drive the WhatsApp message on the server; they are never sent to the phone.
const SERVER_ONLY_KEYS = new Set(['watiTemplate', 'watiParams']);

/**
 * FCM rejects the WHOLE message when any `data` value is not a string (e.g. the booking confirmation's
 * watiParams array), so the push was silently never delivered. Only flat values are kept, as strings.
 */
function toFcmData(payload) {
  const data = {};
  if (!payload || typeof payload !== 'object') return data;
  for (const [key, value] of Object.entries(payload)) {
    if (SERVER_ONLY_KEYS.has(key) || value === null || value === undefined) continue;
    const isId = typeof value === 'object' && value._bsontype === 'ObjectId';
    if (typeof value === 'object' && !isId) continue;
    data[key] = String(value).slice(0, 500);
  }
  return data;
}

/** POSTs to one of the Firebase push functions; failures are logged, never thrown (pushes are best effort). */
async function callFirebase(fn, body) {
  try {
    const res = await fetch(`${FIREBASE_FUNCTIONS_URL}/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[Push] ${fn} failed (${res.status}): ${text.slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[Push] ${fn} failed:`, err.message);
    return false;
  }
}

class NotificationService {
  /**
   * Records that a one-off notification was sent, in the existing customer_activity collection.
   * Returns true only for the first caller, so the same event is never pushed twice.
   */
  async claimOnce(action, details, customerId) {
    const filter = { action };
    for (const [key, value] of Object.entries(details)) filter[`details.${key}`] = value;
    const existing = await CustomerActivity.findOneAndUpdate(
      filter,
      { $setOnInsert: { customerId: customerId || null } },
      { upsert: true, new: false }
    );
    return !existing;
  }

  /** Sends a push to the admins' topic (operations team). */
  async notifyAdmins(title, body, payload) {
    return callFirebase('sendToAdmins', { title, body, data: toFcmData(payload) });
  }

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

    // FCM push through the Firebase functions (fire-and-forget). The id lets the app open the right
    // screen when the customer taps the notification.
    const pushData = { ...toFcmData(payload), notificationId: String(notification._id) };
    if (target === 'all') {
      // Every install is subscribed to the all_customers topic
      callFirebase('sendToAllCustomers', { title, body, data: pushData });
    } else if (target === 'specific' && customerPhone) {
      // The app subscribes to customer_<mobile> at login
      callFirebase('sendToSpecificCustomer', { mobile: customerPhone, title, body, data: pushData });
    } else if (target === 'specific') {
      console.warn(`[Push] No customer phone for "${title}" (customerId: ${customerId || 'none'}) — push not sent`);
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
