const crypto = require('crypto');
const { JWT_SECRET } = require('../../config/secrets');

/**
 * Photo addresses never leave the API in readable form.
 *
 * Every vehicle / review / offer photo is handed to the app as /api/images/blur?t=<token>, where the token is
 * the original address encrypted with a server-only key (AES-256-GCM). Only this server can turn a token back
 * into an address, and it only ever answers with the plate-processed image — so the original photo (with a
 * readable plate) can't be opened by reading the API responses or the app's network traffic.
 *
 * The same address always gives the same token (the IV is derived from the address), so phones keep caching
 * each photo; GCM's authentication tag means a made-up or altered token is simply rejected.
 */

// Its own key, derived from the server secret (or set separately). Changing it only changes the URLs.
const KEY = crypto.createHash('sha256')
  .update(`mysawari-image-url-v1:${process.env.IMAGE_URL_SECRET || JWT_SECRET}`)
  .digest();
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_TOKEN_LENGTH = 4096;

function encodeImageToken(url) {
  const plain = Buffer.from(String(url), 'utf8');
  const iv = crypto.createHmac('sha256', KEY).update(plain).digest().subarray(0, IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

/** The original address for a token, or null for anything this server did not issue. */
function decodeImageToken(token) {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * The only form in which a photo leaves the API. `baseUrl` makes it absolute (vehicles list); without it the
 * path is relative, as the app expects for reviews and offers. Cloudinary photos are requested at the size
 * the app shows (and that the background pre-processing prepares), so they come straight from the cache.
 */
function publicImageUrl(url, baseUrl = '') {
  if (!url || typeof url !== 'string') return null;
  const { optimizedImageUrl } = require('../vehicles/vehicle.controller');
  return `${baseUrl}/api/images/blur?t=${encodeImageToken(optimizedImageUrl(url))}`;
}

module.exports = { encodeImageToken, decodeImageToken, publicImageUrl };
