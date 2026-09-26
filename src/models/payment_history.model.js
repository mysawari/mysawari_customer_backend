const mongoose = require('mongoose');

const paymentHistorySchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company'
  },
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    required: true
  },
  handoverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Handover'
  },
  customer: {
    fullName: {
      type: String,
      trim: true
    },
    mobileNumber: {
      type: String,
      trim: true
    }
  },
  vehicle: {
    vehicleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vehicle'
    },
    vehicleName: {
      type: String,
      trim: true
    },
    vehicleNumber: {
      type: String,
      trim: true
    }
  },
  amount: {
    type: Number,
    required: true
  },
  paymentMethod: {
    type: String,
    required: true
  },
  paymentBreakdown: {
    cash: {
      type: Number,
      default: 0
    },
    phonePe: {
      type: Number,
      default: 0
    },
    razorpay: {
      type: Number,
      default: 0
    }
  },
  type: {
    type: String,
    required: true
  },
  note: {
    type: String,
    trim: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true,
  collection: 'paymenthistories'
});

module.exports = mongoose.model('PaymentHistory', paymentHistorySchema);
