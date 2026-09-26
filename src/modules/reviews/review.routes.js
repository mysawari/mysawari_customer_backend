const express = require('express');
const { createLimiter } = require('../../common/utils/rate-limit');
const reviewController = require('./review.controller');
const protect = require('../../middleware/protect.middleware');

const router = express.Router();

// Anyone signed in can attach photos, so keep the upload signing endpoint from being hammered.
const uploadLimiter = createLimiter({ name: 'review-upload', by: 'user', windowMs: 15 * 60 * 1000, max: 30, message: 'Too many photo uploads, please try again later.' });

// Review writing is limited so it can't be used to flood a vehicle's page.
const reviewLimiter = createLimiter({ name: 'review', by: 'user', windowMs: 60 * 60 * 1000, max: 10, message: 'Too many reviews, please try again later.' });

router.post('/', protect, reviewLimiter, reviewController.createReview);
// Must stay above '/:carId' so these aren't read as a car id.
router.get('/pending', protect, reviewController.getPendingReviews);
router.get('/mine', protect, reviewController.getMyReviews);
router.get('/upload-signature', protect, uploadLimiter, reviewController.getUploadSignature);
router.get('/:carId', reviewController.getReviewsForCar);

module.exports = router;
