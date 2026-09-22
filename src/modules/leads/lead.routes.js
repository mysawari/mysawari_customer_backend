const express = require('express');
const router = express.Router();
const controller = require('./lead.controller');
const protect = require('../../middleware/protect.middleware');

router.post('/track', protect, controller.trackLead);

module.exports = router;
