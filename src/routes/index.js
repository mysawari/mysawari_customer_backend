const express = require('express');
const healthRoutes = require('./health.routes');
const authRoutes = require('../modules/auth/auth.routes');
const locationRoutes = require('../modules/locations/location.routes');
const bookingRoutes = require('../modules/bookings/booking.routes');
const customerRoutes = require('../modules/customers/customer.routes');
const reviewRoutes = require('../modules/reviews/review.routes');
const walletRoutes = require('../modules/wallet/wallet.routes');
const router = express.Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/locations', locationRoutes);
router.use('/bookings', bookingRoutes); // Mounted at /bookings for new frontend routes
router.use('/customers/wallet', walletRoutes);
router.use('/customers', customerRoutes);
router.use('/reviews', reviewRoutes);
router.use('/vehicles', require('../modules/vehicles/vehicle.routes'));
router.use('/payments', require('../modules/payments/payment.routes'));
router.use('/leads', require('../modules/leads/lead.routes'));

module.exports = router;
