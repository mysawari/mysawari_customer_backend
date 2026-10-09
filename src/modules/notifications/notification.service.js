const Notification = require('../../models/notification.model');
const CustomerDevice = require('../../models/customer_device.model');
const CustomerActivity = require('../../models/customer_activity.model');

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Initialize Firebase Admin locally instead of relying on Cloud Functions (avoids Blaze plan requirement)
let firebaseInitialized = false;
try {
  let serviceAccount = null;
  const serviceAccountPath = path.join(process.cwd(), 'firebase-key.json');

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // 1. Try to load from .env variable first (for production/cloud hosting)
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else if (fs.existsSync(serviceAccountPath)) {
    // 2. Fallback to local file if .env is not set
    serviceAccount = require(serviceAccountPath);
  }

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    firebaseInitialized = true;
    console.log('[Push] Firebase Admin initialized successfully.');
  } else {
    console.warn('[Push] Neither FIREBASE_SERVICE_ACCOUNT env var nor firebase-key.json found! Push notifications are DISABLED.');
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

/** Sends push notification using Firebase Admin SDK topics; failures are logged, never thrown (best effort). */
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
    console.log(`[Push] FCM topic "${topic}" sent OK:`, response);
    return true;
  } catch (err) {
    console.error(`[Push] ${fn} failed:`, err.message);
    return false;
  }
}

/**
 * Sends push notifications directly to registered Expo device tokens via Expo's push API.
 * This is the critical fallback: FCM topic subscriptions can silently fail, but the device
 * token is registered reliably when the app launches.  Both mechanisms fire in parallel
 * so the customer always gets the push.
 */
async function sendDirectPushToDevices(tokens, title, body, data) {
  if (!tokens || tokens.length === 0) return;
  const messages = tokens.map((token) => ({
    to: token,
    sound: 'default',
    title,
    body,
    data: data || {},
    priority: 'high',
    channelId: 'default',
  }));

  // Expo push API accepts batches of up to 100
  const BATCH = 100;
  for (let i = 0; i < messages.length; i += BATCH) {
    const batch = messages.slice(i, i + BATCH);
    try {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(batch),
      });
      const json = await res.json();
      // Log any ticket-level errors (expired tokens, etc.) so we can clean up stale devices
      if (json.data) {
        json.data.forEach((ticket, idx) => {
          if (ticket.status === 'error') {
            console.warn(`[Push][Expo] Token "${batch[idx].to}" error: ${ticket.message}`);
            // Clean up invalid tokens
            if (ticket.details?.error === 'DeviceNotRegistered') {
              CustomerDevice.deleteOne({ expoPushToken: batch[idx].to }).catch(() => {});
            }
          }
        });
      }
      console.log(`[Push][Expo] Sent ${batch.length} direct push(es)`);
    } catch (err) {
      console.error('[Push][Expo] Direct push failed:', err.message);
    }
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
  async registerDevice(customerId, expoPushToken, deviceType, guestSessionId) {
    let device = await CustomerDevice.findOne({ expoPushToken });
    if (device) {
      let needsSave = false;
      if ((!device.customerId && customerId) || (device.customerId && customerId && device.customerId.toString() !== customerId.toString())) {
        device.customerId = customerId;
        needsSave = true;
      } else if (!customerId && device.customerId) {
        // The phone re-registered without a login (logged out, or the session expired): it must stop
        // receiving the previous customer's booking pushes.
        device.customerId = undefined;
        needsSave = true;
      }
      if (guestSessionId && device.guestSessionId !== guestSessionId) {
        device.guestSessionId = guestSessionId;
        needsSave = true;
      }
      if (deviceType && device.deviceType !== deviceType) {
        device.deviceType = deviceType;
        needsSave = true;
      }
      if (needsSave) await device.save();
    } else {
      device = new CustomerDevice({ customerId: customerId || undefined, guestSessionId: guestSessionId || undefined, expoPushToken, deviceType });
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

    // FCM push through Firebase Admin (fire-and-forget). The id lets the app open the right
    // screen when the customer taps the notification.
    const pushData = { ...toFcmData(payload), notificationId: String(notification._id) };

    // ── 1) FCM topic push (existing mechanism) ──
    if (target === 'all') {
      callFirebase('sendToAllCustomers', { title, body, data: pushData });
    } else if (target === 'specific' && customerPhone) {
      callFirebase('sendToSpecificCustomer', { mobile: customerPhone, title, body, data: pushData });
    } else if (target === 'specific' && guestSessionId) {
      callFirebase('sendToSpecificCustomer', { mobile: `guest_${guestSessionId}`, title, body, data: pushData });
    } else if (target === 'specific') {
      console.warn(`[Push] No customer phone for "${title}" (customerId: ${customerId || 'none'}) — FCM topic push skipped`);
    }

    // ── 2) Direct Expo push to registered device tokens (critical fallback) ──
    // FCM topic subscriptions can silently fail. The Expo device token is registered reliably
    // at app launch, so this guarantees the push always reaches the customer's phone.
    try {
      let deviceTokens = [];
      if (target === 'specific' && customerId) {
        // All devices registered by this customer
        const devices = await CustomerDevice.find({ customerId }).select('expoPushToken').lean();
        deviceTokens = devices.map(d => d.expoPushToken).filter(Boolean);
      } else if (target === 'specific' && !customerId && guestSessionId) {
        // Guest: find devices registered with this guest session ID
        const devices = await CustomerDevice.find({ guestSessionId }).select('expoPushToken').lean();
        deviceTokens = devices.map(d => d.expoPushToken).filter(Boolean);
      } else if (target === 'all') {
        // Broadcast: send to ALL registered device tokens
        const devices = await CustomerDevice.find({}).select('expoPushToken').lean();
        deviceTokens = devices.map(d => d.expoPushToken).filter(Boolean);
      }

      if (deviceTokens.length > 0) {
        // Fire-and-forget: don't block the response
        sendDirectPushToDevices(deviceTokens, title, body, pushData).catch(err => {
          console.error('[Push][Expo] Direct push delivery failed:', err.message);
        });
      }
    } catch (err) {
      console.error('[Push][Expo] Failed to query device tokens:', err.message);
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
