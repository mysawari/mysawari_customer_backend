const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { blurPlates } = require('./plate-blur');
const { decodeImageToken } = require('./image-token');

// Temporary cache directory in the system temp folder to store blurred images
const CACHE_DIR = path.join(os.tmpdir(), 'mysawari_image_cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Bump when the plate-hiding logic changes, so images processed by an older version are never served again.
// v6: plates are hidden in-process (plate-blur/), replacing the Python image service.
// v7: all Indian plate types, irreversible quarter-average cover.
const CACHE_VERSION = 'v7';

// Only our own photo hosts can be processed. Anything else would let this endpoint fetch arbitrary URLs.
const ALLOWED_HOSTS = ['res.cloudinary.com', ...(process.env.IMAGE_PROXY_ALLOWED_HOSTS || '').split(',')]
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

// One processing run per image even when the app asks for it several times at once (card, gallery, full screen).
const inFlight = new Map();

/**
 * Privacy rule: this endpoint only ever returns a photo whose number plate has been processed.
 * It never redirects to, or streams, the original image — if processing fails it answers with an error
 * and the app shows its "photo unavailable" placeholder instead.
 */
function fail(res, status, message) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).send(message);
}

// Our own uploaded photos are always fetched from these trusted addresses — never from the host the client
// put in the URL (that would let anyone make this server fetch any address).
const SELF_BASE_URL = (process.env.IMAGE_SELF_BASE_URL || `http://127.0.0.1:${process.env.PORT || 5001}`).replace(/\/+$/, '');
// Vehicle photos are uploaded through the operations app and stored on its backend.
const OPERATION_BACKEND_URL = (process.env.OPERATION_BACKEND_URL || 'https://mysawari-operation-backend.onrender.com').replace(/\/+$/, '');
const MAX_TARGET_LENGTH = 2048;
const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20 * 1000;

// Processing is CPU-heavy and runs in this process: a couple of photos are worked on at once (downloads
// overlap, the model runs one at a time), and further ones wait in a bounded queue — a screen full of new
// cards just loads a little slower. Only when the queue itself is full is a request turned away (app retries).
const MAX_CONCURRENT_PROCESSING = Math.max(1, Number(process.env.PLATE_BLUR_CONCURRENCY) || 2);
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
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;

  const decodedPath = decodeURIComponent(path);
  const isUploadsPath = decodedPath.startsWith('/uploads/') && /^\/uploads\/[\w.\-\/ ()]+$/.test(decodedPath);

  // Our own uploads (relative, or a full URL with any host): always fetched from the fixed trusted address.
  if (isUploadsPath) {
    if (decodedPath.startsWith('/uploads/vehicles/')) return `${OPERATION_BACKEND_URL}${path}`;
    return `${SELF_BASE_URL}${path}`;
  }

  // External photos: https only, allowed hosts only, image-delivery paths only.
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null;
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.includes(host)) return null;
  if (host === 'res.cloudinary.com' && !/^\/[\w-]+\/image\/upload\//.test(path)) return null;
  return parsed.toString();
}

/** Downloads the photo with strict limits: no redirects, image content only, bounded size and time. */
async function downloadImage(url) {
  const res = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { 'User-Agent': 'MySawariImageProxy/1.0' },
  });
  if (!res.ok) {
    const err = new Error(`Photo download failed: HTTP ${res.status}`);
    err.status = res.status === 404 ? 404 : 502;
    throw err;
  }
  const type = res.headers.get('content-type') || '';
  if (type && !type.toLowerCase().startsWith('image/')) throw new Error(`Not an image (${type})`);
  if (Number(res.headers.get('content-length') || 0) > MAX_DOWNLOAD_BYTES) throw new Error('Image too large');

  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_DOWNLOAD_BYTES) throw new Error('Image too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function processImage(absoluteTargetUrl, cachedFilePath) {
  const original = await downloadImage(absoluteTargetUrl);
  const { buffer, plates } = await blurPlates(original);
  if (!buffer.length) throw new Error('Empty image after processing');
  if (process.env.PLATE_BLUR_LOG === 'true') {
    console.log(`[PlateBlur] ${absoluteTargetUrl} → ${plates.length} plate(s) ${JSON.stringify(plates.map((p) => `${p.pass}:${p.conf}`))}`);
  }

  // Written under a temporary name and renamed once complete, so a half-written file is never served.
  const tmpPath = `${cachedFilePath}.${process.pid}.${Date.now()}.part`;
  await fs.promises.writeFile(tmpPath, buffer);
  await fs.promises.rename(tmpPath, cachedFilePath);
  return buffer;
}

function cachePathFor(absoluteTargetUrl) {
  // A safe filename based on the URL hash (and the processing version)
  const hash = crypto.createHash('md5').update(`${CACHE_VERSION}:${absoluteTargetUrl}`).digest('hex');
  return { hash, cachedFilePath: path.join(CACHE_DIR, `${hash}.jpeg`) };
}

/**
 * The plate-processed JPEG for an (already resolved) photo URL: from the disk cache, from a run already in
 * progress, or processed now. Returns null when the processing queue is full.
 */
async function getProcessedImage(absoluteTargetUrl) {
  const { hash, cachedFilePath } = cachePathFor(absoluteTargetUrl);
  if (fs.existsSync(cachedFilePath)) return fs.promises.readFile(cachedFilePath);
  if (!inFlight.has(hash)) {
    const slot = acquireSlot();
    if (!slot) return null;
    inFlight.set(
      hash,
      slot
        .then(() => processImage(absoluteTargetUrl, cachedFilePath).finally(releaseSlot))
        .finally(() => inFlight.delete(hash))
    );
  }
  return inFlight.get(hash);
}

/**
 * The photo address a request is for. Normally `t`, the encrypted token the API hands out. Older app
 * versions wrap whatever URL they were given in `target=` again, so a `target` that is itself one of our
 * token URLs is unwrapped; a plain `target` address (older clients) is still accepted — it only ever
 * returns the processed image, and the caller already knows that address.
 */
function requestedPhoto(query) {
  if (typeof query.t === 'string') return decodeImageToken(query.t);
  const target = query.target;
  if (typeof target !== 'string' || !target) return null;
  try {
    const nested = new URL(target, 'http://placeholder.invalid');
    if (nested.pathname.endsWith('/api/images/blur') && nested.searchParams.has('t')) {
      return decodeImageToken(nested.searchParams.get('t'));
    }
  } catch {
    // not a URL — resolveTarget rejects it below
  }
  return target;
}

exports.getBlurredImage = async (req, res) => {
  const targetUrl = requestedPhoto(req.query);
  if (!targetUrl) {
    return fail(res, 400, 'Missing or invalid photo');
  }

  const absoluteTargetUrl = resolveTarget(targetUrl);
  if (!absoluteTargetUrl) {
    return fail(res, 400, 'Image host not allowed');
  }

  try {
    const buffer = await getProcessedImage(absoluteTargetUrl);
    if (!buffer) return fail(res, 503, 'Image processing busy, please retry');

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    // These photos are public (and always plate-processed). helmet's default "same-origin" stopped browsers
    // from showing them in the web version of the app; native apps never check this header.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    return res.send(buffer);
  } catch (error) {
    console.error(`[PlateBlur] Could not process ${absoluteTargetUrl}:`, error?.message);
    // Never fall back to the original photo: its number plate would be readable.
    if (error?.status === 404) return fail(res, 404, 'Photo not found');
    return fail(res, 502, 'Photo could not be processed');
  }
};

/**
 * Processes every vehicle photo in the background, one at a time, so customers get them from the cache
 * instead of waiting for processing (the disk cache starts empty after every deploy / restart). Photos
 * already cached are skipped instantly, so running it again only picks up newly added photos.
 */
let prewarming = false;
async function prewarmVehiclePhotos() {
  if (prewarming) return;
  prewarming = true;
  const started = Date.now();
  let processed = 0, cached = 0, failed = 0;
  try {
    const Vehicle = require('../../models/vehicle.model');
    const { optimizedImageUrl } = require('../vehicles/vehicle.controller');
    const vehicles = await Vehicle.find({ isDeleted: { $ne: true } }).select('images.url').lean();
    // Exactly the photo URLs the app will ask for (same rendition as GET /api/vehicles hands out).
    const targets = [...new Set(vehicles.flatMap((v) => (v.images || []).map((img) => img?.url).filter(Boolean)))]
      .map((url) => resolveTarget(optimizedImageUrl(url)))
      .filter(Boolean);
    for (const target of targets) {
      if (fs.existsSync(cachePathFor(target).cachedFilePath)) { cached++; continue; }
      try {
        await getProcessedImage(target);
        processed++;
      } catch {
        failed++; // e.g. a photo deleted from storage — counted, and the rest carry on
      }
    }
    console.log(`[PlateBlur] Pre-warm done in ${Math.round((Date.now() - started) / 1000)}s: ${processed} processed, ${cached} already cached, ${failed} unavailable`);
  } catch (err) {
    console.error('[PlateBlur] Pre-warm failed:', err.message);
  } finally {
    prewarming = false;
  }
}

const PREWARM_EVERY_MS = 30 * 60 * 1000;
exports.startPrewarm = () => {
  prewarmVehiclePhotos();
  setInterval(prewarmVehiclePhotos, PREWARM_EVERY_MS).unref();
};

module.exports.resolveTarget = resolveTarget;
