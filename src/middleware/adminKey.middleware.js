const crypto = require('crypto');
const AppError = require('../common/errors/app-error');
const { clientIp, networkKey } = require('../common/utils/client-ip');
const { securityLog } = require('../common/utils/security-log');

// Wrong-key lockout: after this many failures from one network within the window, that network is
// refused (even with the right key) until the window passes — guessing the key becomes impractical.
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;
const failures = new Map(); // network -> { count, first }

function isLocked(key, now) {
  const f = failures.get(key);
  if (!f) return false;
  if (now - f.first > WINDOW_MS) {
    failures.delete(key);
    return false;
  }
  return f.count >= MAX_FAILURES;
}

function recordFailure(key, now) {
  const f = failures.get(key);
  if (!f || now - f.first > WINDOW_MS) failures.set(key, { count: 1, first: now });
  else f.count += 1;
  if (failures.size > 10000) failures.delete(failures.keys().next().value);
}

/**
 * Gate for the ops-only write endpoints (offer/coupon management, notifications, driver status) that
 * don't have a real admin login system yet. Requires a shared secret in the x-admin-key header, set via
 * ADMIN_API_KEY. Fails closed: if the key isn't configured, every request is rejected.
 */
function requireAdminKey(req, res, next) {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) {
    return next(new AppError('Admin access is not configured', 503));
  }

  const now = Date.now();
  const key = networkKey(clientIp(req)) || 'unknown';
  if (isLocked(key, now)) {
    securityLog('admin_key_locked', req);
    return next(new AppError('Too many failed attempts. Try again later.', 429));
  }

  const provided = String(req.headers['x-admin-key'] || '');
  // Compare fixed-length digests so neither the length nor the content of the key leaks through timing.
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  const matches = provided.length > 0 && crypto.timingSafeEqual(a, b);

  if (!matches) {
    recordFailure(key, now);
    securityLog('admin_key_rejected', req, { attempts: failures.get(key)?.count });
    return next(new AppError('Not authorized', 401));
  }
  failures.delete(key);
  next();
}

module.exports = requireAdminKey;
module.exports._failures = failures;
