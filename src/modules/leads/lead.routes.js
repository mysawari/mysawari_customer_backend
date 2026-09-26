const express = require('express');
const { createLimiter } = require('../../common/utils/rate-limit');
const router = express.Router();
const controller = require('./lead.controller');
const protect = require('../../middleware/protect.middleware');

const leadLimiter = createLimiter({ name: 'lead', by: 'user', windowMs: 60 * 60 * 1000, max: 60, message: 'Too many requests, please try again later.' });

router.post('/track', protect, leadLimiter, controller.trackLead);

module.exports = router;
