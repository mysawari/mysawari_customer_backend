const reviewService = require('./review.service');
const ApiResponse = require('../../common/utils/api-response');
const asyncHandler = require('../../common/utils/async-handler');
const AppError = require('../../common/errors/app-error');

class ReviewController {
  createReview = asyncHandler(async (req, res) => {
    const { carId, rating, text, bookingId } = req.body || {};
    if ((carId !== undefined && typeof carId !== 'string') || (bookingId !== undefined && typeof bookingId !== 'string')) {
      throw new AppError('Invalid review', 400);
    }

    if ((!carId && !bookingId) || !rating || !text) {
      throw new AppError('Please provide carId, rating, and text', 400);
    }

    const review = await reviewService.createReview(req.user, req.body);
    return ApiResponse.success(res, review, 'Review submitted successfully', 201);
  });

  getPendingReviews = asyncHandler(async (req, res) => {
    const pending = await reviewService.getPendingReviews(req.user);
    return ApiResponse.success(res, pending, 'Pending reviews fetched');
  });

  getMyReviews = asyncHandler(async (req, res) => {
    const refs = await reviewService.getMyReviewRefs(req.user);
    return ApiResponse.success(res, refs, 'Your reviews');
  });

  getUploadSignature = asyncHandler(async (req, res) => {
    const signature = await reviewService.getUploadSignature();
    return ApiResponse.success(res, signature, 'Upload signature');
  });

  getReviewsForCar = asyncHandler(async (req, res) => {
    const { carId } = req.params;
    const reviews = await reviewService.getReviewsForCar(carId);
    return ApiResponse.success(res, reviews, 'Reviews fetched successfully', 200);
  });
}

module.exports = new ReviewController();
