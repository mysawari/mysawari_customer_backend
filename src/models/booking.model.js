const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
  customerName: { type: String, trim: true },
  mobileNumber: { type: String, required: true },
  tripType: { type: String, enum: ['local', 'outstation'], default: 'local' },
  fromDate: { type: Date, required: true },
  toDate: { type: Date, required: true },
  pickupTime: { type: String },
  dropTime: { type: String },
  totalDays: { type: Number },
  vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true },
  vehicleName: { type: String },
  payment: {
    totalAmount: { type: Number },
    discountAmount: { type: Number, default: 0 },
    bookingAmountPaid: { type: Number },
    paymentMethod: { type: String },
    balanceAmount: { type: Number },
    paymentStatus: { type: String }
  },
  status: { 
    type: String, 
    enum: ['pending', 'confirmed', 'ongoing', 'completed', 'cancelled'],
    default: 'pending'
  },
  cancellationReason: { type: String },
  isDeleted: { type: Boolean, default: false }
}, {
  timestamps: true
});

module.exports = mongoose.model('Booking', bookingSchema);
