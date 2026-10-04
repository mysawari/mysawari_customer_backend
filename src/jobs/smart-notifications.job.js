const mongoose = require('mongoose');
const CustomerActivity = require('../models/customer_activity.model');
const Booking = require('../models/booking.model');
const Customer = require('../models/customer.model');
const notificationService = require('../modules/notifications/notification.service');

// No schema changes: "already sent" is recorded as a CustomerActivity entry (sent_*_notif), and events are
// found by looking back over a window that is wider than the job interval, so a slow run, a restart or a
// sleeping server never makes an event slip through. The sent_* records keep every event to one push.
//
// Bookings and handovers carry the customer's phone number, not a customer id (the operations app creates
// most of them), so the customer is always found by phone.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TRANSACTIONAL_LOOKBACK_MS = 15 * MINUTE;
const LATE_AFTER_MS = HOUR; // overdue by more than this → reminder
const LATE_REMIND_EVERY_MS = 6 * HOUR;
const LATE_STOP_AFTER_MS = 7 * DAY; // a handover the team never closed must not be nagged about forever

/** The ways one Indian mobile number can be written (operations-app records aren't always normalised). */
function phoneVariants(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  const digits = s.replace(/\D/g, '');
  const last10 = digits.slice(-10);
  if (last10.length !== 10) return [s];
  return [...new Set([s, digits, last10, `91${last10}`, `+91${last10}`, `+91 ${last10}`])];
}

/** The customer-app account for this phone number, or null when the person has never signed in to the app. */
async function findCustomerByPhone(raw) {
  const variants = phoneVariants(raw);
  if (!variants.length) return null;
  return Customer.findOne({ mobileNumber: { $in: variants } }).select('_id mobileNumber').lean();
}

async function bookingForHandover(handover) {
  if (!handover.bookingId || !mongoose.isValidObjectId(handover.bookingId)) return null;
  return Booking.findById(handover.bookingId).select('mobileNumber vehicleName').lean();
}

/** Customer + vehicle name for a handover, from its booking or (walk-in handovers) from the handover itself. */
async function handoverContext(handover) {
  const booking = await bookingForHandover(handover);
  const customer = await findCustomerByPhone(booking?.mobileNumber || handover.customer?.mobileNumber);
  const vehicleName = booking?.vehicleName || handover.vehicle?.vehicleName || 'vehicle';
  return { booking, customer, vehicleName };
}

function marketingMessage(act) {
  const d = act.details || {};
  switch (act.action) {
    case 'initiate_checkout':
    case 'start_booking':
      return { title: 'Still thinking about your trip? 🤔', body: 'Your selected vehicle is waiting! Complete your booking before it gets rented out.' };
    case 'view_car':
      return { title: `Still thinking about the ${d.carName || 'car'}?`, body: "Book it before it's gone! Vehicles like this sell out fast on MySawari." };
    case 'search_query':
      if (d.query) return { title: `Looking for a ride in ${d.query}? 📍`, body: `Check out our best vehicles available around ${d.query} today!` };
      break;
    case 'view_offer':
      if (d.offerCode) return { title: 'Don’t forget your discount! 🎁', body: `Use code ${d.offerCode} to get a discount on your next ride.` };
      break;
    case 'view_destination':
      if (d.destination) return { title: `Planning a trip to ${d.destination}? 🏔️`, body: `Book a comfortable ride with MySawari and make your trip to ${d.destination} unforgettable!` };
      break;
    case 'view_special_deal':
      if (d.dealTitle) return { title: 'Special Deal just for you! 🌟', body: `Book the ${d.dealTitle} before the offer expires!` };
      break;
  }
  return { title: 'Plan your next trip! 🚗', body: 'We have some great vehicles waiting for you.' };
}

let smartRunning = false;
const sendSmartNotifications = async () => {
  if (smartRunning) return; // a slow run must not overlap the next one (it would double-send)
  smartRunning = true;
  try {
    // 1. Abandoned checkout & contextual marketing: customers who browsed, searched or started checkout
    //    15–45 minutes ago and haven't booked since. At most one of these per customer per day.
    const fifteenMinutesAgo = new Date(Date.now() - 15 * MINUTE);
    const fortyFiveMinutesAgo = new Date(Date.now() - 45 * MINUTE);
    const recentActivities = await CustomerActivity.aggregate([
      {
        $match: {
          action: { $in: ['initiate_checkout', 'start_booking', 'view_car', 'search_query', 'view_offer', 'view_special_deal', 'view_destination'] },
          createdAt: { $gte: fortyFiveMinutesAgo, $lte: fifteenMinutesAgo },
          customerId: { $ne: null }
        }
      },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$customerId', lastActivity: { $first: '$$ROOT' } } }
    ]);

    for (const group of recentActivities) {
      try {
        const act = group.lastActivity;
        const customer = await Customer.findById(act.customerId).select('_id mobileNumber').lean();
        if (!customer) continue;

        // Any booking attempt since they were browsing (bookings are stored by phone number).
        const recentBooking = await Booking.exists({ mobileNumber: { $in: phoneVariants(customer.mobileNumber) }, createdAt: { $gte: fortyFiveMinutesAgo } });
        if (recentBooking) continue;

        const recentNotif = await CustomerActivity.exists({
          action: 'sent_marketing_notif',
          customerId: customer._id,
          createdAt: { $gte: new Date(Date.now() - DAY) }
        });
        if (recentNotif) continue;

        const { title, body } = marketingMessage(act);
        await CustomerActivity.create({ action: 'sent_marketing_notif', customerId: customer._id });
        await notificationService.createNotification({
          target: 'specific', customerId: customer._id, title, body, payload: act.details
        });
      } catch (err) {
        console.error('[SmartNotifJob] Marketing notification failed:', err.message);
      }
    }

    // 2. Late returns: the vehicle is still out more than an hour after its drop time. Reminded every 6 hours.
    const handovers = mongoose.connection.db.collection('handovers');
    const activeHandovers = await handovers.find(
      { handoverStatus: 'active', isDeleted: { $ne: true } },
      { projection: { bookingId: 1, 'trip.dropDateTime': 1, 'customer.mobileNumber': 1, 'vehicle.vehicleName': 1 } }
    ).toArray();

    const now = Date.now();
    for (const handover of activeHandovers) {
      try {
        // Compared in code: the drop time may be stored as a date or as a date string.
        const dropAt = new Date(handover.trip?.dropDateTime).getTime();
        if (!Number.isFinite(dropAt)) continue;
        const overdueMs = now - dropAt;
        if (overdueMs <= LATE_AFTER_MS || overdueMs > LATE_STOP_AFTER_MS) continue;

        const recentNotif = await CustomerActivity.exists({
          action: 'sent_late_notif',
          'details.handoverId': handover._id,
          createdAt: { $gte: new Date(now - LATE_REMIND_EVERY_MS) }
        });
        if (recentNotif) continue;

        const { booking, customer, vehicleName } = await handoverContext(handover);
        if (!customer) continue;

        await CustomerActivity.create({ action: 'sent_late_notif', customerId: customer._id, details: { handoverId: handover._id } });
        await notificationService.createNotification({
          target: 'specific', customerId: customer._id,
          title: 'Late Return Reminder',
          body: `Your rental for ${vehicleName} is overdue. Please return or extend your booking to avoid penalties.`,
          payload: booking ? { bookingId: booking._id } : undefined
        });
      } catch (err) {
        console.error('[SmartNotifJob] Late return notification failed:', err.message);
      }
    }
  } catch (error) {
    console.error('[SmartNotifJob] Error:', error.message);
  } finally {
    smartRunning = false;
  }
};

let transactionalRunning = false;
const sendTransactionalNotifications = async () => {
  if (transactionalRunning) return;
  transactionalRunning = true;
  try {
    const since = new Date(Date.now() - TRANSACTIONAL_LOOKBACK_MS);

    // 1. Cancelled bookings (mostly cancelled by the operations team; a customer's own cancellation is
    //    already pushed by the cancel endpoint, which claims the same sent_cancel_notif record first).
    const cancelledBookings = await Booking.find({ status: 'cancelled', updatedAt: { $gte: since }, isDeleted: { $ne: true } })
      .select('mobileNumber vehicleName expiresAt payment.paymentStatus')
      .lean();
    for (const booking of cancelledBookings) {
      try {
        // An unpaid checkout hold that was closed or replaced is not a booking the customer ever had.
        if (booking.expiresAt && booking.payment?.paymentStatus !== 'paid') continue;
        const customer = await findCustomerByPhone(booking.mobileNumber);
        if (!customer) continue;
        if (!(await notificationService.claimOnce('sent_cancel_notif', { bookingId: booking._id }, customer._id))) continue;
        await notificationService.createNotification({
          target: 'specific', customerId: customer._id,
          title: 'Booking Cancelled', body: `Your booking for ${booking.vehicleName || 'your vehicle'} has been cancelled.`,
          payload: { bookingId: booking._id }
        });
      } catch (err) {
        console.error('[TransactionalNotifJob] Cancel notification failed:', err.message);
      }
    }

    const handovers = mongoose.connection.db.collection('handovers');
    const projection = { projection: { bookingId: 1, 'customer.mobileNumber': 1, 'vehicle.vehicleName': 1 } };

    // 2. Trip started: the operations team handed the vehicle over.
    const startedHandovers = await handovers.find({ handoverStatus: 'active', isDeleted: { $ne: true }, createdAt: { $gte: since } }, projection).toArray();
    for (const handover of startedHandovers) {
      try {
        const { booking, customer, vehicleName } = await handoverContext(handover);
        if (!customer) continue;
        if (!(await notificationService.claimOnce('sent_started_notif', { handoverId: handover._id }, customer._id))) continue;
        await notificationService.createNotification({
          target: 'specific', customerId: customer._id,
          title: 'Trip Started! 🚗', body: `Your vehicle ${vehicleName} has been successfully handed over to you. Have a safe trip!`,
          payload: booking ? { bookingId: booking._id } : undefined
        });
      } catch (err) {
        console.error('[TransactionalNotifJob] Trip started notification failed:', err.message);
      }
    }

    // 3. Trip completed: the vehicle came back.
    const returnedHandovers = await handovers.find({ handoverStatus: 'returned', isDeleted: { $ne: true }, updatedAt: { $gte: since } }, projection).toArray();
    for (const handover of returnedHandovers) {
      try {
        const { booking, customer } = await handoverContext(handover);
        if (!customer) continue;
        if (!(await notificationService.claimOnce('sent_returned_notif', { handoverId: handover._id }, customer._id))) continue;
        await notificationService.createNotification({
          target: 'specific', customerId: customer._id,
          title: 'Trip Completed ✅', body: 'Thank you for riding with MySawari! We hope you enjoyed the trip. Please leave a review.',
          payload: booking ? { bookingId: booking._id } : undefined
        });
      } catch (err) {
        console.error('[TransactionalNotifJob] Trip completed notification failed:', err.message);
      }
    }
  } catch (error) {
    console.error('[TransactionalNotifJob] Error:', error.message);
  } finally {
    transactionalRunning = false;
  }
};

const startSmartNotificationJobs = () => {
  console.log('⏱️  Starting Smart Push Notifications Background Jobs');
  // Marketing, abandonment and late returns run every 15 minutes
  setInterval(sendSmartNotifications, 15 * MINUTE);
  setTimeout(sendSmartNotifications, 2 * MINUTE);

  // Transactional (cancelled / trip started / trip completed) runs every minute for a near-instant feel
  setInterval(sendTransactionalNotifications, MINUTE);
};

module.exports = { startSmartNotificationJobs, phoneVariants };
