/**
 * Device signal for fraud checks, stored without any schema change.
 *
 * The app generates one random "install id" the first time it runs, keeps it in secure storage and sends
 * it as the X-Install-Id header. It is not a secret and not personal data — just a stable per-install
 * marker. It is saved inside the existing free-text `deviceInfo` of each session (Token) record as
 * "<user agent> | iid:<id>", which lets the server tell when two accounts are used from the same phone.
 */
const INSTALL_ID_RE = /^[A-Za-z0-9-]{16,64}$/;

function installId(req) {
  const v = req?.headers?.['x-install-id'];
  return typeof v === 'string' && INSTALL_ID_RE.test(v) ? v : '';
}

function deviceInfoFor(req) {
  const ua = String(req?.headers?.['user-agent'] || 'Unknown').replace(/\|/g, '/').slice(0, 150);
  const iid = installId(req);
  return iid ? `${ua} | iid:${iid}` : ua;
}

function installIdFromDeviceInfo(deviceInfo) {
  const m = /\| iid:([A-Za-z0-9-]{16,64})$/.exec(String(deviceInfo || ''));
  return m ? m[1] : '';
}

module.exports = { installId, deviceInfoFor, installIdFromDeviceInfo, INSTALL_ID_RE };
