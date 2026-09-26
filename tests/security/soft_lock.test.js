const { stub, run } = require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert');
const BookingController = require('../../src/modules/bookings/booking.controller');
const Booking = require('../../src/models/booking.model');
const Vehicle = require('../../src/models/vehicle.model');
const Customer = require('../../src/models/customer.model');
const Membership = require('../../src/models/membership.model');
const SawariCashTransaction = require('../../src/models/sawaricash_transaction.model');
const CustomerAppLead = require('../../src/models/customer_app_lead.model');
const paymentService = require('../../src/modules/payments/payment.service');
const notificationService = require('../../src/modules/notifications/notification.service');

// ── A tiny in-memory MongoDB: enough of the query language to evaluate the real filters ──────────
const val = (v) => (v instanceof Date ? v.getTime() : v && v._bsontype ? String(v) : v);
function matchCond(docVal, cond) {
  if (cond instanceof Date || typeof cond !== 'object' || cond === null) {
    if (cond === null) return docVal === null || docVal === undefined;
    return String(val(docVal)) === String(val(cond));
  }
  return Object.entries(cond).every(([op, arg]) => {
    const d = val(docVal);
    switch (op) {
      case '$ne': return arg === null ? !(docVal === null || docVal === undefined) : String(d) !== String(val(arg));
      case '$gt': return d !== undefined && d > val(arg);
      case '$lt': return d !== undefined && d < val(arg);
      case '$gte': return d !== undefined && d >= val(arg);
      case '$lte': return d !== undefined && d <= val(arg);
      case '$in': return arg.map((x) => String(val(x))).includes(String(d));
      case '$nin': return !arg.map((x) => String(val(x))).includes(String(d));
      default: throw new Error(`unsupported ${op}`);
    }
  });
}
function matches(doc, filter) {
  return Object.entries(filter).every(([k, cond]) => {
    if (k === '$or') return cond.some((f) => matches(doc, f));
    if (k === '$and') return cond.every((f) => matches(doc, f));
    return matchCond(doc[k], cond);
  });
}

function world(t) {
  let now = Date.UTC(2026, 9, 1, 6, 0, 0);
  const clock = { now: () => now, advance: (ms) => { now += ms; } };
  const realNow = Date.now;
  Date.now = () => now;
  const RealDate = global.Date;
  global.Date = class extends RealDate {
    constructor(...a) { if (a.length === 0) super(now); else super(...a); }
    static now() { return now; }
  };
  t.after(() => { global.Date = RealDate; Date.now = realNow; });

  const bookings = [];
  let nextId = 1;
  const oid = () => `64b00000000000000000${String(nextId++).padStart(4, '0')}`;
  const touch = (b) => { b.updatedAt = new Date(now); };
  const applyUpdate = (b, u) => {
    for (const [k, v] of Object.entries(u.$set || {})) {
      if (k.includes('.')) { const [a, c] = k.split('.'); b[a] = { ...(b[a] || {}), [c]: v }; } else b[k] = v;
    }
    for (const k of Object.keys(u.$unset || {})) delete b[k];
    touch(b);
  };
  const q = (result) => ({ select: () => ({ lean: async () => result }), lean: async () => result, then: (r, j) => Promise.resolve(result).then(r, j) });

  stub(t, Booking, {
    exists: async (f) => (bookings.find((b) => matches(b, f)) ? { _id: 'x' } : null),
    find: (f) => q(bookings.filter((b) => matches(b, f)).map((b) => ({ ...b }))),
    findOne: (f) => q(bookings.find((b) => matches(b, f)) ? { ...bookings.find((b) => matches(b, f)) } : null),
    findById: async (id) => bookings.find((b) => b._id === String(id)) || null,
    create: async (doc) => {
      const b = { ...doc, _id: oid(), createdAt: new Date(now), updatedAt: new Date(now) };
      bookings.push(b);
      return { ...b };
    },
    updateOne: async (f, u) => { const b = bookings.find((x) => matches(x, f)); if (b) applyUpdate(b, u); return { modifiedCount: b ? 1 : 0 }; },
    updateMany: async (f, u) => { const list = bookings.filter((x) => matches(x, f)); list.forEach((b) => applyUpdate(b, u)); return { modifiedCount: list.length }; },
    findOneAndUpdate: async (f, u) => { const b = bookings.find((x) => matches(x, f)); if (!b) return null; applyUpdate(b, u); return { ...b }; },
  });

  let vehicleVersion = 1;
  stub(t, Vehicle, {
    findOne: async () => ({ _id: '64b0000000000000000000aa', pricePerDay: 2000, vehicleName: 'Creta', status: 'available', __v: vehicleVersion }),
    updateOne: async (f) => { if (f.__v !== vehicleVersion) return { modifiedCount: 0 }; vehicleVersion += 1; return { modifiedCount: 1 }; },
  });
  stub(t, Membership, { findOne: () => ({ lean: async () => null }) });
  stub(t, Customer, { findById: () => ({ select: () => ({ lean: async () => ({ walletBalance: 0 }) }) }) });
  stub(t, SawariCashTransaction, { create: async () => ({}), deleteMany: async () => ({}), findOne: async () => null });
  stub(t, CustomerAppLead, { updateOne: async () => ({}) });
  stub(t, notificationService, { createNotification: async () => ({}) });

  const refunds = [];
  stub(t, paymentService, {
    redeemPayment: async () => ({}),
    refundPayment: async (paymentId, amount) => { refunds.push({ paymentId, amount }); return 'rfnd_1'; },
    refundOrphanPayment: async ({ paymentId }) => { refunds.push({ paymentId, orphan: true }); return 'rfnd_2'; },
    releasePaymentAsync: async () => {},
  });

  return { clock, bookings, refunds };
}

const A = { _id: '64b000000000000000000001', mobileNumber: '9000000001', customerName: 'A' };
const B = { _id: '64b000000000000000000002', mobileNumber: '9000000002', customerName: 'B' };
const MIN = 60 * 1000;
const holdBody = () => {
  const from = new Date(Date.now() + 5 * 86400000);
  return {
    vehicleId: '64b0000000000000000000aa',
    fromDate: from.toISOString(),
    toDate: new Date(from.getTime() + 2 * 86400000).toISOString(),
    totalDays: 2,
    payment: { totalAmount: 4000, discountAmount: 0, bookingAmountPaid: 500, balanceAmount: 3500 },
    sawariCashUsed: 0,
    subscriptionDiscount: 0,
  };
};
const c = new BookingController();
const hold = (user) => run(c.createBookingHold, { body: holdBody(), user });
const confirm = (user, id) => run(c.confirmBookingPayment, {
  params: { id }, body: { razorpayOrderId: 'order_TEST123456', razorpayPaymentId: 'pay_TEST123456' }, user,
});
const keepAlive = (user, id) => run(c.keepHoldAlive, { params: { id }, user });
const release = (user, id) => run(c.releaseHold, { params: { id }, user });

test('first click wins: a second customer cannot hold the car while the first is checking out', async (t) => {
  world(t);
  const a = await hold(A);
  assert.strictEqual(a.err, null);
  assert.ok(a.res.body.data.lockedUntil);
  const b = await hold(B);
  assert.strictEqual(b.err?.statusCode, 409);
});

test('an abandoned checkout frees the car after 2 minutes', async (t) => {
  const { clock } = world(t);
  await hold(A);
  clock.advance(1.5 * MIN);
  assert.strictEqual((await hold(B)).err?.statusCode, 409);
  clock.advance(0.6 * MIN);
  assert.strictEqual((await hold(B)).err, null);
});

test('a customer who is actively paying keeps the car (keep-alive), up to 10 minutes', async (t) => {
  const { clock } = world(t);
  const a = await hold(A);
  const id = a.res.body.data._id;
  for (let i = 0; i < 6; i++) {
    clock.advance(1.5 * MIN);
    assert.strictEqual((await keepAlive(A, id)).res.body.data.locked, true);
    assert.strictEqual((await hold(B)).err?.statusCode, 409, `blocked at ${(i + 1) * 1.5} min`);
  }
  clock.advance(1.5 * MIN); // 10.5 min: past the hard cap
  assert.strictEqual((await keepAlive(A, id)).res.body.data.locked, false);
  assert.strictEqual((await hold(B)).err, null);
});

test('late payment, car still free: the booking is honoured, no refund', async (t) => {
  const { clock, bookings, refunds } = world(t);
  const a = await hold(A);
  clock.advance(6 * MIN); // lock lapsed, nobody else took the car
  const r = await confirm(A, a.res.body.data._id);
  assert.strictEqual(r.err, null);
  assert.strictEqual(bookings[0].status, 'confirmed');
  assert.deepStrictEqual(refunds, []);
});

test('late payment, car taken by someone else: hold cancelled and the payment refunded automatically', async (t) => {
  const { clock, bookings, refunds } = world(t);
  const a = await hold(A);
  clock.advance(3 * MIN);
  assert.strictEqual((await hold(B)).err, null); // B legitimately takes the car
  const r = await confirm(A, a.res.body.data._id);
  assert.strictEqual(r.err?.statusCode, 409);
  assert.match(r.err.message, /refunded automatically/);
  assert.strictEqual(bookings[0].status, 'cancelled');
  assert.deepStrictEqual(refunds, [{ paymentId: 'pay_TEST123456', amount: 500 }]);
});

test('payment for a hold whose record is already gone is refunded, never kept', async (t) => {
  const { refunds } = world(t);
  const r = await confirm(A, '64b0000000000000000009ff');
  assert.strictEqual(r.err?.statusCode, 409);
  assert.strictEqual(refunds[0].orphan, true);
});

test('one checkout at a time: a new hold releases the same customer’s previous hold', async (t) => {
  const { bookings } = world(t);
  await hold(A);
  await hold(A); // retry / different car
  assert.strictEqual(bookings.filter((b) => b.status === 'pending').length, 1);
  assert.strictEqual(bookings[0].status, 'cancelled');
});

test('closing the payment sheet frees the car immediately', async (t) => {
  world(t);
  const a = await hold(A);
  await release(A, a.res.body.data._id);
  assert.strictEqual((await hold(B)).err, null);
});

test('a customer cannot release someone else’s hold', async (t) => {
  world(t);
  const a = await hold(A);
  await release(B, a.res.body.data._id);
  assert.strictEqual((await hold(B)).err?.statusCode, 409);
});

test('pending bookings entered in the operations app always block the car', async (t) => {
  const { bookings, clock } = world(t);
  const from = new Date(Date.now() + 5 * 86400000);
  bookings.push({ _id: 'ops1', vehicleId: '64b0000000000000000000aa', status: 'pending', fromDate: from,
    toDate: new Date(from.getTime() + 2 * 86400000), createdAt: new Date(clock.now() - 60 * MIN), updatedAt: new Date(clock.now() - 60 * MIN) });
  assert.strictEqual((await hold(A)).err?.statusCode, 409);
});
