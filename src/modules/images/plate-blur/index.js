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
 *  - weaker upright hits only when the spot really holds characters on a plate background (white, yellow, or
 *    the black-and-yellow of rental plates) AND the hit is fairly likely (0.3-0.5, typically a small plate in a
 *    low-resolution photo) or a second pass agrees on it.
 * Everything else (empty plate holders, lamps, decals, badges) is left alone.
 */

const MAX_DIM = 1200; // big phone photos are scaled down first (speed and memory)
const MIN_CONF = 0.2;
const WEAK_CONF = 0.3;
const SURE_CONF = 0.5;
const ROTATED_SURE_CONF = 0.65;
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
 * Does the spot hold characters on a number-plate background? Counts plate-background pixels (white / cream, or yellow / orange)
 * and dark pixels (the characters — or, on a black rental plate, the background with yellow characters).
 */
function hasPlateColours(image, region) {
  const x1 = Math.max(0, Math.floor(region.x1)), y1 = Math.max(0, Math.floor(region.y1));
  const x2 = Math.min(image.width, Math.ceil(region.x2)), y2 = Math.min(image.height, Math.ceil(region.y2));
  let n = 0, white = 0, yellow = 0, dark = 0;
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      const p = (y * image.width + x) * 3;
      const r = image.data[p], g = image.data[p + 1], b = image.data[p + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max ? (max - min) / max : 0;
      let hue = 0;
      if (max !== min) {
        if (max === r) hue = 60 * (((g - b) / (max - min)) % 6);
        else if (max === g) hue = 60 * ((b - r) / (max - min) + 2);
        else hue = 60 * ((r - g) / (max - min) + 4);
        if (hue < 0) hue += 360;
      }
      n++;
      // White plates photographed in warm light look cream / peach, so "white" allows some saturation.
      if (max >= 130 && sat <= 0.4) white++;
      else if (hue >= 15 && hue <= 70 && sat >= 0.3 && max >= 110) yellow++;
      if (max <= 90) dark++;
    }
  }
  if (!n) return false;
  const light = (white + yellow) / n, darkShare = dark / n, yellowShare = yellow / n;
  const lightPlate = light >= 0.25 && darkShare >= 0.1 && darkShare <= 0.6; // dark characters on white / yellow
  const rentalPlate = darkShare >= 0.4 && yellowShare >= 0.05; // yellow characters on black
  return lightPlate || rentalPlate;
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

/** Share of a box that lies inside the photo (a hit in a turned photo's padding maps to outside it). */
function insideShare(image, b) {
  const area = (b.x2 - b.x1) * (b.y2 - b.y1);
  if (area <= 0) return 0;
  const w = Math.max(0, Math.min(image.width, b.x2) - Math.max(0, b.x1));
  const h = Math.max(0, Math.min(image.height, b.y2) - Math.max(0, b.y1));
  return (w * h) / area;
}

/** Applies the rules in the header comment. */
function selectPlates(image, found) {
  const withBounds = found
    .map((f) => ({ ...f, bounds: boundsOf(f.points) }))
    .filter((f) => insideShare(image, f.bounds) >= 0.6);
  return withBounds.filter((a, i) => {
    if (isRotatedPass(a.pass)) return a.conf >= ROTATED_SURE_CONF;
    if (a.conf >= SURE_CONF) return true;
    // Weaker hits must hold characters on a plate background, and be either fairly likely or seen twice.
    if (a.conf < MIN_CONF || !looksLikePlate(image, a.bounds) || !hasPlateColours(image, a.bounds)) return false;
    if (a.conf >= WEAK_CONF) return true;
    return withBounds.some((b, j) => j !== i && !isRotatedPass(b.pass) && b.pass !== a.pass && iou(a.bounds, b.bounds) >= AGREE_IOU);
  });
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

  const tiny = await cropOf(image, x1, y1, x2, y2).resize(2, 2, { fit: 'fill' }).raw().toBuffer();
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

module.exports = { blurPlates, warmUp, findPlates, selectPlates };
