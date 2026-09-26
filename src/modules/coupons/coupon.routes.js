const express = require('express');
const router = express.Router();
const CouponController = require('./coupon.controller');
const { createLimiter } = require('../../common/utils/rate-limit');
const requireAdminKey = require('../../middleware/adminKey.middleware');

// Public coupon checking must not be usable to guess valid codes.
const validateLimiter = createLimiter({ name: 'coupon-validate', by: 'ip', windowMs: 15 * 60 * 1000, max: 20, message: 'Too many attempts, please try again later.' });

// Public routes
router.get('/', CouponController.getOffers);
router.get('/:id', CouponController.getOfferById);
router.post('/validate', validateLimiter, CouponController.validateCoupon);

// Admin routes — anyone could otherwise create a 100%-off coupon and use it on a real booking,
// or delete/rewrite every live offer. See adminKey.middleware.js.
router.post('/', requireAdminKey, CouponController.createOffer);
router.put('/:id', requireAdminKey, CouponController.updateOffer);
router.delete('/:id', requireAdminKey, CouponController.deleteOffer);

module.exports = router;
