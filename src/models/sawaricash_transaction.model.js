const mongoose = require('mongoose');

const sawariCashTransactionSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
    },
    mobileNumber: {
      type: String,
      default: '',
    },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
    },
    amount: {
      type: Number,
      required: true,
    },
    transactionType: {
      type: String,
      enum: ['debit', 'credit'],
      required: true,
    },
    reason: {
      type: String,
      default: '',
    },
    status: {
      type: String,
      enum: ['pending', 'completed', 'refunded', 'expired'],
      default: 'completed',
    },
    expiresAt: {
      type: Date,
      default: null,
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('SawariCashTransaction', sawariCashTransactionSchema, 'sawaricash_transactions');
