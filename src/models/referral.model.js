const mongoose = require('mongoose');

const referralSchema = new mongoose.Schema({
  referrerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true
  },
  referredId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    default: null
  },
  referredMobile: {
    type: String,
    required: true,
    trim: true
  },
  referredName: {
    type: String,
    trim: true,
    default: ''
  },
  status: {
    type: String,
    enum: ['invited', 'rewarded', 'fraudulent'],
    default: 'invited'
  },
  invitedAt: {
    type: Date,
    default: Date.now
  },
  rewardBookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    default: null
  },
  commissionAmount: {
    type: Number,
    default: 0
  },
  rewardedAt: {
    type: Date
  }
}, {
  timestamps: true,
  toJSON: {
    transform: function(doc, ret) {
      ret.id = ret._id;
      delete ret._id;
      delete ret.__v;
    }
  }
});

// Ensure a referrer can only invite a specific mobile number once
referralSchema.index({ referrerId: 1, referredMobile: 1 }, { unique: true });

module.exports = mongoose.model('Referral', referralSchema);
