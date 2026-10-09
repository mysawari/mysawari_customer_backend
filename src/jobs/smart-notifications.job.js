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

// ── Profile analysis ─────────────────────────────────────────────────────────
// What someone did in the app recently (logged in or not) is boiled down to their strongest interest,
// which then picks the push they get. Ordered strongest first: a started checkout beats a car viewed
// several times, which beats a search, a destination, a deal, an offer, and finally a plain welcome.

const BROWSE_ACTIONS = ['initiate_checkout', 'start_booking', 'payment_started', 'view_car', 'click_car', 'search_query',
  'view_offer', 'view_special_deal', 'view_destination', 'select_location', 'change_vehicle_type', 'trip_search', 'APP_OPENED'];
const SIGNUP_BONUS = 100; // every new account gets ₹100 SawariCash (auth.service verifyOtp)

/** Newest-first activity → the person's interests. */
function analyzeProfile(acts) {
  const cars = new Map(); // carId|name -> { name, views, lastAt }
  const p = { checkoutCarId: null, searches: [], destinations: [], deals: [], offers: [], opened: 0, browsed: 0 };
  for (const a of acts) {
    const d = a.details || {};
    switch (a.action) {
      case 'initiate_checkout': case 'start_booking': case 'payment_started':
        if (!p.checkoutCarId) p.checkoutCarId = d.carId || 'unknown';
        p.browsed++; break;
      case 'view_car': case 'click_car': {
        const key = d.carId || d.carName;
        if (!key) break;
        const c = cars.get(key) || { name: d.carName || '', views: 0, lastAt: a.createdAt };
        c.views++; if (!c.name && d.carName) c.name = d.carName;
        cars.set(key, c); p.browsed++; break;
      }
      case 'search_query': if (d.query && !p.searches.includes(d.query)) p.searches.push(String(d.query).slice(0, 40)); p.browsed++; break;
      // A full trip search (destination + dates) from the app: the destination is a strong interest.
      case 'trip_search': if (d.destination && !p.destinations.includes(d.destination)) p.destinations.unshift(String(d.destination).slice(0, 60)); p.browsed++; break;
      case 'view_destination': if (d.destination && !p.destinations.includes(d.destination)) p.destinations.push(d.destination); p.browsed++; break;
      case 'view_special_deal': if (d.dealTitle && !p.deals.includes(d.dealTitle)) p.deals.push(d.dealTitle); p.browsed++; break;
      case 'view_offer': if (d.offerCode && !p.offers.includes(d.offerCode)) p.offers.push(d.offerCode); p.browsed++; break;
      case 'APP_OPENED': p.opened++; break;
      default: p.browsed++;
    }
  }
  // Most viewed car; ties go to the most recently viewed (Map keeps first-seen order = newest first).
  let top = null;
  for (const [id, c] of cars) if (c.name && (!top || c.views > top.views)) top = { id, ...c };
  p.topCar = top;
  const checkoutCar = p.checkoutCarId && cars.get(p.checkoutCarId);
  p.checkoutCarName = (checkoutCar && checkoutCar.name) || (p.checkoutCarId ? top?.name : null) || null;
  return p;
}

/**
 * The pushes this profile deserves, best first. `key` identifies the subject, so the same message is never
 * repeated to one person. Guests are also told about the sign-up bonus, since they must log in to book.
 */
function profileMessages(p, { guest }) {
  const join = guest ? ` Sign up in 30 seconds and get ₹${SIGNUP_BONUS} SawariCash on your first ride.` : '';
  const out = [];
  if (p.checkoutCarId) {
    const car = p.checkoutCarName || 'Your vehicle';
    out.push({ key: `checkout:${p.checkoutCarId}`, carId: p.checkoutCarId, title: `${car} is still available 🚗`,
      body: guest ? `You were one step away!${join}` : 'You were one step away! Complete your booking before someone else books it.' });
  }
  if (p.topCar) {
    const many = p.topCar.views >= 2;
    out.push({ key: `car:${p.topCar.id}`, carId: p.topCar.id, title: many ? `You checked out the ${p.topCar.name} ${p.topCar.views} times 👀` : `Still thinking about the ${p.topCar.name}?`,
      body: `Book it before it's gone — vehicles like this get booked fast on MySawari.${join}` });
  }
  if (p.searches[0]) out.push({ key: `search:${p.searches[0].toLowerCase()}`, link: '/explore', title: `Looking for a ride in ${p.searches[0]}? 📍`, body: `Self-drive cars and bikes are ready around ${p.searches[0]}.${join}` });
  if (p.destinations[0]) out.push({ key: `dest:${p.destinations[0]}`, link: '/explore', title: `Planning a trip to ${p.destinations[0]}? 🏔️`, body: `Make it unforgettable with your own MySawari ride.${join}` });
  if (p.deals[0]) out.push({ key: `deal:${p.deals[0]}`, link: '/notifications', title: 'Special deal just for you! 🌟', body: `Book the ${p.deals[0]} before the offer expires.${join}` });
  if (p.offers[0]) out.push({ key: `offer:${p.offers[0]}`, link: '/notifications', title: 'Don’t forget your discount! 🎁', body: `Use code ${p.offers[0]} on your next ride.${join}` });
  if (guest) out.push({ key: 'welcome', link: '/', title: 'Welcome to MySawari! 🚗', body: `Self-drive cars and bikes across the Northeast.${join}` });
  return out;
}

const GUEST_QUIET_MS = 1 * MINUTE; // Reduced to 1 min for easier testing (originally 30 * MINUTE)
const GUEST_LOOKBACK_MS = 3 * DAY;  // only people who used the app recently
const GUEST_MAX_PUSHES = 3;
const GUEST_RUN_LIMIT = 300;

async function sendGuestNotifications() {
  const now = Date.now();
  const groups = await CustomerActivity.aggregate([
    { $match: { customerId: null, sessionId: { $regex: /^session_[a-z0-9]{6,40}$/ }, action: { $in: BROWSE_ACTIONS }, createdAt: { $gte: new Date(now - GUEST_LOOKBACK_MS) } } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$sessionId', lastAt: { $first: '$createdAt' }, acts: { $push: { action: '$action', details: '$details', createdAt: '$createdAt' } } } },
    { $match: { lastAt: { $lte: new Date(now - GUEST_QUIET_MS) } } },
    { $sort: { lastAt: -1 } },
    { $limit: GUEST_RUN_LIMIT },
    { $project: { lastAt: 1, acts: { $slice: ['$acts', 60] } } },
  ]);

  for (const g of groups) {
    try {
      const sessionId = g._id;
      // Logged in on this install at some point: they are a customer now, handled above.
      if (await CustomerActivity.exists({ sessionId, customerId: { $ne: null } })) continue;

      const sent = await CustomerActivity.find({ action: 'sent_guest_notif', sessionId }).select('details createdAt').lean();
      if (sent.length >= GUEST_MAX_PUSHES) continue;
      // if (sent.some((x) => now - new Date(x.createdAt).getTime() < DAY)) continue; // TEMPORARILY DISABLED FOR TESTING

      const used = new Set(sent.map((x) => x.details && x.details.key));
      const msg = profileMessages(analyzeProfile(g.acts), { guest: true }).find((m) => !used.has(m.key));
      if (!msg) continue;

      await CustomerActivity.create({ action: 'sent_guest_notif', sessionId, details: { key: msg.key } });
      await notificationService.createNotification({
        target: 'specific', customerId: null, guestSessionId: sessionId, title: msg.title, body: msg.body,
        payload: { kind: 'guest_engagement', link: msg.link, carId: msg.carId }, // carId: tapping opens that car
      });
    } catch (err) {
      console.error('[SmartNotifJob] Guest notification failed:', err.message);
    }
  }
}

let smartRunning = false;
const sendSmartNotifications = async () => {
  if (smartRunning) return; // a slow run must not overlap the next one (it would double-send)
  smartRunning = true;
  try {
    // 1. Abandoned checkout & contextual marketing: customers who browsed, searched or started checkout
    //    1–45 minutes ago and haven't booked since. At most one of these per customer per day.
    const fifteenMinutesAgo = new Date(Date.now() - 1 * MINUTE); // Reduced from 15 MINUTE for testing
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

        const history = await CustomerActivity.find({ customerId: customer._id, action: { $in: BROWSE_ACTIONS }, createdAt: { $gte: new Date(Date.now() - 7 * DAY) } })
          .sort({ createdAt: -1 }).limit(100).lean();
        const profileMessage = profileMessages(analyzeProfile(history), { guest: false })[0];
        const { title, body, link } = profileMessage || marketingMessage(act);
        await CustomerActivity.create({ action: 'sent_marketing_notif', customerId: customer._id, mobileNumber: customer.mobileNumber });
        await notificationService.createNotification({
          target: 'specific', customerId: customer._id, title, body, payload: { ...act.details, link, ...(profileMessage?.carId ? { carId: profileMessage.carId } : {}) }
        });
      } catch (err) {
        console.error('[SmartNotifJob] Marketing notification failed:', err.message);
      }
    }

    // 2. Guests: installed the app but never logged in. Their activity (by install session id) is analysed
    //    and they get the push that fits it best, once they have been away from the app for 30 minutes.
    //    At most one per 24 hours and three in total per install; never the same subject twice.
    await sendGuestNotifications();

    // 3. Late returns: the vehicle is still out more than an hour after its drop time. Reminded every 6 hours.
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

        await CustomerActivity.create({ action: 'sent_late_notif', customerId: customer._id, mobileNumber: customer.mobileNumber, details: { handoverId: handover._id } });
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
        if (!(await notificationService.claimOnce('sent_cancel_notif', { bookingId: booking._id }, customer._id, customer.mobileNumber))) continue;
        await notificationService.createNotification({
          target: 'specific', customerId: customer._id,
          title: 'Booking Cancelled', body: `Your booking for ${booking.vehicleName || 'your vehicle'} has been cancelled.`,
          payload: { bookingId: booking._id }
        });
      } catch (err) {
        console.error('[TransactionalNotifJob] Cancel notification failed:', err.message);
      }
    }

    // 2. Confirmed bookings entered by the operations team (they are created already confirmed). Bookings
    //    paid in the app are confirmed by the checkout endpoint, which claims the same sent_confirm_notif.
    const confirmedBookings = await Booking.find({ status: 'confirmed', createdAt: { $gte: since }, isDeleted: { $ne: true } })
      .select('mobileNumber vehicleName fromDate')
      .lean();
    for (const booking of confirmedBookings) {
      try {
        const customer = await findCustomerByPhone(booking.mobileNumber);
        if (!customer) continue;
        if (!(await notificationService.claimOnce('sent_confirm_notif', { bookingId: booking._id }, customer._id, customer.mobileNumber))) continue;
        const from = booking.fromDate ? new Date(booking.fromDate) : null;
        const when = from && !isNaN(from) ? ` for ${from.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}` : '';
        await notificationService.createNotification({
          target: 'specific', customerId: customer._id,
          title: 'Booking Confirmed! 🎉', body: `Your booking for ${booking.vehicleName || 'your vehicle'}${when} is confirmed.`,
          payload: { bookingId: booking._id }
        });
      } catch (err) {
        console.error('[TransactionalNotifJob] Confirmation notification failed:', err.message);
      }
    }

    const handovers = mongoose.connection.db.collection('handovers');
    const projection = { projection: { bookingId: 1, 'customer.mobileNumber': 1, 'vehicle.vehicleName': 1 } };

    // 3. Trip started: the operations team handed the vehicle over.
    const startedHandovers = await handovers.find({ handoverStatus: 'active', isDeleted: { $ne: true }, createdAt: { $gte: since } }, projection).toArray();
    for (const handover of startedHandovers) {
      try {
        const { booking, customer, vehicleName } = await handoverContext(handover);
        if (!customer) continue;
        if (!(await notificationService.claimOnce('sent_started_notif', { handoverId: handover._id }, customer._id, customer.mobileNumber))) continue;
        await notificationService.createNotification({
          target: 'specific', customerId: customer._id,
          title: 'Trip Started! 🚗', body: `Your vehicle ${vehicleName} has been successfully handed over to you. Have a safe trip!`,
          payload: booking ? { bookingId: booking._id } : undefined
        });
      } catch (err) {
        console.error('[TransactionalNotifJob] Trip started notification failed:', err.message);
      }
    }

    // 4. Trip completed: the vehicle came back.
    const returnedHandovers = await handovers.find({ handoverStatus: 'returned', isDeleted: { $ne: true }, updatedAt: { $gte: since } }, projection).toArray();
    for (const handover of returnedHandovers) {
      try {
        const { booking, customer } = await handoverContext(handover);
        if (!customer) continue;
        if (!(await notificationService.claimOnce('sent_returned_notif', { handoverId: handover._id }, customer._id, customer.mobileNumber))) continue;
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
  // Marketing, abandonment and late returns run every 1 minute (for testing, originally 15 mins)
  setInterval(sendSmartNotifications, 1 * MINUTE);
  setTimeout(sendSmartNotifications, 5 * 1000);

  // Transactional (confirmed / cancelled / trip started / trip completed) runs every minute for a near-instant feel
  setInterval(sendTransactionalNotifications, MINUTE);
};

module.exports = { startSmartNotificationJobs, phoneVariants, sendTransactionalNotifications, sendSmartNotifications, sendGuestNotifications, analyzeProfile, profileMessages };
