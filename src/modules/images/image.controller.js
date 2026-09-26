const axios = require('axios');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

// Temporary cache directory in the system temp folder to store blurred images
const CACHE_DIR = path.join(os.tmpdir(), 'mysawari_image_cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Bump when the plate-hiding logic changes, so images processed by an older version are never served again.
const CACHE_VERSION = 'v5';

// Only our own photo hosts can be processed. Anything else would let this endpoint fetch arbitrary URLs.
const ALLOWED_HOSTS = ['res.cloudinary.com', ...(process.env.IMAGE_PROXY_ALLOWED_HOSTS || '').split(',')]
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

// One processing run per image even when the app asks for it several times at once (card, gallery, full screen).
const inFlight = new Map();

/**
 * Privacy rule: this endpoint only ever returns a photo whose number plate has been processed.
 * It never redirects to, or streams, the original image — if processing is unavailable it fails
 * and the app shows its "photo unavailable" placeholder instead.
 */
function fail(res, status, message) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).send(message);
}

// Our own uploaded photos are always fetched from this trusted address — never from the Host header
// the client sent (a forged Host header used to make any internal URL count as "our own host").
const SELF_BASE_URL = (process.env.IMAGE_SELF_BASE_URL || `http://127.0.0.1:${process.env.PORT || 5001}`).replace(/\/+$/, '');
const MAX_TARGET_LENGTH = 2048;
// Processing is CPU-heavy: at most this many photos are sent to the image service at once, and further
// ones wait in a bounded queue (a screen full of new cards just loads a little slower). Only when the
// queue itself is full is a request turned away, and the app then retries.
const MAX_CONCURRENT_PROCESSING = 4;
const MAX_QUEUED = 200;
let active = 0;
const waiting = [];

function acquireSlot() {
  if (active < MAX_CONCURRENT_PROCESSING) {
    active += 1;
    return Promise.resolve();
  }
  if (waiting.length >= MAX_QUEUED) return null;
  return new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) next();
  else active -= 1;
}

function resolveTarget(targetUrl) {
  if (targetUrl.length > MAX_TARGET_LENGTH) return null;
  let parsed;
  try {
    parsed = new URL(targetUrl, 'http://placeholder.invalid');
  } catch {
    return null;
  }
  const path = parsed.pathname;
  if (path.includes('..') || /%2e|%2f|%5c/i.test(path)) return null;

  // Our own uploads (relative "/uploads/..." or any host + "/uploads/..."): only the path is used.
  if (path.startsWith('/uploads/') && /^\/uploads\/[\w.\-/]+$/.test(path)) {
    return `${SELF_BASE_URL}${path}`;
  }

  // External photos: https only, allowed hosts only, image-delivery paths only.
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null;
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.includes(host)) return null;
  if (host === 'res.cloudinary.com' && !/^\/[\w-]+\/image\/upload\//.test(path)) return null;
  return parsed.toString();
}

async function processImage(apiUrl, absoluteTargetUrl, cachedFilePath) {
  const response = await axios.post(
    apiUrl,
    {
      input: absoluteTargetUrl,
      operations: { privacy: { blur_car_plate: true } },
      output: { format: 'jpeg' },
    },
    {
      headers: {
        'Content-Type': 'application/json',
        // Shared secret so the image service only accepts work from this backend (when configured).
        ...(process.env.IMAGE_SERVICE_TOKEN ? { 'X-Service-Token': process.env.IMAGE_SERVICE_TOKEN } : {}),
      },
      responseType: 'arraybuffer',
      timeout: 60 * 1000,
      maxContentLength: 15 * 1024 * 1024,
      maxRedirects: 0,
    }
  );
  const buffer = Buffer.from(response.data);
  if (!buffer.length) throw new Error('Empty image from processing service');

  // Written under a temporary name and renamed once complete, so a half-written file is never served.
  const tmpPath = `${cachedFilePath}.${process.pid}.${Date.now()}.part`;
  await fs.promises.writeFile(tmpPath, buffer);
  await fs.promises.rename(tmpPath, cachedFilePath);
  return buffer;
}

exports.getBlurredImage = async (req, res) => {
  const targetUrl = req.query.target;
  if (!targetUrl || typeof targetUrl !== 'string') {
    return fail(res, 400, 'Missing target parameter');
  }

  const absoluteTargetUrl = resolveTarget(targetUrl);
  if (!absoluteTargetUrl) {
    return fail(res, 400, 'Image host not allowed');
  }

  // Generate a safe filename based on the URL hash (and the processing version)
  const hash = crypto.createHash('md5').update(`${CACHE_VERSION}:${absoluteTargetUrl}`).digest('hex');
  const cachedFilePath = path.join(CACHE_DIR, `${hash}.jpeg`);

  try {
    let buffer;
    if (fs.existsSync(cachedFilePath)) {
      buffer = await fs.promises.readFile(cachedFilePath);
    } else {
      const apiUrl = process.env.IMAGE_PROCESSING_API_URL;
      if (!apiUrl) {
        console.error('IMAGE_PROCESSING_API_URL is not set — vehicle photos cannot be shown without plate processing.');
        return fail(res, 503, 'Image processing unavailable');
      }
      if (!inFlight.has(hash)) {
        const slot = acquireSlot();
        if (!slot) return fail(res, 503, 'Image processing busy, please retry');
        inFlight.set(
          hash,
          slot
            .then(() => processImage(apiUrl, absoluteTargetUrl, cachedFilePath).finally(releaseSlot))
            .finally(() => inFlight.delete(hash))
        );
      }
      buffer = await inFlight.get(hash);
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(buffer);
  } catch (error) {
    console.error('Error in image blurring proxy:', error?.message);
    return fail(res, 503, 'Image processing failed');
  }
};

module.exports.resolveTarget = resolveTarget;
