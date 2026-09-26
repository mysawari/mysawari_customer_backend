const mongoose = require('mongoose');
const Review = require('../../models/review.model');
const Booking = require('../../models/booking.model');
const AppError = require('../../common/errors/app-error');
const cloudinary = require('../../integrations/cloudinary.service');
const Vehicle = require('../../models/vehicle.model');
const { RIDE_STATUSES } = require('../bookings/booking.constants');

/** Vehicle photos only ever leave the API through the number-plate blurring endpoint. */
const plateSafeUrl = (url) => (url ? `/api/images/blur?target=${encodeURIComponent(url)}` : null);

class ReviewService {
  /**
   * Create a review. When `bookingId` is given it must be one of the customer's
   * completed trips; the review is then tied to that trip and its vehicle, and
   * is verified by definition.
   */
  async createReview(customer, { carId, rating, text, bookingId, placeVisited, images }) {
    const numericRating = Number(rating);
    if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
      throw new AppError('Rating must be a whole number between 1 and 5', 400);
    }
    if (typeof text !== 'string' || !text.trim() || text.trim().length > 1000) {
      throw new AppError('Review text must be between 1 and 1000 characters', 400);
    }
    const place = typeof placeVisited === 'string' ? placeVisited.trim().slice(0, 120) : '';
    const photos = cloudinary.sanitizeImages(images);
    // Every gallery photo is shown with the place it was taken, so a place is required with photos.
    if (photos.length > 0 && place.length < 2) {
      throw new AppError('Please tell us where these photos were taken', 400);
    }

    let vehicleKey = carId ? String(carId) : '';
    let isVerified = false;
    let bookingRef;

    if (bookingId) {
      if (!mongoose.isValidObjectId(bookingId)) throw new AppError('Invalid trip', 400);
      const booking = await Booking.findOne({
        _id: bookingId,
        mobileNumber: customer.mobileNumber,
        status: 'completed',
        isDeleted: { $ne: true },
      });
      if (!booking) throw new AppError('You can review a trip once it has been completed', 400);

      const already = await Review.exists({ userId: customer._id, bookingId: booking._id });
      if (already) throw new AppError('You have already reviewed this trip.', 400);

      vehicleKey = String(booking.vehicleId);
      bookingRef = booking._id;
      isVerified = true;
    } else {
      if (!vehicleKey) throw new AppError('Please provide carId, rating, and text', 400);
      // Only real, live vehicles can be reviewed (any string used to create a review page).
      if (!mongoose.isValidObjectId(vehicleKey) || !(await Vehicle.exists({ _id: vehicleKey, isDeleted: { $ne: true } }))) {
        throw new AppError('Vehicle not found', 404);
      }

      const existing = await Review.exists({ userId: customer._id, carId: vehicleKey });
      if (existing) throw new AppError('You have already reviewed this vehicle.', 400);

      if (mongoose.isValidObjectId(vehicleKey)) {
        isVerified = !!(await Booking.exists({
          mobileNumber: customer.mobileNumber,
          vehicleId: vehicleKey,
          status: { $in: RIDE_STATUSES },
          isDeleted: { $ne: true },
        }));
      }
    }

    const review = await Review.create({
      userId: customer._id,
      carId: vehicleKey,
      rating: numericRating,
      text: text.trim(),
      isVerified,
      bookingId: bookingRef,
      placeVisited: place || undefined,
      images: photos,
    });

    return this.format(review, customer.customerName);
  }

  /**
   * Completed trips from the last 30 days that this customer hasn't reviewed
   * yet (newest first). Older trips aren't prompted, so people with a long
   * history aren't asked about rides from months ago.
   */
  async getPendingReviews(customer) {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const completed = await Booking.find({
      mobileNumber: customer.mobileNumber,
      status: 'completed',
      isDeleted: { $ne: true },
      toDate: { $gte: since },
    })
      .populate('vehicleId', 'vehicleName images')
      .sort({ toDate: -1 })
      .limit(20)
      .lean();
    if (completed.length === 0) return [];

    const mine = await Review.find({ userId: customer._id }).select('bookingId carId').lean();
    const reviewedBookings = new Set(mine.filter((r) => r.bookingId).map((r) => String(r.bookingId)));
    // Older reviews (written before trips were tracked) count for that vehicle.
    const reviewedLegacyCars = new Set(mine.filter((r) => !r.bookingId).map((r) => String(r.carId)));

    return completed
      .filter((b) => {
        const carId = String(b.vehicleId?._id || b.vehicleId);
        return !reviewedBookings.has(String(b._id)) && !reviewedLegacyCars.has(carId);
      })
      .slice(0, 5)
      .map((b) => ({
        bookingId: b._id,
        carId: String(b.vehicleId?._id || b.vehicleId),
        vehicleName: b.vehicleId?.vehicleName || b.vehicleName || 'Vehicle',
        vehicleImage: plateSafeUrl(b.vehicleId?.images?.[0]?.url),
        fromDate: b.fromDate,
        toDate: b.toDate,
      }));
  }

  /** Which trips / vehicles this customer has already reviewed (ids only). */
  async getMyReviewRefs(customer) {
    const mine = await Review.find({ userId: customer._id }).select('bookingId carId').lean();
    return {
      bookingIds: mine.filter((r) => r.bookingId).map((r) => String(r.bookingId)),
      // Reviews written before trips were tracked cover that vehicle.
      legacyCarIds: mine.filter((r) => !r.bookingId).map((r) => String(r.carId)),
    };
  }

  /** Signed-upload parameters for any signed-in customer (the route is rate limited). */
  async getUploadSignature() {
    return cloudinary.getUploadSignature();
  }

  /** Get all reviews for a specific car */
  async getReviewsForCar(carId) {
    if (typeof carId !== 'string' || carId.length > 64) return [];
    const reviews = await Review.find({ carId: String(carId) })
      .populate('userId', 'customerName')
      .sort({ createdAt: -1 })
      .limit(200);

    return reviews.map((r) => this.format(r, r.userId?.customerName));
  }

  format(review, userName) {
    return {
      id: review._id,
      userName: userName || 'MySawari Customer',
      rating: review.rating,
      text: review.text,
      date: review.createdAt,
      isVerified: review.isVerified,
      placeVisited: review.placeVisited || null,
      images: (review.images || []).map((img) => img.url),
    };
  }
}

module.exports = new ReviewService();
