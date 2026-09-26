const express = require('express');
const LocationController = require('./location.controller');
const { createLimiter } = require('../../common/utils/rate-limit');

const router = express.Router();
const controller = new LocationController();

// Rate limiter: Max 60 requests per minute per IP for location API
const locationLimiter = createLimiter({ name: 'location', by: 'ip', windowMs: 60 * 1000, max: 60, message: 'Too many location requests, please try again later.' });

router.get('/search', locationLimiter, controller.autocomplete);
router.get('/reverse', locationLimiter, controller.reverse);

module.exports = router;
