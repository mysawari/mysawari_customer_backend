const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true
  },
  carId: {
    type: String,
    required: true,
    index: true
  },
  rating: {
    type: Number,
    required: true,
    min: 1,
    max: 5
  },
  text: {
    type: String,
    required: true,
    trim: true,
    maxlength: 1000
  },
  isVerified: {
    type: Boolean,
    default: false
  },
  // Set when the review was written for a specific completed trip.
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    index: true
  },
  // Where the customer travelled to on this trip (free text).
  placeVisited: {
    type: String,
    trim: true,
    maxlength: 120
  },
  // Trip photos, stored on Cloudinary.
  images: [{
    _id: false,
    url: { type: String, required: true },
    publicId: { type: String, required: true }
  }]
}, { timestamps: true });

// Prevent multiple reviews for same car by same user (optional, but good practice)
// reviewSchema.index({ user: 1, carId: 1 }, { unique: true });

const Review = mongoose.model('Review', reviewSchema);

module.exports = Review;
