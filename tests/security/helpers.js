// Test environment: fixed secrets, no database. Any accidental real DB call fails fast instead of hanging.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-access-secret-not-the-legacy-one';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-not-the-legacy-one';
process.env.ADMIN_API_KEY = 'test-admin-key';
process.env.RAZORPAY_KEY_SECRET = 'test-razorpay-secret';
process.env.CLOUDINARY_CLOUD_NAME = 'mysawari-test';

const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);

/** Replaces model statics for one test and restores them afterwards. */
function stub(t, target, methods) {
  const originals = {};
  for (const [name, fn] of Object.entries(methods)) {
    originals[name] = target[name];
    target[name] = fn;
  }
  t.after(() => Object.assign(target, originals));
}

/** A minimal Express-style response recorder. */
function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    set(obj) { Object.assign(this.headers, obj); return this; },
    type() { return this; },
  };
  return res;
}

/** Runs an asyncHandler-wrapped controller method and resolves with { res, err }. */
function run(handler, req) {
  return new Promise((resolve) => {
    const res = mockRes();
    const origJson = res.json.bind(res);
    res.json = (body) => { origJson(body); resolve({ res, err: null }); return res; };
    handler(req, res, (err) => resolve({ res, err }));
  });
}

const tick = () => new Promise((r) => setImmediate(r));

module.exports = { stub, mockRes, run, tick };
