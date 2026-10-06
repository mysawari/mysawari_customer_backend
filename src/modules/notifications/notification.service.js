const Notification = require('../../models/notification.model');
const CustomerDevice = require('../../models/customer_device.model');
const CustomerActivity = require('../../models/customer_activity.model');

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Initialize Firebase Admin locally instead of relying on Cloud Functions (avoids Blaze plan requirement)
let firebaseInitialized = false;
try {
  const serviceAccountPath = path.join(process.cwd(), 'firebase-key.json');
  if (fs.existsSync(serviceAccountPath)) {
    const serviceAccount = require(serviceAccountPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    firebaseInitialized = true;
    console.log('[Push] Firebase Admin initialized successfully.');
  } else {
    console.warn('[Push] firebase-key.json not found in backend root! Push notifications are DISABLED.');
  }
} catch (error) {
  console.error('[Push] Failed to initialize Firebase Admin:', error.message);
}

// Payload keys that drive the WhatsApp message on the server; they are never sent to the phone.
const SERVER_ONLY_KEYS = new Set(['watiTemplate', 'watiParams', 'guestSessionId']);

/** The anonymous id the app creates on first launch (services/api/activity.ts), before anyone logs in. */
const GUEST_SESSION_RE = /^session_[a-z0-9]{6,40}$/;
const isGuestSessionId = (v) => typeof v === 'string' && GUEST_SESSION_RE.test(v);

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

/** Sends push notification using Firebase Admin SDK directly; failures are logged, never thrown (best effort). */
async function callFirebase(fn, body) {
  if (!firebaseInitialized) {
    console.warn(`[Push] Cannot send "${body.title}", firebase-admin not initialized.`);
    return false;
  }
  
  try {
    let topic;
    if (fn === 'sendToAllCustomers') {
      topic = 'all_customers';
    } else if (fn === 'sendToSpecificCustomer') {
      topic = `customer_${body.mobile.replace(/[^a-zA-Z0-9-_.~%]/g, '')}`;
    } else if (fn === 'sendToAdmins') {
      topic = 'admin_notifications';
    } else {
      console.warn(`[Push] Unknown function name: ${fn}`);
      return false;
    }

    const message = {
      notification: {
        title: body.title,
        body: body.body,
      },
      data: body.data || {},
      topic: topic,
      android: {
        priority: 'high',
        notification: {
          sound: 'default'
        }
      },
      apns: {
        payload: {
          aps: {
            contentAvailable: true,
            sound: 'default'
          }
        }
      }
    };

    const response = await admin.messaging().send(message);
    return true;
  } catch (err) {
    console.error(`[Push] ${fn} failed:`, err.message);
    return false;
  }
}

class NotificationService {
  /**
   * Records that a one-off notification was sent, in the existing customer_activity collection, with the
   * customer's id and mobile number. Returns true only for the first caller, so the same event is never
   * pushed twice.
   */
  async claimOnce(action, details, customerId, mobileNumber) {
    const filter = { action };
    for (const [key, value] of Object.entries(details)) filter[`details.${key}`] = value;
    const existing = await CustomerActivity.findOneAndUpdate(
      filter,
      { $setOnInsert: { customerId: customerId || null, mobileNumber: mobileNumber || null } },
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
  async getNotifications(customerId, guestSessionId) {
    // Logged-in users see broadcasts + their own; a guest sees broadcasts + the ones sent to their install.
    const query = customerId
      ? { 
          $or: [
            { target: 'all', deletedBy: { $ne: customerId } }, 
            { customerId: customerId, deletedBy: { $ne: customerId } }
          ] 
        }
      : isGuestSessionId(guestSessionId)
        ? { $or: [{ target: 'all' }, { target: 'specific', customerId: null, 'data.guestSessionId': guestSessionId }] }
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
    delete n.deletedBy;
    return n;
  }

  /**
   * Clear all notifications for a customer
   */
  async clearAllNotifications(customerId) {
    if (!customerId) return { success: true };
    // Delete all specific notifications
    await Notification.deleteMany({ target: 'specific', customerId });
    // Add customerId to deletedBy for all broadcast notifications
    await Notification.updateMany({ target: 'all' }, { $addToSet: { deletedBy: customerId } });
    return { success: true };
  }

  /**
   * Create a notification and push it to devices
   */
  async createNotification(data) {
    const { target, customerId, title, body } = data;
    // A guest (installed, never logged in) is addressed by their install's session id.
    const guestSessionId = !customerId && isGuestSessionId(data.guestSessionId) ? data.guestSessionId : null;
    const payload = guestSessionId ? { ...(data.payload || {}), guestSessionId } : data.payload;
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
    } else if (target === 'specific' && guestSessionId) {
      // A guest's install subscribes to customer_guest_<session id>; the same function builds that topic.
      callFirebase('sendToSpecificCustomer', { mobile: `guest_${guestSessionId}`, title, body, data: pushData });
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
module.exports.isGuestSessionId = isGuestSessionId;
