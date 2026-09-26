const { stub, run } = require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert');
const paymentService = require('../../src/modules/payments/payment.service');
const { resolveTarget } = require('../../src/modules/images/image.controller');
const WalletController = require('../../src/modules/wallet/wallet.controller');
const Customer = require('../../src/models/customer.model');
const SawariCashTransaction = require('../../src/models/sawaricash_transaction.model');
const Membership = require('../../src/models/membership.model');
const CouponService = require('../../src/modules/coupons/coupon.service');
const Offer = require('../../src/models/offer.model');
const CustomerAppLead = require('../../src/models/customer_app_lead.model');
const leadController = require('../../src/modules/leads/lead.controller');

const CUSTOMER = '64b000000000000000000001';

/** A fake Razorpay account holding one order + payment. */
function fakeRazorpay(t, { status = 'captured', amount = 50000, orderCustomer = CUSTOMER, notes = {} } = {}) {
  const state = { captured: 0, notes: { customerId: orderCustomer, ...notes } };
  const rp = {
    payments: {
      fetch: async () => ({ id: 'pay_TEST123456', status, amount, currency: 'INR', order_id: 'order_TEST123456' }),
      capture: async () => { state.captured += 1; },
    },
    orders: {
      fetch: async () => ({ id: 'order_TEST123456', amount, notes: { ...state.notes } }),
      edit: async (id, { notes: n }) => { state.notes = n; },
    },
  };
  const original = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(paymentService), 'razorpay');
  Object.defineProperty(paymentService, 'razorpay', { get: () => rp, configurable: true });
  t.after(() => { delete paymentService.razorpay; if (!original) return; });
  return state;
}

const redeem = (over = {}) => paymentService.redeemPayment({
  customerId: CUSTOMER, orderId: 'order_TEST123456', paymentId: 'pay_TEST123456', amountRupees: 500, ...over,
});

test('a payment can be used once, and stays used after a restart (mark lives on the Razorpay order)', async (t) => {
  const state = fakeRazorpay(t);
  await redeem();
  assert.strictEqual(state.notes.redeemed, 'yes');
  // Simulate a restart: the in-memory list is empty, but the order still says "redeemed".
  paymentService.releasePayment('pay_TEST123456');
  await assert.rejects(redeem(), /already been used/);
});

test('parallel use of the same payment: only one succeeds', async (t) => {
  fakeRazorpay(t);
  const results = await Promise.allSettled([redeem(), redeem(), redeem()]);
  assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 1);
  paymentService.releasePayment('pay_TEST123456');
});

test("someone else's payment, a wrong amount, or a malformed id is rejected", async (t) => {
  fakeRazorpay(t, { orderCustomer: '64b0000000000000000000ff' });
  await assert.rejects(redeem(), /does not belong/);
  await assert.rejects(redeem({ amountRupees: 1 }), /does not belong|amount/);
  await assert.rejects(redeem({ paymentId: { $ne: null } }), /required/);
  await assert.rejects(redeem({ orderId: 'order_x/../admin' }), /Invalid payment/);
});

test('an authorized-only payment is captured (otherwise Razorpay would auto-refund it)', async (t) => {
  const state = fakeRazorpay(t, { status: 'authorized' });
  await redeem();
  assert.strictEqual(state.captured, 1);
  paymentService.releasePayment('pay_TEST123456');
});

test('a failed or unpaid payment is refused', async (t) => {
  fakeRazorpay(t, { status: 'failed' });
  await assert.rejects(redeem(), /not been completed/);
});

test('signature check handles a missing signature without crashing', () => {
  assert.strictEqual(paymentService.verifySignature('order_1', 'pay_1', undefined), false);
});

test('image proxy target rules: no Host trust, no internal targets, no self-recursion', () => {
  process.env.IMAGE_PROXY_ALLOWED_HOSTS = '';
  const rejected = [
    'http://169.254.169.254/latest/meta-data/',
    'https://127.0.0.1/uploads/../../etc/passwd',
    '/uploads/../../etc/passwd',
    '/uploads/%2e%2e/secret',
    '/api/images/blur?target=/uploads/a.jpg',
    'http://res.cloudinary.com/x/image/upload/a.jpg',
    'https://res.cloudinary.com/x/raw/upload/a.pdf',
    'https://user:pass@res.cloudinary.com/x/image/upload/a.jpg',
    'https://res.cloudinary.com:8443/x/image/upload/a.jpg',
    'gopher://127.0.0.1:6379/_FLUSHALL',
    'x'.repeat(3000),
  ];
  for (const target of rejected) assert.strictEqual(resolveTarget(target), null, target);

  assert.strictEqual(resolveTarget('https://res.cloudinary.com/mysawari/image/upload/v1/cars/a.jpg'),
    'https://res.cloudinary.com/mysawari/image/upload/v1/cars/a.jpg');
  // Our own uploads always go to the trusted internal address, whatever host was in the URL.
  assert.match(resolveTarget('http://evil.example/uploads/car-1.jpg'), /^http:\/\/127\.0\.0\.1:\d+\/uploads\/car-1\.jpg$/);
  assert.match(resolveTarget('/uploads/car-1.jpg'), /^http:\/\/127\.0\.0\.1:\d+\/uploads\/car-1\.jpg$/);
});

test('withdrawals: invalid UPI / bank details are rejected', async () => {
  const c = new WalletController();
  for (const body of [
    { amount: 100, method: 'upi', details: { upiId: 'not-a-upi' } },
    { amount: 100, method: 'upi', details: { upiId: { $ne: '' } } },
    { amount: 100, method: 'bank', details: { accountNumber: '12', ifsc: 'X', bankName: 'B', accountHolderName: 'A B' } },
    { amount: 1.5, method: 'upi', details: { upiId: 'a@upi' } },
    { amount: -5, method: 'upi', details: { upiId: 'a@upi' } },
  ]) {
    const { err } = await run(c.requestWithdrawal, { body, user: { _id: CUSTOMER } });
    assert.strictEqual(err?.statusCode, 400, JSON.stringify(body));
  }
});

test('withdrawals: two parallel requests cannot both pass the earnings check', async (t) => {
  let balance = 200;
  stub(t, SawariCashTransaction, {
    find: () => ({ lean: async () => { await new Promise((r) => setImmediate(r)); return [{ transactionType: 'credit', reason: 'Referral commission', amount: 100 }]; } }),
    create: async () => ({}),
  });
  stub(t, Customer, {
    findById: () => ({ select: () => ({ lean: async () => ({ walletBalance: balance }) }) }),
    findOneAndUpdate: async (f, u) => { if (balance < f.walletBalance.$gte) return null; balance += u.$inc.walletBalance; return { walletBalance: balance }; },
  });
  const c = new WalletController();
  const req = () => ({ body: { amount: 100, method: 'upi', details: { upiId: 'asha@okaxis' } }, user: { _id: CUSTOMER } });
  const results = await Promise.all([run(c.requestWithdrawal, req()), run(c.requestWithdrawal, req())]);
  assert.strictEqual(results.filter((r) => !r.err).length, 1);
  assert.strictEqual(balance, 100, 'only the ₹100 of referral earnings may leave the wallet');
});

test('membership activation fills the required fields (second customer no longer fails after paying)', async (t) => {
  fakeRazorpay(t, { amount: 199900 });
  let update;
  stub(t, Customer, { findById: async () => ({ _id: CUSTOMER }) });
  stub(t, Membership, { findOneAndUpdate: async (f, u) => { update = u; return { plan: 'plus', ...u.$set }; } });
  stub(t, SawariCashTransaction, { create: async () => ({}) });
  const { res } = await run(new WalletController().activateMembership, {
    body: { plan: 'plus', razorpayOrderId: 'order_TEST123456', razorpayPaymentId: 'pay_TEST123456' },
    user: { _id: CUSTOMER },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(update.$setOnInsert.membershipId);
  assert.strictEqual(update.$set.payment.paymentId, 'pay_TEST123456');
  paymentService.releasePayment('pay_TEST123456');
});

test('membership plan names are checked strictly (no prototype keys)', async () => {
  for (const plan of ['constructor', '__proto__', 'toString', 'gold']) {
    const { err } = await run(new WalletController().activateMembership, {
      body: { plan, razorpayOrderId: 'order_TEST123456', razorpayPaymentId: 'pay_TEST123456' }, user: { _id: CUSTOMER },
    });
    assert.strictEqual(err?.statusCode, 400, plan);
  }
});

test('coupon validation cannot be crashed or abused with odd input', async (t) => {
  stub(t, Offer, { findOne: () => ({ lean: async () => ({ code: 'X', discountType: 'PERCENTAGE', discountValue: 500, minimumBooking: 0 }) }) });
  assert.strictEqual(await CouponService.validateCoupon({ $ne: 1 }, 1000), null);
  assert.strictEqual(await CouponService.validateCoupon('X', 'abc'), null);
  const r = await CouponService.validateCoupon('X', 1000);
  assert.ok(r.discount <= 1000, 'a >100% coupon can never exceed the booking amount');
});

test('lead tracking always uses the signed-in number, never one from the body', async (t) => {
  let filter;
  stub(t, CustomerAppLead, { findOneAndUpdate: async (f) => { filter = f; return { _id: 'l1', status: 'abandoned' }; } });
  await run(leadController.trackLead, {
    user: { mobileNumber: '9876543210', customerName: 'Asha' },
    body: { mobileNumber: '9000000000', vehicleId: 'not-an-id', totalAmount: 'lots', lastPageVisited: '<script>' },
  });
  assert.strictEqual(filter.mobileNumber, '9876543210');
});

test('public vehicle list does not publish registration numbers', () => {
  const src = require('fs').readFileSync(require.resolve('../../src/modules/vehicles/vehicle.controller'), 'utf8');
  const fields = src.match(/'vehicleName[^']*'/)[0];
  assert.ok(!fields.includes('vehicleNumber'));
});
