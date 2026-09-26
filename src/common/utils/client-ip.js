const net = require('net');

/**
 * Client IP helpers.
 *
 * `req.ip` is only trustworthy when Express knows exactly how many proxies sit in front of it
 * (see TRUST_PROXY in app.js). These helpers then make the address comparable:
 *  - "::ffff:1.2.3.4" (an IPv4 address seen over an IPv6 socket) and "1.2.3.4" are the same client;
 *  - one phone on IPv6 moves around inside its /64, so two addresses in the same /64 are one network.
 */

function normalizeIp(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let ip = raw.trim().toLowerCase();
  if (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  return net.isIP(ip) ? ip : '';
}

/** Expands an IPv6 address to its 8 full groups. */
function expandIpv6(ip) {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const missing = 8 - h.length - t.length;
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, missing)).fill('0'), ...t];
  return groups.map((g) => g.padStart(4, '0'));
}

/** The "network" an address belongs to: the IPv4 address itself, or the IPv6 /64 prefix. */
function networkKey(raw) {
  const ip = normalizeIp(raw);
  if (!ip) return '';
  if (net.isIPv4(ip)) return ip;
  return `${expandIpv6(ip).slice(0, 4).join(':')}::/64`;
}

/** True when both addresses are known and come from the same IPv4 address / IPv6 /64. */
function sameNetwork(a, b) {
  const ka = networkKey(a);
  const kb = networkKey(b);
  return !!ka && ka === kb;
}

/** The request's client IP, normalized. Never reads X-Forwarded-For directly. */
function clientIp(req) {
  return normalizeIp(req.ip || req.socket?.remoteAddress || '');
}

/** Masks an IP for logs: 1.2.3.x / 2401:4900:1c2a:1234::/64 */
function maskIp(raw) {
  const ip = normalizeIp(raw);
  if (!ip) return 'unknown';
  if (net.isIPv4(ip)) return ip.replace(/\.\d+$/, '.x');
  return networkKey(ip);
}

module.exports = { normalizeIp, networkKey, sameNetwork, clientIp, maskIp };
