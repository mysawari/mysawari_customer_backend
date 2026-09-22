const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
  customerName: { 
    type: String, 
    trim: true, 
    default: 'New Customer' 
  },
  mobileNumber: { 
    type: String, 
    required: true, 
    unique: true, 
    trim: true 
  },
  email: { 
    type: String, 
    lowercase: true, 
    trim: true, 
    default: '' 
  },
  dob: { 
    type: String, 
    default: '' 
  },
  gender: { 
    type: String, 
    enum: ['Male', 'Female', 'Other', ''], 
    default: '' 
  },
  status: { 
    type: String, 
    enum: ['active', 'blocked'], 
    default: 'active' 
  },
  kycStatus: { 
    type: String, 
    enum: ['pending', 'verified', 'rejected'], 
    default: 'pending' 
  },
  documents: {
    aadhaarNumber: { type: String, default: '' },
    dlNumber: { type: String, default: '' },
  },
  referralCode: { 
    type: String, 
    unique: true, 
    sparse: true 
  },
  signupIp: {
    type: String,
    default: ''
  },
  walletBalance: { 
    type: Number, 
    default: 0 
  },
  rewardsPoints: { 
    type: Number, 
    default: 0 
  },
  // Phone numbers this customer has referred. Additive: existing customers simply have an empty list.
  referrals: [{
    mobileNumber: { type: String, required: true, trim: true },
    name: { type: String, trim: true, default: '' },
    status: { type: String, enum: ['invited', 'rewarded', 'fraudulent'], default: 'invited' },
    invitedAt: { type: Date, default: Date.now },
    // Set once, when the referred person's first trip completes and the commission is credited.
    rewardBookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
    commissionAmount: { type: Number, default: 0 },
    rewardedAt: { type: Date }
  }],
  // Membership / subscription plan
  membership: {
    plan: { type: String, enum: ['starter', 'plus', 'pro', ''], default: '' },
    activatedAt: { type: Date },
    expiresAt: { type: Date },
    totalSaved: { type: Number, default: 0 },
  },
  // Withdrawal requests submitted by the customer
  withdrawalRequests: [{
    amount: { type: Number, required: true },
    method: { type: String, enum: ['upi', 'bank'], required: true },
    details: {
      upiId: { type: String, trim: true },
      accountNumber: { type: String, trim: true },
      ifsc: { type: String, trim: true },
      bankName: { type: String, trim: true },
      accountHolderName: { type: String, trim: true }
    },
    status: { type: String, enum: ['pending', 'released', 'rejected'], default: 'pending' },
    requestedAt: { type: Date, default: Date.now },
    releasedAt: { type: Date }
  }]
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

module.exports = mongoose.model('Customer', customerSchema);
