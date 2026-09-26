const { stub, run } = require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createLimiter } = require('../../src/common/utils/rate-limit');
const { normalizeIp, sameNetwork, networkKey } = require('../../src/common/utils/client-ip');
const { installId, deviceInfoFor, installIdFromDeviceInfo } = require('../../src/common/utils/device');
const AuthService = require('../../src/modules/auth/auth.service');
const ReferralService = require('../../src/modules/referrals/referral.service');
const Otp = require('../../src/models/otp.model');
const Token = require('../../src/models/token.model');
const Customer = require('../../src/models/customer.model');
const Referral = require('../../src/models/referral.model');
const Booking = require('../../src/models/booking.model');
const SawariCashTransaction = require('../../src/models/sawaricash_transaction.model');

/** Starts a small app, runs fn(base), closes it. */
async function withApp(configure, fn) {
  const app = express();
  configure(app);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('IP helpers: IPv4-mapped addresses, IPv6 /64 grouping, junk never matches', () => {
  assert.strictEqual(normalizeIp('::ffff:49.36.10.5'), '49.36.10.5');
  assert.ok(sameNetwork('::ffff:49.36.10.5', '49.36.10.5'));
  assert.ok(sameNetwork('2401:4900:1c2a:1234:1::1', '2401:4900:1c2a:1234:ffff::2'));
  assert.ok(!sameNetwork('2401:4900:1c2a:1234::1', '2401:4900:1c2a:1235::1'));
  assert.ok(!sameNetwork('', ''));
  assert.ok(!sameNetwork('not-an-ip', 'not-an-ip'));
  assert.strictEqual(networkKey('1.2.3.4'), '1.2.3.4');
});

test('with no trusted proxy, a spoofed X-Forwarded-For cannot dodge an IP rate limit', async () => {
  await withApp((app) => {
    app.set('trust proxy', false);
    app.get('/x', createLimiter({ name: 't', windowMs: 60000, max: 5 }), (req, res) => res.json({ ok: true }));
  }, async (base) => {
    const codes = [];
    for (let i = 0; i < 8; i++) {
      const r = await fetch(`${base}/x`, { headers: { 'X-Forwarded-For': `10.0.0.${i}` } });
      codes.push(r.status);
    }
    assert.deepStrictEqual(codes.slice(5), [429, 429, 429]);
  });
});

test('behind one trusted proxy, the real client IP from that proxy is used', async () => {
  await withApp((app) => {
    app.set('trust proxy', 1);
    app.get('/x', createLimiter({ name: 't', windowMs: 60000, max: 2 }), (req, res) => res.json({ ok: true }));
  }, async (base) => {
    // Two different clients (as reported by the proxy) each get their own budget.
    for (const client of ['49.36.1.1', '49.36.2.2']) {
      for (let i = 0; i < 2; i++) {
        assert.strictEqual((await fetch(`${base}/x`, { headers: { 'X-Forwarded-For': client } })).status, 200);
      }
      assert.strictEqual((await fetch(`${base}/x`, { headers: { 'X-Forwarded-For': client } })).status, 429);
    }
  });
});

test('rotating an IPv6 address inside the same /56 does not reset the limit', async () => {
  await withApp((app) => {
    app.set('trust proxy', 1);
    app.get('/x', createLimiter({ name: 't', windowMs: 60000, max: 3 }), (req, res) => res.json({ ok: true }));
  }, async (base) => {
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${base}/x`, { headers: { 'X-Forwarded-For': `2401:4900:1c2a:12${i}0::${i + 1}` } });
      statuses.push(r.status);
    }
    assert.deepStrictEqual(statuses, [200, 200, 200, 429, 429]);
  });
});

test('signed-in limits follow the customer, not the IP', async () => {
  await withApp((app) => {
    app.set('trust proxy', 1);
    app.use((req, res, next) => { req.user = { _id: req.headers['x-user'] }; next(); });
    app.post('/x', createLimiter({ name: 't', by: 'user', windowMs: 60000, max: 3 }), (req, res) => res.json({ ok: true }));
  }, async (base) => {
    const hit = (user, ip) => fetch(`${base}/x`, { method: 'POST', headers: { 'x-user': user, 'X-Forwarded-For': ip } }).then((r) => r.status);
    // One customer hopping across IPs still has one budget...
    assert.deepStrictEqual([await hit('A', '1.1.1.1'), await hit('A', '2.2.2.2'), await hit('A', '3.3.3.3'), await hit('A', '4.4.4.4')], [200, 200, 200, 429]);
    // ...and another customer on the very same (carrier-shared) IP is unaffected.
    assert.strictEqual(await hit('B', '4.4.4.4'), 200);
  });
});

test('admin key: repeated wrong guesses lock the network out, even for the right key', async () => {
  const requireAdminKey = require('../../src/middleware/adminKey.middleware');
  requireAdminKey._failures.clear();
  await withApp((app) => {
    app.post('/admin', requireAdminKey, (req, res) => res.json({ ok: true }));
    app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ message: err.message }));
  }, async (base) => {
    const call = (key) => fetch(`${base}/admin`, { method: 'POST', headers: { 'x-admin-key': key } }).then((r) => r.status);
    assert.strictEqual(await call('test-admin-key'), 200);
    for (let i = 0; i < 10; i++) assert.strictEqual(await call(`guess-${i}`), 401);
    assert.strictEqual(await call('test-admin-key'), 429);
  });
  requireAdminKey._failures.clear();
});

test('install id: only well-formed ids are accepted (no injection through the header)', () => {
  const req = (v) => ({ headers: { 'x-install-id': v, 'user-agent': 'okhttp | iid:fake' } });
  assert.strictEqual(installId(req('abc')), '');
  assert.strictEqual(installId(req('.*|iid:.*')), '');
  assert.strictEqual(installId(req({ $ne: 1 })), '');
  const good = '18f2a9c1b-0a1b2c3d4e5f60718293a4b5';
  assert.strictEqual(installId(req(good)), good);
  // A user agent can't forge an install id: "|" is stripped from it.
  assert.strictEqual(installIdFromDeviceInfo(deviceInfoFor(req('bad'))), '');
  assert.strictEqual(installIdFromDeviceInfo(deviceInfoFor(req(good))), good);
});

/** Stubs for creating a brand-new referred account through verifyOtp. */
function signupStubs(t, { referrer, referrerSessions = [], recentReferred = [] }) {
  const created = {};
  stub(t, Otp, {
    findOneAndUpdate: async () => ({ _id: 'o1', otp: '4821', expiresAt: new Date(Date.now() + 60000), attempts: 1 }),
    findOneAndDelete: async () => ({ _id: 'o1' }),
  });
  stub(t, Customer, {
    findOne: async (q) => (q.referralCode ? referrer : null),
    find: () => ({ select: () => ({ limit: () => ({ lean: async () => recentReferred }) }) }),
    create: async (doc) => { created.customer = doc; return { _id: '64b0000000000000000000ee', ...doc }; },
  });
  stub(t, Token, {
    find: () => ({ select: () => ({ limit: () => ({ lean: async () => referrerSessions }) }) }),
    create: async () => ({}),
  });
  stub(t, SawariCashTransaction, { create: async () => ({}) });
  stub(t, Referral, { findOneAndUpdate: async (f, u) => { created.referral = u.$set; return {}; } });
  return created;
}

const REFERRER = { _id: '64b0000000000000000000aa', referralCode: 'ASHA01', signupIp: '49.36.10.5' };
const IID = '18f2a9c1b-0a1b2c3d4e5f60718293a4b5';
const signup = (ipAddress, iid = '') => new AuthService().verifyOtp({
  mobileNumber: '9123456789', otp: '4821', referredByCode: 'asha01', ipAddress, installId: iid,
});

test('referral at signup: same network as the referrer is flagged (IPv4-mapped form too)', async (t) => {
  const created = signupStubs(t, { referrer: REFERRER });
  const result = await signup('::ffff:49.36.10.5');
  assert.strictEqual(created.referral.status, 'fraudulent');
  assert.strictEqual(result.referralFlagged, 'same_network_as_referrer');
  assert.strictEqual(created.customer.signupIp, '49.36.10.5', 'IP is stored normalized');
});

test('referral at signup: same phone as the referrer is flagged even on a different network', async (t) => {
  const created = signupStubs(t, { referrer: REFERRER, referrerSessions: [{ deviceInfo: `okhttp/4 | iid:${IID}` }] });
  await signup('106.200.1.1', IID);
  assert.strictEqual(created.referral.status, 'fraudulent');
});

test('referral at signup: a burst of referred signups from one network is flagged', async (t) => {
  const created = signupStubs(t, { referrer: REFERRER, recentReferred: [{ signupIp: '106.200.9.9' }, { signupIp: '106.200.9.9' }] });
  await signup('106.200.9.9');
  assert.strictEqual(created.referral.status, 'fraudulent');
});

test('referral at signup: a genuine friend (different network and phone) is not flagged', async (t) => {
  const created = signupStubs(t, {
    referrer: REFERRER,
    referrerSessions: [{ deviceInfo: 'okhttp/4 | iid:aaaaaaaaaaaaaaaaaaaa' }],
    recentReferred: [{ signupIp: '106.200.9.9' }],
  });
  const result = await signup('117.99.1.1', IID);
  assert.strictEqual(created.referral.status, 'invited');
  assert.strictEqual(result.referralFlagged, null);
});

test('referral payout: two accounts used on the same phone get no commission', async (t) => {
  let credited = 0;
  let flagged = false;
  stub(t, Customer, {
    findById: async () => ({ _id: 'R', signupIp: '49.36.10.5' }),
    findOne: async () => ({ _id: 'F', signupIp: '117.99.1.1' }),
    updateOne: async (f, u) => { credited += u.$inc.walletBalance; },
  });
  stub(t, Referral, {
    find: async () => [{ _id: 'ref1', referredMobile: '9123456789', invitedAt: new Date(0) }],
    updateOne: async (f, u) => { if (u.$set.status === 'fraudulent') flagged = true; },
    findOneAndUpdate: async () => ({}),
  });
  stub(t, Booking, { findOne: () => ({ sort: async () => ({ _id: 'b', payment: { vehicleRent: 5000 } }) }) });
  stub(t, Token, {
    find: (q) => ({ select: () => ({ limit: () => ({ lean: async () => [{ deviceInfo: `ua | iid:${IID}` }] }) }) }),
  });
  await new ReferralService().settle('R-same-device-test');
  assert.ok(flagged, 'referral must be marked fraudulent');
  assert.strictEqual(credited, 0);
});

test('logout revokes the refresh token; forged tokens never reach the database', async (t) => {
  const svc = new AuthService();
  const { refreshToken } = svc.generateTokens({ _id: '64b000000000000000000001', mobileNumber: '9876543210' });
  let deleted = null;
  stub(t, Token, { findOneAndDelete: async (f) => { deleted = f; return { _id: 't' }; } });
  assert.strictEqual(await svc.revokeRefreshToken(refreshToken), true);
  assert.strictEqual(deleted.token, refreshToken);

  deleted = null;
  assert.strictEqual(await svc.revokeRefreshToken('eyJhbGciOiJIUzI1NiJ9.e30.forged'), false);
  assert.strictEqual(deleted, null);
});
