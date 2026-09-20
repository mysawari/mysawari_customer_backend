const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const routes = require('./routes');
const errorMiddleware = require('./middleware/error.middleware');
const compressJson = require('./middleware/compress.middleware');

const app = express();

// Behind a reverse proxy (e.g. Render) — needed for correct client IPs in rate limiting.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors());
app.use(compressJson);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const path = require('path');
// Uploaded vehicle photos have unique file names, so browsers/apps can cache them for a long time.
app.use('/uploads', express.static(path.join(__dirname, '../uploads'), { maxAge: '30d', immutable: true }));
app.use('/api', routes);

app.use(errorMiddleware);

module.exports = app;
