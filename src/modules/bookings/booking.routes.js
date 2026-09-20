const express = require('express');
const BookingController = require('./booking.controller');

const protect = require('../../middleware/protect.middleware');

const router = express.Router();
const controller = new BookingController();

router.post('/calculate', controller.quote);
router.get('/my-bookings', protect, controller.getMyBookings);
router.post('/', protect, controller.createBooking);
router.get('/:id/extension-check', protect, controller.checkExtension);
router.post('/:id/extend', protect, controller.extendBooking);
router.post('/:id/cancel', protect, controller.cancelBooking);

// Ride Journey & Milestone Rewards
router.get('/ride-journey', protect, controller.getRideJourney);
router.post('/claim-milestone', protect, controller.claimMilestoneReward);

// Live Tracking & Dispatch Endpoints
router.post('/:id/track-location', protect, controller.updateLocation);
router.get('/:id/track-location', protect, controller.getLocation);
router.post('/:id/driver-status', protect, controller.updateDriverStatus);

module.exports = router;
