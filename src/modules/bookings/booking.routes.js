const express = require('express');
const { createLimiter } = require('../../common/utils/rate-limit');
const BookingController = require('./booking.controller');

const protect = require('../../middleware/protect.middleware');
const requireAdminKey = require('../../middleware/adminKey.middleware');

const router = express.Router();
const controller = new BookingController();

const limiter = (name, by, windowMs, max, message) => createLimiter({ name, by, windowMs, max, message });

// Booking creation is a financial operation — limit to prevent spam.
const bookingLimiter = limiter('booking', 'user', 60 * 60 * 1000, 10, 'Too many booking attempts, please try again later.');
// Payment confirmation is retried by the app, but must not be hammered.
const confirmLimiter = limiter('booking-confirm', 'user', 10 * 60 * 1000, 30, 'Too many attempts, please try again later.');
// Public quote endpoint calls a paid Google API — keep it from being used to run up the bill.
const quoteLimiter = limiter('quote', 'ip', 60 * 1000, 20, 'Too many requests, please try again later.');
// Reading your own bookings / tracking is cheap, but bounded per customer.
const readLimiter = limiter('booking-read', 'user', 60 * 1000, 120, 'Too many requests, please try again later.');
const actionLimiter = limiter('booking-action', 'user', 60 * 60 * 1000, 30, 'Too many requests, please try again later.');

router.post('/calculate', quoteLimiter, controller.quote);
router.get('/my-bookings', protect, readLimiter, controller.getMyBookings);
router.get('/active-handover', protect, controller.getActiveHandover);
router.post('/', protect, bookingLimiter, controller.createBooking); // Restored for operations app
router.post('/hold', protect, bookingLimiter, controller.createBookingHold);
router.post('/:id/confirm', protect, confirmLimiter, controller.confirmBookingPayment);
// Checkout soft-lock: renewed while the payment sheet is open, released when it is closed.
router.post('/:id/hold/keep-alive', protect, readLimiter, controller.keepHoldAlive);
router.post('/:id/hold/release', protect, readLimiter, controller.releaseHold);
router.get('/:id/extension-check', protect, readLimiter, controller.checkExtension);
router.post('/:id/extend', protect, actionLimiter, controller.extendBooking);
router.post('/:id/cancel', protect, actionLimiter, controller.cancelBooking);

// Ride Journey & Milestone Rewards
router.get('/ride-journey', protect, controller.getRideJourney);
router.post('/claim-milestone', protect, actionLimiter, controller.claimMilestoneReward);

// Live Tracking & Dispatch Endpoints
router.post('/:id/track-location', protect, readLimiter, controller.updateLocation);
router.get('/:id/track-location', protect, readLimiter, controller.getLocation);
// Driver status is set by the operations app, never by a customer.
router.post('/:id/driver-status', requireAdminKey, controller.updateDriverStatus);

module.exports = router;
