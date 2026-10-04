const sharp = require('sharp');
const { detect, iou, loadSessions } = require('./yolo');

/**
 * Number-plate blurring, done inside this backend (replaces the separate Python image service).
 *
 * Search, cheapest first, stopping as soon as a plate is found with confidence:
 *   1. the whole photo, upright;
 *   2. each vehicle found in the photo, cropped and enlarged (small / far-away plates);
 *   3. the whole photo turned ±30° and ±45° (scooter and bike plates are often photographed at a slant,
 *      and the detector barely sees a plate that is tilted that much).
 * Which hits are hidden (tuned on the real fleet photos):
 *  - upright / vehicle passes: confident hits (>= 0.5);
 *  - turned passes: only very confident hits (>= 0.65) — a round headlamp grille or a sticker reaches ~0.55
 *    there, real plates score 0.65-0.85;
 *  - weaker upright hits only when they are big enough to be readable (>= 40 px wide), the spot really holds
 *    characters on a plate (two clearly contrasting tones, whatever the plate colour — white, yellow, black
 *    rental, green EV, red, blue...), and the hit is fairly likely (0.3-0.5, typically a small plate in a
 *    low-resolution photo) or a second pass agrees on it.
 * Everything else (empty plate holders, lamps, decals, badges) is left alone.
 */

const MAX_DIM = 1200; // big phone photos are scaled down first (speed and memory)
const MIN_CONF = 0.2;
const WEAK_CONF = 0.3;
const SURE_CONF = 0.5;
const ROTATED_SURE_CONF = 0.65;
const MIN_WEAK_WIDTH = 40;
const AGREE_IOU = 0.3;
const VEHICLE_CONF = 0.3;
const VEHICLE_CLASSES = [2, 3, 5, 7]; // COCO: car, motorcycle, bus, truck
const ROTATIONS = [-45, -30, 30, 45];
const isRotatedPass = (pass) => pass.startsWith('rot');
const PAD = { r: 114, g: 114, b: 114 };
const JPEG_QUALITY = 80;

const toRad = (deg) => (deg * Math.PI) / 180;

/** Axis-aligned box -> its 4 corners. */
const corners = (b) => [
  [b.x1, b.y1], [b.x2, b.y1], [b.x2, b.y2], [b.x1, b.y2],
];

function boundsOf(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

/** Runs a sharp pipeline to raw RGB pixels: { data, width, height }. */
async function rawImage(pipeline) {
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function cropOf(image, x1, y1, x2, y2) {
  return sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
    .extract({ left: x1, top: y1, width: x2 - x1, height: y2 - y1 });
}

/**
 * Turns the photo by `angle` degrees (clockwise, canvas grown to fit) and returns it with a function mapping
 * a point in the turned photo back to the original.
 */
async function rotated(image, angle) {
  const turned = await rawImage(
    sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } }).rotate(angle, { background: PAD })
  );
  const t = toRad(angle);
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const cx = image.width / 2, cy = image.height / 2;
  const tcx = turned.width / 2, tcy = turned.height / 2;
  const back = ([x, y]) => {
    const dx = x - tcx, dy = y - tcy;
    return [cx + dx * cos + dy * sin, cy - dx * sin + dy * cos];
  };
  return { turned, back };
}

/** Grey-level spread and edge density of a region — a real plate has dark characters on a plain background. */
function looksLikePlate(image, region) {
  const x1 = Math.max(0, Math.floor(region.x1)), y1 = Math.max(0, Math.floor(region.y1));
  const x2 = Math.min(image.width, Math.ceil(region.x2)), y2 = Math.min(image.height, Math.ceil(region.y2));
  const w = x2 - x1, h = y2 - y1;
  if (w < 8 || h < 6) return false;

  const grey = new Float32Array(w * h);
  let sum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = ((y1 + y) * image.width + (x1 + x)) * 3;
      const g = 0.299 * image.data[p] + 0.587 * image.data[p + 1] + 0.114 * image.data[p + 2];
      grey[y * w + x] = g;
      sum += g;
    }
  }
  const mean = sum / grey.length;
  let variance = 0;
  for (const g of grey) variance += (g - mean) ** 2;
  if (Math.sqrt(variance / grey.length) < 15) return false;

  let edges = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = grey[i + 1] - grey[i - 1];
      const gy = grey[i + w] - grey[i - w];
      if (gx * gx + gy * gy > 60 * 60) edges++;
    }
  }
  const density = edges / Math.max(1, (w - 2) * (h - 2));
  return density >= 0.03 && density <= 0.6;
}

/**
 * Does the spot hold characters on a plate? Works for every Indian plate type without listing colours —
 * white / yellow / cream (dark characters), black rental (yellow characters), green EV (white or yellow
 * characters), red temporary / trade, blue diplomatic, BH series, military: a plate is two clearly different
 * tones, characters on a background. The region's grey levels are split in two (Otsu's method); a plate has
 * a strong difference between the two groups, and the characters are a minority of the area — not a blank
 * holder (one tone), not a patch without real contrast.
 */
function hasPlateContrast(image, region) {
  const x1 = Math.max(0, Math.floor(region.x1)), y1 = Math.max(0, Math.floor(region.y1));
  const x2 = Math.min(image.width, Math.ceil(region.x2)), y2 = Math.min(image.height, Math.ceil(region.y2));
  const hist = new Array(256).fill(0);
  let n = 0;
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      const p = (y * image.width + x) * 3;
      hist[Math.round(0.299 * image.data[p] + 0.587 * image.data[p + 1] + 0.114 * image.data[p + 2])]++;
      n++;
    }
  }
  if (n < 50) return false;

  // Otsu: the split that best separates the two tones.
  let total = 0;
  for (let i = 0; i < 256; i++) total += i * hist[i];
  let darkCount = 0, darkSum = 0, best = -1, split = 0;
  for (let t = 0; t < 256; t++) {
    darkCount += hist[t];
    darkSum += t * hist[t];
    const lightCount = n - darkCount;
    if (!darkCount || !lightCount) continue;
    const between = darkCount * lightCount * (darkSum / darkCount - (total - darkSum) / lightCount) ** 2;
    if (between > best) { best = between; split = t; }
  }
  let dc = 0, ds = 0;
  for (let i = 0; i <= split; i++) { dc += hist[i]; ds += i * hist[i]; }
  const lc = n - dc;
  if (!dc || !lc) return false;
  const contrast = (total - ds) / lc - ds / dc;
  const minority = Math.min(dc, lc) / n;
  // No upper limit on the minority share: a plate boxed together with its dark frame / a black bike splits
  // about half and half (measured 0.48-0.49 on a real cream plate).
  return contrast >= 55 && minority >= 0.06;
}

/** Every candidate plate as { points (4 corners in the photo), conf, pass }. */
async function findPlates(image) {
  const found = [];

  // 1. The whole photo, upright.
  for (const b of await detect('plate', image, { conf: MIN_CONF })) {
    found.push({ points: corners(b), conf: b.conf, pass: 'full' });
  }
  if (found.some((f) => f.conf >= SURE_CONF)) return found;

  // 2. Each vehicle, cropped (a little margin) and enlarged.
  const vehicles = await detect('vehicle', image, { conf: VEHICLE_CONF, classes: VEHICLE_CLASSES });
  for (const v of vehicles) {
    const mx = (v.x2 - v.x1) * 0.05, my = (v.y2 - v.y1) * 0.05;
    const x1 = Math.max(0, Math.floor(v.x1 - mx)), y1 = Math.max(0, Math.floor(v.y1 - my));
    const x2 = Math.min(image.width, Math.ceil(v.x2 + mx)), y2 = Math.min(image.height, Math.ceil(v.y2 + my));
    if (x2 - x1 < 32 || y2 - y1 < 32) continue;
    const crop = await rawImage(cropOf(image, x1, y1, x2, y2));
    for (const b of await detect('plate', crop, { conf: MIN_CONF })) {
      found.push({
        points: corners({ x1: b.x1 + x1, y1: b.y1 + y1, x2: b.x2 + x1, y2: b.y2 + y1 }),
        conf: b.conf,
        pass: 'vehicle',
      });
    }
  }
  if (found.some((f) => f.conf >= SURE_CONF)) return found;

  // 3. Slanted plates: the photo turned a few ways. Only confident hits count here (more passes, more noise).
  for (const angle of ROTATIONS) {
    const { turned, back } = await rotated(image, angle);
    for (const b of await detect('plate', turned, { conf: ROTATED_SURE_CONF })) {
      found.push({ points: corners(b).map(back), conf: b.conf, pass: `rot${angle}` });
    }
  }
  return found;
}

/**
 * Is the box's centre inside the photo? A hit in the grey padding around a turned photo maps to outside it.
 * (A close-up whose plate fills the photo legitimately spills past the edges once turned back, so it is the
 * centre that decides, not how much of the box is inside.)
 */
function centreInside(image, b) {
  const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
  return cx >= 0 && cy >= 0 && cx <= image.width && cy <= image.height;
}

/** Applies the rules in the header comment. */
function selectPlates(image, found) {
  const withBounds = found
    .map((f) => ({ ...f, bounds: boundsOf(f.points) }))
    .filter((f) => centreInside(image, f.bounds));
  return withBounds.filter((a, i) => {
    if (isRotatedPass(a.pass)) return a.conf >= ROTATED_SURE_CONF;
    if (a.conf >= SURE_CONF) return true;
    // Weaker hits must be big enough to be readable at all (characters of a plate under ~40 px wide are a
    // few pixels tall — those small hits are badges and decals), hold characters on a plate, and be either
    // fairly likely or seen twice.
    if (a.conf < MIN_CONF || a.bounds.x2 - a.bounds.x1 < MIN_WEAK_WIDTH) return false;
    if (!looksLikePlate(image, a.bounds) || !hasPlateContrast(image, a.bounds)) return false;
    if (a.conf >= WEAK_CONF) return true;
    return withBounds.some((b, j) => j !== i && !isRotatedPass(b.pass) && b.pass !== a.pass && iou(a.bounds, b.bounds) >= AGREE_IOU);
  });
}

/** Average RGB of each quarter of a region, as a 2x2 RGB image (top-left, top-right, bottom-left, bottom-right). */
function quarterAverages(image, x1, y1, w, h) {
  const midX = x1 + Math.floor(w / 2), midY = y1 + Math.floor(h / 2);
  const sums = new Float64Array(12);
  const counts = new Float64Array(4);
  for (let y = y1; y < y1 + h; y++) {
    for (let x = x1; x < x1 + w; x++) {
      const q = (y < midY ? 0 : 2) + (x < midX ? 0 : 1);
      const p = (y * image.width + x) * 3;
      sums[q * 3] += image.data[p];
      sums[q * 3 + 1] += image.data[p + 1];
      sums[q * 3 + 2] += image.data[p + 2];
      counts[q]++;
    }
  }
  const out = Buffer.alloc(12);
  for (let q = 0; q < 4; q++) {
    for (let c = 0; c < 3; c++) out[q * 3 + c] = counts[q] ? Math.round(sums[q * 3 + c] / counts[q]) : 0;
  }
  return out;
}

/**
 * Hides one plate: the area is reduced to a 2x2 colour block, scaled back up and softened, so nothing of the
 * characters survives but it still reads as a blur. Only the plate's own (possibly slanted) outline is
 * covered, grown by a small margin so the outermost characters can't peek out.
 */
async function hidePlate(image, points) {
  const centre = points.reduce((c, p) => [c[0] + p[0] / 4, c[1] + p[1] / 4], [0, 0]);
  const grown = points.map(([x, y]) => [centre[0] + (x - centre[0]) * 1.12, centre[1] + (y - centre[1]) * 1.15]);
  const b = boundsOf(grown);
  const x1 = Math.max(0, Math.floor(b.x1)), y1 = Math.max(0, Math.floor(b.y1));
  const x2 = Math.min(image.width, Math.ceil(b.x2)), y2 = Math.min(image.height, Math.ceil(b.y2));
  const w = x2 - x1, h = y2 - y1;
  if (w < 2 || h < 2) return null;

  // Irreversible by construction: the only thing kept from the plate area is the average colour of each of
  // its four quarters — 12 numbers. Everything drawn over the plate is made from those alone, so the
  // characters are not hidden in the result, they are gone; no tool (de-blur, sharpening, AI) can bring
  // back information that is not there.
  const tiny = quarterAverages(image, x1, y1, w, h);
  const sigma = Math.max(1, Math.min(15, Math.min(w, h) / 4));
  const covered = await sharp(tiny, { raw: { width: 2, height: 2, channels: 3 } })
    .resize(w, h, { fit: 'fill', kernel: 'nearest' })
    .blur(sigma)
    .raw()
    .toBuffer();

  // Mask = the plate outline, so a slanted plate doesn't blank out a big square around it.
  const polygon = grown.map(([x, y]) => `${(x - x1).toFixed(1)},${(y - y1).toFixed(1)}`).join(' ');
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><polygon points="${polygon}" fill="#fff"/></svg>`);
  const patch = await sharp(covered, { raw: { width: w, height: h, channels: 3 } })
    .ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
  return { input: patch, left: x1, top: y1 };
}

/**
 * Photo bytes in, JPEG with every number plate hidden out.
 * Returns { buffer, plates } — `plates` is how many were hidden (for logs / tests).
 */
async function blurPlates(input) {
  // EXIF-rotate, drop transparency, scale down to MAX_DIM — this is the image every pass works on.
  const image = await rawImage(
    sharp(input, { limitInputPixels: 50_000_000 })
      .rotate()
      .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
      .removeAlpha()
      .toColourspace('srgb')
  );

  const plates = selectPlates(image, await findPlates(image));
  const patches = (await Promise.all(plates.map((p) => hidePlate(image, p.points)))).filter(Boolean);

  const buffer = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
    .composite(patches)
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
  return { buffer, plates: plates.map((p) => ({ conf: Number(p.conf.toFixed(2)), pass: p.pass, box: boundsOf(p.points) })) };
}

/** Loads the models ahead of the first photo (called at server start; errors surface in the log). */
function warmUp() {
  return loadSessions();
}

module.exports = { blurPlates, warmUp, findPlates, selectPlates, hidePlate };
