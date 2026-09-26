require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');

let server;
let base;
before(() => new Promise((resolve) => {
  server = app.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}/api`;
    resolve();
  });
}));
after(() => new Promise((resolve) => server.close(resolve)));

const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('NoSQL operator in the body is rejected before reaching any handler', async () => {
  const res = await post('/auth/verify-otp', { mobileNumber: '9876543210', otp: { $ne: '' } });
  assert.strictEqual(res.status, 400);
});

test('prototype-pollution key in the body is rejected', async () => {
  const res = await post('/auth/send-otp', '{"mobileNumber":"9876543210","__proto__":{"isAdmin":true}}');
  assert.strictEqual(res.status, 400);
});

test('query strings cannot smuggle arrays / unexpected values into the offers filter', async () => {
  for (const qs of ['type=coupon&type=special_deal', 'type=bogus', 'type[$ne]=x&type=y']) {
    const res = await fetch(`${base}/offers?${qs}`);
    assert.strictEqual(res.status, 400, qs);
  }
});

test('malformed JSON returns 400, not a 500', async () => {
  const res = await post('/auth/send-otp', '{"mobileNumber": ');
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.message, 'Invalid request body');
});

test('oversized body returns 413', async () => {
  const res = await post('/auth/send-otp', { mobileNumber: '9876543210', pad: 'x'.repeat(200 * 1024) });
  assert.strictEqual(res.status, 413);
});

test('send-otp refuses non-Indian / malformed numbers (no WhatsApp spam to arbitrary numbers)', async () => {
  for (const mobileNumber of ['+15551234567', '12345', '0000000000', '98765432101', 'abcdefghij']) {
    const res = await post('/auth/send-otp', { mobileNumber });
    assert.strictEqual(res.status, 400, mobileNumber);
  }
});

test('verify-otp refuses a non-numeric OTP', async () => {
  const res = await post('/auth/verify-otp', { mobileNumber: '9876543210', otp: 'abcd' });
  assert.strictEqual(res.status, 400);
});

test('a token forged with the old publicly-known secret is rejected', async () => {
  const forged = jwt.sign({ id: '64b000000000000000000001' }, 'mysawari_super_secret_key_123!', {
    issuer: 'mysawari', audience: 'mysawari-customer-app', expiresIn: '15m',
  });
  const res = await fetch(`${base}/customers/profile`, { headers: { Authorization: `Bearer ${forged}` } });
  assert.strictEqual(res.status, 401);
});

test('protected routes require a token', async () => {
  for (const [method, path] of [['GET', '/bookings/my-bookings'], ['POST', '/bookings/hold'], ['GET', '/customers/wallet'],
    ['POST', '/customers/wallet/withdraw'], ['POST', '/payments/create-order'], ['GET', '/notifications'],
    ['POST', '/leads/track'], ['GET', '/bookings/64b000000000000000000001/track-location']]) {
    const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    assert.strictEqual(res.status, 401, `${method} ${path}`);
  }
});

test('driver status can no longer be set by a customer — admin key required', async () => {
  const res = await post('/bookings/64b000000000000000000001/driver-status', { driverStatus: 'ARRIVED' });
  assert.strictEqual(res.status, 401);
  const wrongKey = await post('/bookings/64b000000000000000000001/driver-status', { driverStatus: 'ARRIVED' }, { 'x-admin-key': 'nope' });
  assert.strictEqual(wrongKey.status, 401);
});

test('offer management requires the admin key', async () => {
  const res = await post('/offers', { type: 'coupon', title: 'FREE', code: 'FREE100', discountType: 'PERCENTAGE', discountValue: 100 });
  assert.strictEqual(res.status, 401);
});

test('the public quote endpoint validates coordinates (was a crash + open Google API proxy)', async () => {
  const res = await post('/bookings/calculate', { pickup: { latitude: 'x' }, dropoff: null });
  assert.strictEqual(res.status, 400);
});

test('image proxy refuses internal / foreign targets and never redirects to the original', async () => {
  const targets = [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:27017/',
    'https://evil.example/x.jpg',
    'file:///etc/passwd',
    'http://res.cloudinary.com/demo/image/upload/car.jpg',
    '/api/images/blur?target=x',
  ];
  for (const target of targets) {
    const res = await fetch(`${base}/images/blur?target=${encodeURIComponent(target)}`, {
      redirect: 'manual',
      headers: { Host: '169.254.169.254' },
    });
    assert.strictEqual(res.status, 400, target);
    assert.strictEqual(res.headers.get('location'), null, target);
  }
});

test('security headers are set', async () => {
  const res = await fetch(`${base}/health`);
  assert.strictEqual(res.status, 200);
  assert.ok(res.headers.get('x-content-type-options'));
  assert.strictEqual(res.headers.get('x-powered-by'), null);
});
