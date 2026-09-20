const express = require('express');
const router = express.Router();
const VehicleController = require('./vehicle.controller');
const protect = require('../../middleware/protect.middleware');

router.get('/', VehicleController.getAvailableVehicles);

module.exports = router;
