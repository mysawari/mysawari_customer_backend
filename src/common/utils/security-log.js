const { clientIp, maskIp } = require('./client-ip');

/**
 * Structured security events, one JSON line each, so they can be searched / alerted on in the hosting
 * provider's log viewer (Render, etc.) without any database. Personal data is masked: IPs keep only
 * their network part and mobile numbers only the last 4 digits.
 *
 * Events: otp_send_throttled, otp_failed, otp_locked, login, login_blocked, rate_limited,
 * admin_key_rejected, admin_key_locked, referral_flagged, payment_rejected, session_revoked.
 */
const maskMobile = (m) => (m ? `******${String(m).slice(-4)}` : undefined);

function securityLog(event, req, details = {}) {
  const entry = {
    t: new Date().toISOString(),
    security: event,
    ip: req ? maskIp(clientIp(req)) : undefined,
    path: req ? `${req.method} ${req.baseUrl || ''}${req.path || ''}` : undefined,
    user: req?.user?._id ? String(req.user._id) : undefined,
    ...details,
  };
  if (entry.mobile) entry.mobile = maskMobile(entry.mobile);
  if (process.env.NODE_ENV === 'test') return entry; // keep test output clean
  console.log(JSON.stringify(entry));
  return entry;
}

module.exports = { securityLog, maskMobile };
