const mongoose = require('mongoose');

// One document per customer's active/most-recent membership. Previously this lived as a `membership`
// subdocument on Customer; pulled into its own collection so membership activation/renewal writes
// (frequent: every trip that applies a subscription discount touches totalSaved) don't take a write
// lock on the whole customer document.
const membershipSchema = new mongoose.Schema({
  membershipId: {
    type: String,
    required: true,
    unique: true,
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true,
    unique: true,
  },
  plan: {
    type: String,
    enum: ['starter', 'plus', 'pro'],
    required: true,
  },
  activatedAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
  totalSaved: {
    type: Number,
    default: 0,
  },
  payment: {
    amount: { type: Number },
    paymentMethod: { type: String },
    paymentBreakdown: {
      cash: { type: Number, default: 0 },
      phonePe: { type: Number, default: 0 },
      razorpay: { type: Number, default: 0 }
    },
    paymentId: { type: String, required: true },
    transactionId: { type: String },
    status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'completed' },
    paidAt: { type: Date, default: Date.now }
  },
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

module.exports = mongoose.model('Membership', membershipSchema);
