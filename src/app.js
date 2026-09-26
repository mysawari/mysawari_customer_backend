const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const routes = require('./routes');
const errorMiddleware = require('./middleware/error.middleware');
const compressJson = require('./middleware/compress.middleware');

const app = express();

// Which proxies may set X-Forwarded-For. Trusting a proxy that isn't really there lets any client
// write its own "IP" into that header and dodge every IP-based rate limit and fraud check.
//  - TRUST_PROXY set: used as-is (a hop count like "1", "loopback", or a list of proxy IPs/CIDRs).
//  - On Render (RENDER=true): exactly one proxy — Render's load balancer.
//  - Otherwise (direct / local): no proxy is trusted; the socket address is the client.
function trustProxySetting() {
  const v = process.env.TRUST_PROXY;
  if (v !== undefined && v !== '') {
    if (/^\d+$/.test(v)) return Number(v);
    if (v === 'true') return 1;
    if (v === 'false') return false;
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return process.env.RENDER === 'true' ? 1 : false;
}
app.set('trust proxy', trustProxySetting());

app.use(helmet());

// CORS — restrict to known origins. React Native mobile apps don't send an Origin header,
// so requests without an Origin header are still allowed (they are the mobile app).
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no Origin header (mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
}));

app.use(compressJson);

// Explicit body size limits to prevent oversized payloads from consuming server memory.
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
// Blocks MongoDB operator keys ($ne, $gt, ...) and prototype-pollution keys anywhere in the request.
app.use(require('./middleware/sanitize.middleware'));

const path = require('path');
// Uploaded vehicle photos have unique file names, so browsers/apps can cache them for a long time.
// index: false disables directory listing.
app.use('/uploads', express.static(path.join(__dirname, '../uploads'), { maxAge: '30d', immutable: true, index: false }));
// Global per-IP ceiling across the whole API. Deliberately generous: many mobile users in India share one
// carrier IP, and the app legitimately makes many calls (images, polling). It stops floods, not customers.
const { createLimiter } = require('./common/utils/rate-limit');
app.use('/api', createLimiter({
  name: 'global',
  windowMs: 60 * 1000,
  max: Number(process.env.GLOBAL_RATE_LIMIT_PER_MIN) || 1500,
  message: 'Too many requests, please slow down.',
}));
app.use('/api', routes);

// Unknown API paths get a clean 404 instead of falling through.
app.use('/api', (req, res) => res.status(404).json({ success: false, message: 'Not found' }));

app.use(errorMiddleware);

module.exports = app;
