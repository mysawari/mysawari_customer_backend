const { stub } = require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert');
const AuthService = require('../../src/modules/auth/auth.service');
const Otp = require('../../src/models/otp.model');
const Token = require('../../src/models/token.model');
const Customer = require('../../src/models/customer.model');
const watiService = require('../../src/integrations/wati.service');
const publicCustomer = require('../../src/common/utils/public-customer');

/** An in-memory Otp collection whose updates are atomic, like MongoDB's. */
function otpStore(t, initial) {
  let doc = initial ? { _id: 'otp1', ...initial } : null;
  const matches = (filter) => doc
    && (filter.mobileNumber === undefined || filter.mobileNumber === doc.mobileNumber)
    && (filter._id === undefined || filter._id === doc._id)
    && (filter.otp === undefined || filter.otp === doc.otp)
    && (!filter.attempts || doc.attempts < filter.attempts.$lt);
  stub(t, Otp, {
    findOneAndUpdate: async (filter, update) => {
      await new Promise((r) => setImmediate(r)); // let parallel requests interleave
      if (!matches(filter)) return null;
      doc.attempts += update.$inc.attempts;
      return { ...doc };
    },
    findOneAndDelete: async (filter) => {
      await new Promise((r) => setImmediate(r));
      if (!matches(filter)) return null;
      const d = doc; doc = null; return d;
    },
    exists: async () => (doc ? { _id: doc._id } : null),
    deleteOne: async () => { doc = null; },
  });
  return () => doc;
}

const customerDoc = {
  _id: '64b000000000000000000001',
  customerName: 'Asha',
  mobileNumber: '9876543210',
  status: 'active',
  documents: { aadhaarNumber: '123412341234', dlNumber: 'AS0120190001234' },
  withdrawalRequests: [{ details: { accountNumber: '1234567890', ifsc: 'SBIN0001234' } }],
  signupIp: '10.1.2.3',
  referralCode: 'ABC123',
};

test('parallel OTP guesses cannot exceed 5 attempts (brute-force race closed)', async (t) => {
  const current = otpStore(t, { mobileNumber: '9876543210', otp: '4821', expiresAt: new Date(Date.now() + 60000), attempts: 0 });
  stub(t, Customer, { findOne: async () => customerDoc });
  stub(t, Token, { create: async () => ({}) });
  const svc = new AuthService();

  // 200 wrong guesses fired at once, plus the right code among them.
  const guesses = Array.from({ length: 200 }, (_, i) => String(1000 + i));
  guesses.push('4821');
  const results = await Promise.allSettled(guesses.map((otp) => svc.verifyOtp({ mobileNumber: '9876543210', otp })));
  const successes = results.filter((r) => r.status === 'fulfilled');
  assert.strictEqual(successes.length, 0, 'the correct code must not be reachable after 5 wrong attempts');
  assert.ok(!current() || current().attempts <= 5);
});

test('a correct OTP logs in exactly once, even when submitted twice in parallel', async (t) => {
  otpStore(t, { mobileNumber: '9876543210', otp: '4821', expiresAt: new Date(Date.now() + 60000), attempts: 0 });
  stub(t, Customer, { findOne: async () => customerDoc });
  stub(t, Token, { create: async () => ({}) });
  const svc = new AuthService();
  const results = await Promise.allSettled([
    svc.verifyOtp({ mobileNumber: '9876543210', otp: '4821' }),
    svc.verifyOtp({ mobileNumber: '9876543210', otp: '4821' }),
  ]);
  assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 1);
});

test('login response never contains Aadhaar, bank details or the signup IP', async (t) => {
  otpStore(t, { mobileNumber: '9876543210', otp: '4821', expiresAt: new Date(Date.now() + 60000), attempts: 0 });
  stub(t, Customer, { findOne: async () => customerDoc });
  stub(t, Token, { create: async () => ({}) });
  const result = await new AuthService().verifyOtp({ mobileNumber: '9876543210', otp: '4821' });
  const json = JSON.stringify(result.customer);
  assert.ok(!json.includes('123412341234'), 'aadhaar leaked');
  assert.ok(!json.includes('SBIN0001234'), 'bank details leaked');
  assert.ok(!json.includes('10.1.2.3'), 'signup IP leaked');
  assert.strictEqual(result.customer._id, customerDoc._id);
  assert.strictEqual(result.customer.documents.dlNumber, 'AS0120190001234');
});

test('a blocked account cannot log in', async (t) => {
  otpStore(t, { mobileNumber: '9876543210', otp: '4821', expiresAt: new Date(Date.now() + 60000), attempts: 0 });
  stub(t, Customer, { findOne: async () => ({ ...customerDoc, status: 'blocked' }) });
  stub(t, Token, { create: async () => { throw new Error('must not issue tokens'); } });
  await assert.rejects(new AuthService().verifyOtp({ mobileNumber: '9876543210', otp: '4821' }), /blocked/);
});

test('OTP sends are throttled per number (cooldown + hourly cap)', async (t) => {
  otpStore(t, null);
  stub(t, Otp, { findOneAndUpdate: async () => ({}) });
  stub(t, Customer, { exists: async () => null });
  stub(t, watiService, { sendWhatsAppOtp: async () => true });
  const svc = new AuthService();
  await svc.sendOtp({ mobileNumber: '9123456780' });
  await assert.rejects(svc.sendOtp({ mobileNumber: '9123456780' }), (e) => e.statusCode === 429);
  // A different number is unaffected.
  await svc.sendOtp({ mobileNumber: '9123456781' });
});

test('a refresh token can only be rotated once (parallel reuse gets one session)', async (t) => {
  const svc = new AuthService();
  const { refreshToken } = svc.generateTokens(customerDoc);
  let stored = { _id: 't1', token: refreshToken, revoked: false };
  stub(t, Token, {
    findOneAndDelete: async (filter) => {
      await new Promise((r) => setImmediate(r));
      if (!stored || filter.token !== stored.token) return null;
      const s = stored; stored = null; return s;
    },
    create: async () => ({}),
  });
  stub(t, Customer, { findById: async () => customerDoc });
  const results = await Promise.allSettled([svc.refreshToken(refreshToken), svc.refreshToken(refreshToken)]);
  assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 1);
});

test('refresh with a forged / wrong-secret token is rejected before any lookup', async (t) => {
  stub(t, Token, { findOneAndDelete: async () => { throw new Error('must not reach the database'); } });
  const jwt = require('jsonwebtoken');
  const forged = jwt.sign({ id: customerDoc._id }, 'mysawari_refresh_super_secret_key_123!', { issuer: 'mysawari', audience: 'mysawari-customer-app' });
  await assert.rejects(new AuthService().refreshToken(forged), (e) => e.statusCode === 401);
});

test('publicCustomer only exposes the allowed fields', () => {
  const out = publicCustomer(customerDoc);
  assert.deepStrictEqual(Object.keys(out).sort(), [
    '_id', 'createdAt', 'customerName', 'dob', 'documents', 'email', 'gender', 'id',
    'kycStatus', 'mobileNumber', 'referralCode', 'rewardsPoints', 'walletBalance',
  ]);
  assert.deepStrictEqual(Object.keys(out.documents), ['dlNumber']);
});
