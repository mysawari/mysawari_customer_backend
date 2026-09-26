const mongoose = require('mongoose');

const extendBookingSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      required: true,
    },
    handoverId: {
      type: mongoose.Schema.Types.ObjectId,
      // Reference to the operations app 'handovers' collection
    },
    vehicleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vehicle',
      required: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
    },
    mobileNumber: {
      type: String,
      required: true,
    },
    additionalDays: {
      type: Number,
      required: true,
    },
    newToDate: {
      type: Date,
      required: true,
    },
    additionalAmount: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ExtendBooking', extendBookingSchema, 'extend_booking');
