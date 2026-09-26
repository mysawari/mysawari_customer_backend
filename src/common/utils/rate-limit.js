const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { clientIp } = require('./client-ip');
const { securityLog } = require('./security-log');

/**
 * One way to build every rate limiter.
 *
 *  by: 'ip'   — anonymous endpoints. Keyed by client IP; IPv6 clients are grouped by /56 so one
 *               device can't get a fresh budget just by rotating its IPv6 address.
 *  by: 'user' — signed-in endpoints (limiter placed after `protect`). Keyed by the customer, so an
 *               attacker can't multiply their budget with more IPs, and honest customers behind one
 *               carrier IP (CGNAT) don't share — and exhaust — one budget.
 *
 * Every rejection is written to the security log.
 */
function createLimiter({ windowMs, max, message = 'Too many requests, please try again later.', by = 'ip', name }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      if (by === 'user' && req.user?._id) return `u:${req.user._id}`;
      return `ip:${ipKeyGenerator(clientIp(req) || 'unknown', 56)}`;
    },
    handler: (req, res, next, options) => {
      securityLog('rate_limited', req, { limiter: name || 'unnamed' });
      res.status(options.statusCode).json({ success: false, message });
    },
  });
}

module.exports = { createLimiter };
