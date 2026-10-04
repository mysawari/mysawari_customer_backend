const path = require('path');
const ort = require('onnxruntime-node');
const sharp = require('sharp');

// libvips keeps a cache of recent operations and runs many threads by default — neither helps a server that
// processes each photo once (results are cached on disk), and both cost memory.
sharp.cache(false);
sharp.concurrency(Math.max(1, Number(process.env.PLATE_BLUR_THREADS) || 2));

// YOLO models exported to ONNX (from the .pt files the old Python image service used) and run in-process.
//  - plate:   YOLO11s fine-tuned on licence plates (morsetechlab/yolov11-license-plate-detection), 1 class.
//  - vehicle: COCO YOLOv8n, only used to find vehicles so small / far plates can be searched for up close.
const MODEL_DIR = path.join(__dirname, 'models');
const MODELS = {
  plate: path.join(MODEL_DIR, 'license_plate_yolo11s.onnx'),
  vehicle: path.join(MODEL_DIR, 'yolov8n.onnx'),
};
const INPUT_SIZE = 640;
const PAD_VALUE = 114; // Ultralytics letterbox grey
const NMS_IOU = 0.7; // Ultralytics default

// Small Render instances have little CPU: a couple of threads per inference, and one inference at a time.
const THREADS = Math.max(1, Number(process.env.PLATE_BLUR_THREADS) || 2);

let sessionsPromise = null;
function loadSessions() {
  if (!sessionsPromise) {
    // The memory arena stays on: measured, it keeps memory flat (~340 MB peak for the whole API) where turning
    // it off fragments the heap and grows it to ~440 MB.
    const options = {
      intraOpNumThreads: THREADS,
      interOpNumThreads: 1,
      graphOptimizationLevel: 'all',
      executionMode: 'sequential',
      enableCpuMemArena: true,
      enableMemPattern: true,
    };
    sessionsPromise = Promise.all([
      ort.InferenceSession.create(MODELS.plate, options),
      ort.InferenceSession.create(MODELS.vehicle, options),
    ])
      .then(([plate, vehicle]) => ({ plate, vehicle }))
      .catch((err) => {
        sessionsPromise = null; // let a later request try again
        throw err;
      });
  }
  return sessionsPromise;
}

// Inference is CPU-bound; running two at once only makes both slower. Everything queues through here.
let queue = Promise.resolve();
function serialize(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

/**
 * Letterboxes an RGB image (raw pixels) into the 640x640 model input, exactly like Ultralytics: scale to fit,
 * centre, pad with grey. Small images are scaled UP, which is what makes far-away plates detectable in crops.
 */
async function letterbox(image) {
  const { data, width, height } = image;
  const r = Math.min(INPUT_SIZE / width, INPUT_SIZE / height);
  const newW = Math.max(1, Math.round(width * r));
  const newH = Math.max(1, Math.round(height * r));
  const padX = (INPUT_SIZE - newW) / 2;
  const padY = (INPUT_SIZE - newH) / 2;
  const left = Math.round(padX - 0.1);
  const top = Math.round(padY - 0.1);

  const pixels = await sharp(data, { raw: { width, height, channels: 3 } })
    .resize(newW, newH, { fit: 'fill', kernel: r > 1 ? 'cubic' : 'lanczos3' })
    .extend({
      top,
      bottom: INPUT_SIZE - newH - top,
      left,
      right: INPUT_SIZE - newW - left,
      background: { r: PAD_VALUE, g: PAD_VALUE, b: PAD_VALUE },
    })
    .raw()
    .toBuffer();

  // HWC uint8 RGB -> CHW float32 0..1
  const area = INPUT_SIZE * INPUT_SIZE;
  const tensor = new Float32Array(3 * area);
  for (let i = 0, p = 0; i < area; i++, p += 3) {
    tensor[i] = pixels[p] / 255;
    tensor[i + area] = pixels[p + 1] / 255;
    tensor[i + 2 * area] = pixels[p + 2] / 255;
  }
  return { tensor, r, left, top };
}

function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = ix * iy;
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return union > 0 ? inter / union : 0;
}

/** Greedy per-class non-maximum suppression. */
function nms(boxes, iouThreshold = NMS_IOU) {
  const sorted = [...boxes].sort((a, b) => b.conf - a.conf);
  const kept = [];
  for (const box of sorted) {
    if (!kept.some((k) => k.cls === box.cls && iou(k, box) > iouThreshold)) kept.push(box);
  }
  return kept;
}

/**
 * Runs one model on an RGB image. Returns boxes in the image's own pixel coordinates:
 * [{ x1, y1, x2, y2, conf, cls }].
 */
async function detect(modelName, image, { conf = 0.25, classes = null } = {}) {
  const sessions = await loadSessions();
  const session = sessions[modelName];
  const { tensor, r, left, top } = await letterbox(image);

  const output = await serialize(async () => {
    const result = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', tensor, [1, 3, INPUT_SIZE, INPUT_SIZE]) });
    return result[session.outputNames[0]];
  });

  // Output is [1, 4 + classes, anchors]: cx, cy, w, h, then one score per class.
  const [, rows, anchors] = output.dims;
  const out = output.data;
  const boxes = [];
  for (let a = 0; a < anchors; a++) {
    let best = -1;
    let bestScore = 0;
    for (let c = 4; c < rows; c++) {
      const s = out[c * anchors + a];
      if (s > bestScore) {
        bestScore = s;
        best = c - 4;
      }
    }
    if (bestScore < conf) continue;
    if (classes && !classes.includes(best)) continue;

    const cx = out[a], cy = out[anchors + a], w = out[2 * anchors + a], h = out[3 * anchors + a];
    const x1 = (cx - w / 2 - left) / r;
    const y1 = (cy - h / 2 - top) / r;
    const x2 = (cx + w / 2 - left) / r;
    const y2 = (cy + h / 2 - top) / r;
    boxes.push({
      x1: Math.max(0, x1),
      y1: Math.max(0, y1),
      x2: Math.min(image.width, x2),
      y2: Math.min(image.height, y2),
      conf: bestScore,
      cls: best,
    });
  }
  return nms(boxes).filter((b) => b.x2 - b.x1 >= 2 && b.y2 - b.y1 >= 2);
}

module.exports = { detect, loadSessions, iou, INPUT_SIZE };
