const { stub, run } = require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert');
const BookingController = require('../../src/modules/bookings/booking.controller');
const Vehicle = require('../../src/models/vehicle.model');
const Booking = require('../../src/models/booking.model');
const Customer = require('../../src/models/customer.model');
const Membership = require('../../src/models/membership.model');
const Offer = require('../../src/models/offer.model');
const SawariCashTransaction = require('../../src/models/sawaricash_transaction.model');

const PCT15 = { code: 'PCT15', discountType: 'PERCENTAGE', discountValue: 15, minimumBooking: 0, maximumDiscount: null, expiryDate: new Date('2030-01-01'), active: true };

function setup(t) {
  const state = { saved: null };
  stub(t, Vehicle, {
    findOne: async () => ({ _id: '64b0000000000000000000aa', pricePerDay: 2345, vehicleName: 'Creta', status: 'available', __v: 1 }),
    updateOne: async () => ({ modifiedCount: 1 }),
  });
  stub(t, Booking, {
    exists: async () => null,
    find: () => ({ select: () => ({ lean: async () => [] }) }),
    create: async (doc) => { state.saved = doc; return { _id: 'b1', ...doc }; },
  });
  stub(t, Membership, { findOne: () => ({ lean: async () => null }) });
  stub(t, Customer, { findById: () => ({ select: () => ({ lean: async () => ({ walletBalance: 0 }) }) }) });
  stub(t, Offer, { findOne: (q) => ({ lean: async () => (q.code === 'PCT15' ? PCT15 : null) }) });
  stub(t, SawariCashTransaction, { create: async () => ({}) });
  return state;
}

// 3 days x ₹2,345 = ₹7,035 rent; 15% = 1055.25 -> ₹1,055 (rounded, on rent only, as the app now computes it).
function body(over = {}) {
  const from = new Date(Date.now() + 5 * 86400000);
  const rent = 7035;
  const discount = 1055;
  return {
    vehicleId: '64b0000000000000000000aa',
    fromDate: from.toISOString(),
    toDate: new Date(from.getTime() + 3 * 86400000).toISOString(),
    totalDays: 3,
    couponCode: 'pct15',
    payment: { totalAmount: rent, discountAmount: discount, bookingAmountPaid: 500, balanceAmount: rent - discount - 500 },
    sawariCashUsed: 0,
    subscriptionDiscount: 0,
    ...over,
  };
}
const user = { _id: '64b000000000000000000001', mobileNumber: '9876543210' };

test('a booking with a valid coupon is accepted and discounted by the server', async (t) => {
  const state = setup(t);
  const { res, err } = await run(new BookingController().createBookingHold, { body: body(), user });
  assert.strictEqual(err, null, err?.message);
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(state.saved.payment.discountAmount, 1055);
});

test('the old app behaviour (discount shown, code not sent) is rejected, not silently accepted', async (t) => {
  setup(t);
  const { err } = await run(new BookingController().createBookingHold, { body: body({ couponCode: undefined }), user });
  assert.strictEqual(err?.statusCode, 400);
});

test('a client cannot inflate the coupon discount', async (t) => {
  setup(t);
  const b = body();
  b.payment.discountAmount = 5000;
  b.payment.balanceAmount = 7035 - 5000 - 500;
  const { err } = await run(new BookingController().createBookingHold, { body: b, user });
  assert.strictEqual(err?.statusCode, 400);
});

test('an unknown coupon code is rejected', async (t) => {
  setup(t);
  const { err } = await run(new BookingController().createBookingHold, { body: body({ couponCode: 'FREE100' }), user });
  assert.strictEqual(err?.statusCode, 400);
});
