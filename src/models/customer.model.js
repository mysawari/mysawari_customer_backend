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
  walletBalance: { 
    type: Number, 
    default: 0 
  },
  rewardsPoints: { 
    type: Number, 
    default: 0 
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

module.exports = mongoose.model('Customer', customerSchema);
