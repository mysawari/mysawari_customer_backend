const mongoose = require('mongoose');

const customerActivitySchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: false, // Could be null if guest
    },
    mobileNumber: {
      type: String,
      required: false,
    },
    sessionId: {
      type: String, // To track guest sessions before login
      required: false,
    },
    action: {
      type: String,
      required: true, // e.g., 'view_screen', 'search_car', 'click_car', 'login'
    },
    screen: {
      type: String,
      required: false,
    },
    details: {
      type: mongoose.Schema.Types.Mixed, // flexible object for extra data (carId, dates, search queries)
      required: false,
    }
  },
  { timestamps: true }
);

customerActivitySchema.index({ action: 1, 'details.bookingId': 1 });
customerActivitySchema.index({ customerId: 1 });
customerActivitySchema.index({ sessionId: 1 });

module.exports = mongoose.model('CustomerActivity', customerActivitySchema, 'customer_activity');
