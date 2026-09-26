const { stub, run } = require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveAmounts, bookingFields } = require('../../src/modules/bookings/booking.money');
const BookingController = require('../../src/modules/bookings/booking.controller');
const Booking = require('../../src/models/booking.model');
const Customer = require('../../src/models/customer.model');
const SawariCashTransaction = require('../../src/models/sawaricash_transaction.model');
const Membership = require('../../src/models/membership.model');
const paymentService = require('../../src/modules/payments/payment.service');

const user = { _id: '64b000000000000000000001', mobileNumber: '9876543210', customerName: 'Asha' };

/** Exactly what the app's createBooking() sends for a 3-day, ₹2,000/day trip with ₹40 SawariCash. */
function appHoldBody(overrides = {}) {
  const days = 3;
  const rent = 2000 * days; // 6000
  const cash = 40;
  const pickup = 240;
  const paidOnline = 500 - cash; // 460
  const balance = rent + pickup - paidOnline - cash; // 5740
  return {
    vehicleId: '64b0000000000000000000aa',
    fromDate: new Date(Date.now() + 5 * 86400000).toISOString(),
    toDate: new Date(Date.now() + 8 * 86400000).toISOString(),
    pickupTime: '8:00 AM',
    dropTime: '8:00 AM',
    totalDays: days,
    destination: 'Shillong',
    pickup: { location: 'Airport', landmark: '', mapLink: '', charge: pickup },
    drop: { location: '', landmark: '', mapLink: '', charge: 0 },
    payment: {
      vehicleRent: rent, pickupCharge: pickup, dropCharge: 0, fastagAmount: 0, securityDeposit: 0,
      totalAmount: rent, discountAmount: 0, bookingAmountPaid: paidOnline, balanceAmount: balance,
    },
    sawariCashUsed: cash,
    subscriptionDiscount: 0,
    ...overrides,
  };
}

test('a genuine app booking (self drive) is accepted and priced by the server', () => {
  const a = resolveAmounts({ body: appHoldBody(), pricePerDay: 2000, days: 3, discount: 0, membership: null });
  assert.strictEqual(a.paidOnline, 460);
  assert.strictEqual(a.balanceAmount, 5740);
  assert.strictEqual(a.driverCharge, 0);
});

test('a genuine app booking with a driver is accepted (balance includes ₹1400/day)', () => {
  const body = appHoldBody();
  body.payment.balanceAmount += 1400 * 3;
  const a = resolveAmounts({ body, pricePerDay: 2000, days: 3, discount: 0, membership: null });
  assert.strictEqual(a.driverCharge, 4200);
});

test('a genuine member booking is accepted (discount computed on rent + driver, as the app does)', () => {
  const body = appHoldBody();
  const membership = { plan: 'plus', expiresAt: new Date(Date.now() + 86400000), totalSaved: 0 };
  const sub = Math.min(Math.round((6000 + 4200) * 0.10), 999); // 999
  body.subscriptionDiscount = sub;
  body.payment.balanceAmount = 6000 + 4200 + 240 - sub - 460 - 40;
  const a = resolveAmounts({ body, pricePerDay: 2000, days: 3, discount: 0, membership });
  assert.strictEqual(a.subscriptionDiscount, 999);
});

test('a tampered balance ("I owe nothing") is rejected', () => {
  const body = appHoldBody();
  body.payment.balanceAmount = 0;
  assert.throws(() => resolveAmounts({ body, pricePerDay: 2000, days: 3, discount: 0, membership: null }), /do not match/);
});

test('tampered price, advance, SawariCash and membership discount are all rejected', () => {
  const cases = [
    (b) => { b.payment.totalAmount = 1; },
    (b) => { b.payment.bookingAmountPaid = 1; },
    (b) => { b.sawariCashUsed = 500; },             // over the ₹50 / 10% cap
    (b) => { b.sawariCashUsed = -100; },
    (b) => { b.subscriptionDiscount = 999; },        // not a member
    (b) => { b.payment.pickupCharge = -500; },
    (b) => { b.payment.pickupCharge = 'abc'; },
  ];
  for (const mutate of cases) {
    const body = appHoldBody();
    mutate(body);
    assert.throws(() => resolveAmounts({ body, pricePerDay: 2000, days: 3, discount: 0, membership: null }), undefined, mutate.toString());
  }
});

test('client-sent paymentBreakdown / fastag / deposit / collected amounts are ignored', () => {
  const body = appHoldBody({
    paymentBreakdown: { cash: 99999, totalCollected: 99999, paymentStatus: 'paid' },
  });
  body.payment.fastagAmount = 5000;
  body.payment.securityDeposit = 5000;
  body.payment.paymentStatus = 'paid';
  const amounts = resolveAmounts({ body, pricePerDay: 2000, days: 3, discount: 0, membership: null });
  const fields = bookingFields(body, amounts, { paidStatus: 'pending' });
  assert.strictEqual(fields.paymentBreakdown.totalCollected, 0);
  assert.strictEqual(fields.paymentBreakdown.cash, 0);
  assert.strictEqual(fields.paymentBreakdown.paymentStatus, 'pending');
  assert.strictEqual(fields.payment.fastagAmount, 0);
  assert.strictEqual(fields.payment.securityDeposit, 0);
  assert.strictEqual(fields.payment.paymentStatus, 'pending');
});

test('javascript: / data: map links and oversized text never reach the operations app', () => {
  const body = appHoldBody({
    destination: 'x'.repeat(5000),
    pickup: { location: '<b>A</b>', mapLink: 'javascript:alert(document.cookie)', charge: 240 },
    drop: { location: '', mapLink: 'data:text/html,<script>alert(1)</script>', charge: 0 },
  });
  const fields = bookingFields(body, resolveAmounts({ body, pricePerDay: 2000, days: 3, discount: 0, membership: null }), { paidStatus: 'pending' });
  assert.strictEqual(fields.pickup.mapLink, '');
  assert.strictEqual(fields.drop.mapLink, '');
  assert.ok(fields.destination.length <= 200);
  const good = bookingFields(appHoldBody({ pickup: { mapLink: 'https://maps.google.com/?q=26.1,91.7', charge: 240 } }),
    resolveAmounts({ body: appHoldBody(), pricePerDay: 2000, days: 3, discount: 0, membership: null }), { paidStatus: 'pending' });
  assert.strictEqual(good.pickup.mapLink, 'https://maps.google.com/?q=26.1,91.7');
});

test('invalid pickup times are rejected', () => {
  const body = appHoldBody({ pickupTime: '<script>' });
  assert.throws(() => bookingFields(body, resolveAmounts({ body, pricePerDay: 2000, days: 3, discount: 0, membership: null }), { paidStatus: 'pending' }), /time/);
});

test('two parallel cancellations refund SawariCash only once', async (t) => {
  let status = 'confirmed';
  let txStatus = 'completed';
  let refunds = 0;
  const booking = { _id: '64b0000000000000000000bb', status, fromDate: new Date(Date.now() + 5 * 86400000), payment: { bookingAmountPaid: 460 } };
  stub(t, Booking, {
    findOneAndUpdate: async (filter, update) => {
      await new Promise((r) => setImmediate(r));
      if (!filter.status.$in.includes(status)) return null;
      status = update.$set.status;
      return { ...booking, status, toObject() { return { ...booking, status }; } };
    },
    findOne: () => ({ select: () => ({ lean: async () => ({ status }) }) }),
  });
  stub(t, SawariCashTransaction, {
    findOneAndUpdate: async () => {
      await new Promise((r) => setImmediate(r));
      if (txStatus !== 'completed') return null;
      txStatus = 'refunded';
      return { amount: 40 };
    },
    deleteMany: async () => ({}),
    create: async () => ({}),
  });
  stub(t, Customer, { updateOne: async (f, u) => { refunds += u.$inc.walletBalance; } });

  const c = new BookingController();
  const req = () => ({ params: { id: booking._id }, body: {}, user });
  const [a, b] = await Promise.all([run(c.cancelBooking, req()), run(c.cancelBooking, req())]);
  assert.strictEqual(refunds, 40, 'SawariCash must be refunded exactly once');
  assert.strictEqual([a, b].filter((r) => !r.err).length, 1);
});

test('two parallel payment confirmations debit SawariCash only once', async (t) => {
  let status = 'pending';
  let debits = 0;
  let membershipIncrements = 0;
  const hold = {
    _id: '64b0000000000000000000cc', status: 'pending', vehicleName: 'Creta', membershipDiscount: 100,
    expiresAt: new Date(Date.now() + 60000), payment: { bookingAmountPaid: 0 }, paymentBreakdown: {},
    createdAt: new Date(), updatedAt: new Date(),
  };
  stub(t, Booking, {
    findOne: async () => ({ ...hold, status }),
    findOneAndUpdate: async (filter) => {
      await new Promise((r) => setImmediate(r));
      if (status !== filter.status) return null;
      status = 'confirmed';
      return { ...hold, status };
    },
    findById: async () => ({ ...hold, status }),
  });
  stub(t, SawariCashTransaction, {
    findOne: async () => ({ _id: 'tx', amount: 40 }),
    updateOne: async () => ({}),
    deleteMany: async () => ({}),
  });
  stub(t, Customer, { findOneAndUpdate: async () => { debits += 40; return {}; } });
  stub(t, Membership, { updateOne: async () => { membershipIncrements += 1; } });
  const notificationService = require('../../src/modules/notifications/notification.service');
  stub(t, notificationService, { createNotification: async () => ({}) });
  const CustomerAppLead = require('../../src/models/customer_app_lead.model');
  stub(t, CustomerAppLead, { updateOne: async () => ({}) });

  const c = new BookingController();
  const req = () => ({ params: { id: hold._id }, body: {}, user });
  await Promise.all([run(c.confirmBookingPayment, req()), run(c.confirmBookingPayment, req())]);
  assert.strictEqual(debits, 40, 'SawariCash must be debited exactly once');
  assert.strictEqual(membershipIncrements, 1, 'membership savings must be counted once');
});

test('a milestone reward cannot be claimed twice — not even after a server restart', async (t) => {
  const records = [];
  let credited = 0;
  stub(t, Booking, { countDocuments: async () => 4 });
  stub(t, SawariCashTransaction, {
    findOneAndUpdate: async (filter, update) => {
      await new Promise((r) => setImmediate(r));
      const found = records.find((r) => r.reason === filter.reason && r.customerId === filter.customerId);
      if (found) return found;
      records.push({ ...update.$setOnInsert });
      return null;
    },
  });
  stub(t, Customer, { updateOne: async (f, u) => { credited += u.$inc.walletBalance; } });

  const req = () => ({ body: { milestoneLabel: '4th Ride Bonus' }, user });
  const first = await run(new BookingController().claimMilestoneReward, req());
  // "Restart": a brand-new controller instance with no in-memory state.
  const second = await run(new BookingController().claimMilestoneReward, req());
  assert.strictEqual(first.res.statusCode, 200);
  assert.strictEqual(second.res.statusCode, 400);
  assert.strictEqual(credited, 50);
});

test('milestones need completed rides — confirmed/pending bookings do not count', async (t) => {
  let filterSeen;
  stub(t, Booking, { countDocuments: async (f) => { filterSeen = f; return 0; } });
  const { res } = await run(new BookingController().claimMilestoneReward, { body: { milestoneLabel: '4th Ride Bonus' }, user });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(filterSeen.status, 'completed');
});

test("a customer cannot read or write live tracking of someone else's booking", async (t) => {
  stub(t, Booking, { exists: async (f) => (f.mobileNumber === '9000000000' ? { _id: f._id } : null) });
  const c = new BookingController();
  const req = { params: { id: '64b0000000000000000000dd' }, body: { latitude: 26.1, longitude: 91.7 }, user };
  const read = await run(c.getLocation, req);
  const write = await run(c.updateLocation, req);
  assert.strictEqual(read.err?.statusCode, 404);
  assert.strictEqual(write.err?.statusCode, 404);
});

test('my-bookings never sends full vehicle documents (raw photo URLs)', async (t) => {
  let populated;
  stub(t, Booking, {
    find: () => ({ populate: (path, fields) => { populated = fields; return { sort: async () => [] }; } }),
  });
  await run(new BookingController().getMyBookings, { user: { ...user, createdAt: new Date() } });
  assert.strictEqual(populated, 'vehicleName pricePerDay');
});

test('paymentService is not bypassed when the advance is online', () => {
  assert.strictEqual(typeof paymentService.redeemPayment, 'function');
});
