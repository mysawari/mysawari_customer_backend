const AppError = require('../../common/errors/app-error');
const { BOOKING_ADVANCE_AMOUNT } = require('./booking.constants');

// Shared money / input rules for creating bookings. Every amount the app sends is re-derived here
// from the vehicle's real price, and anything that can't be re-derived is bounded, so a modified
// client can't write its own "paid", "balance" or "collected" figures into a booking.

const DAY_MS = 24 * 60 * 60 * 1000;
const DRIVER_RATE_PER_DAY = 1400;
// Same rule the app applies: SawariCash covers at most 10% of the rent, and never more than ₹50 per trip.
const SAWARI_CASH_RATE = 0.10;
const SAWARI_CASH_CAP = 50;
const MAX_SERVICE_CHARGE = 50000;
const PER_TRIP_MEMBERSHIP_CAP = 999;
const MEMBERSHIP_PLANS = {
  starter: { discountRate: 0.05, annualCap: 10000 },
  plus: { discountRate: 0.10, annualCap: 15000 },
  pro: { discountRate: 0.125, annualCap: 20000 },
};
const TIME_RE = /^(0?[1-9]|1[0-2]):[0-5]\d\s?(AM|PM)$/i;

const cleanText = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Only https links are kept — the operations app opens this, so `javascript:` etc. must never get through. */
const cleanMapLink = (v) => {
  const s = cleanText(v, 500);
  return /^https:\/\/[^\s<>"']+$/i.test(s) ? s : '';
};

function money(value, field, max = MAX_SERVICE_CHARGE) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new AppError(`Invalid ${field}`, 400);
  return Math.round(n);
}

function cleanPlace(place, charge) {
  const p = place && typeof place === 'object' ? place : {};
  return {
    location: cleanText(p.location, 200),
    landmark: cleanText(p.landmark, 200),
    mapLink: cleanMapLink(p.mapLink),
    charge,
  };
}

function cleanTime(value, fallback) {
  const s = cleanText(value, 10);
  if (!s) return fallback;
  if (!TIME_RE.test(s)) throw new AppError('Invalid pickup / drop time', 400);
  return s.toUpperCase();
}

/** Validated dates + duration for a new booking. */
function parseTrip(body, { allowSameInstant = false } = {}) {
  const from = new Date(body.fromDate);
  const to = new Date(body.toDate);
  const badOrder = allowSameInstant ? to < from : to <= from;
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || badOrder) {
    throw new AppError('Invalid booking dates', 400);
  }
  if (from < new Date(Date.now() - DAY_MS)) throw new AppError('Pickup date cannot be in the past', 400);
  if (to.getTime() - from.getTime() > 180 * DAY_MS) throw new AppError('Bookings can be at most 180 days long', 400);

  const baseDays = Math.max(1, Math.round((to - from) / DAY_MS));
  const days = Number(body.totalDays);
  if (!Number.isInteger(days) || days < baseDays || days > baseDays + 1) {
    throw new AppError('Booking duration does not match the selected dates', 400);
  }
  return { from, to, days };
}

function membershipDiscountFor(base, membership) {
  const plan = membership && MEMBERSHIP_PLANS[membership.plan];
  const active = plan && membership.expiresAt && new Date(membership.expiresAt) > new Date();
  if (!active) return 0;
  const remaining = Math.max(0, plan.annualCap - (membership.totalSaved || 0));
  return Math.min(Math.round(base * plan.discountRate), PER_TRIP_MEMBERSHIP_CAP, remaining);
}

/**
 * Re-derives every amount of a booking from the vehicle price and checks the app's figures against it.
 * The app doesn't send the driver option separately, so both "self drive" and "with driver" are tried;
 * whichever one reproduces the app's membership discount AND balance is the booking that was priced.
 */
function resolveAmounts({ body, pricePerDay, days, discount, membership }) {
  const payment = body.payment && typeof body.payment === 'object' ? body.payment : {};
  const expectedTotal = pricePerDay * days;
  if (Number(payment.totalAmount) !== expectedTotal) {
    throw new AppError('Booking amount does not match the vehicle price', 400);
  }

  const sawariCashUsed = money(body.sawariCashUsed, 'SawariCash amount', 100000);
  const maxSawariCash = Math.min(expectedTotal * SAWARI_CASH_RATE, SAWARI_CASH_CAP);
  if (sawariCashUsed > maxSawariCash) throw new AppError('SawariCash usage limit exceeded', 400);

  const paidOnline = money(payment.bookingAmountPaid, 'booking amount', 100000);
  if (paidOnline + sawariCashUsed <= 0) throw new AppError('A booking advance is required', 400);

  const rentalAfterDiscount = Math.max(0, expectedTotal - discount);
  const appliedToAdvance = Math.min(sawariCashUsed, BOOKING_ADVANCE_AMOUNT);
  const requiredOnline = Math.max(0, Math.min(rentalAfterDiscount, BOOKING_ADVANCE_AMOUNT) - appliedToAdvance);
  if (paidOnline !== requiredOnline) {
    throw new AppError(`The online booking advance must be ₹${requiredOnline}`, 400);
  }

  const pickupCharge = money(payment.pickupCharge ?? body.pickup?.charge, 'pickup charge');
  const dropCharge = money(payment.dropCharge ?? body.drop?.charge, 'drop charge');
  const clientSubscription = money(body.subscriptionDiscount, 'membership discount', 100000);
  const hasClientBalance = payment.balanceAmount !== undefined && payment.balanceAmount !== null && payment.balanceAmount !== '';
  const clientBalance = hasClientBalance ? money(payment.balanceAmount, 'balance amount', 10000000) : null;

  for (const driverCharge of [0, DRIVER_RATE_PER_DAY * days]) {
    const base = Math.max(0, expectedTotal + driverCharge - discount);
    const subscriptionDiscount = membershipDiscountFor(base, membership);
    if (subscriptionDiscount !== clientSubscription) continue;
    const balanceAmount = Math.max(0, base + pickupCharge + dropCharge - subscriptionDiscount - paidOnline - sawariCashUsed);
    if (clientBalance !== null && Math.abs(clientBalance - balanceAmount) > 1) continue;
    return {
      expectedTotal, discount, sawariCashUsed, paidOnline, pickupCharge, dropCharge,
      driverCharge, subscriptionDiscount, balanceAmount, vehicleRent: base,
    };
  }
  throw new AppError('Booking amounts do not match — please refresh and try again', 400);
}

/** The booking document's customer-supplied parts, built only from validated values. */
function bookingFields(body, amounts, { paidStatus }) {
  return {
    pickupTime: cleanTime(body.pickupTime, '10:00 AM'),
    dropTime: cleanTime(body.dropTime, '10:00 AM'),
    destination: cleanText(body.destination, 200),
    pickup: cleanPlace(body.pickup, amounts.pickupCharge),
    drop: cleanPlace(body.drop, amounts.dropCharge),
    membershipDiscount: amounts.subscriptionDiscount,
    payment: {
      vehicleRent: amounts.vehicleRent,
      pickupCharge: amounts.pickupCharge,
      dropCharge: amounts.dropCharge,
      // Set by the operations team at handover, never by the customer.
      fastagAmount: 0,
      securityDeposit: 0,
      totalAmount: amounts.expectedTotal,
      discountAmount: amounts.discount,
      bookingAmountPaid: amounts.paidOnline,
      paymentMethod: amounts.paidOnline > 0 ? 'online' : 'wallet',
      balanceAmount: amounts.balanceAmount,
      paymentStatus: paidStatus,
    },
    paymentBreakdown: {
      cash: 0,
      phonePe: 0,
      razorpay: amounts.paidOnline,
      balanceAmount: amounts.balanceAmount,
      totalCollected: paidStatus === 'paid' ? amounts.paidOnline : 0,
      paymentStatus: paidStatus === 'paid' ? 'partial' : 'pending',
    },
  };
}

module.exports = {
  DAY_MS,
  DRIVER_RATE_PER_DAY,
  cleanText,
  money,
  parseTrip,
  resolveAmounts,
  bookingFields,
  membershipDiscountFor,
};
