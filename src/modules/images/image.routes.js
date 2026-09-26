const express = require('express');
const { createLimiter } = require('../../common/utils/rate-limit');
const router = express.Router();
const imageController = require('./image.controller');

// A screen full of vehicle cards loads many photos at once, so this is generous per IP,
// but it stops the endpoint being used to hammer the processing service.
const imageLimiter = createLimiter({ name: 'image', by: 'ip', windowMs: 60 * 1000, max: 300, message: 'Too many image requests, please try again later.' });

// GET /api/images/blur?target=...
router.get('/blur', imageLimiter, imageController.getBlurredImage);

module.exports = router;
