const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
  lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  customerName: { type: String, trim: true },
  mobileNumber: { type: String, required: true },
  alternateMobileNumber: { type: String, default: '' },
  occupation: { type: String, default: '' },
  aadhaarNumber: { type: String, default: '' },
  drivingLicenseNumber: { type: String, default: '' },
  destination: { type: String, default: '' },
  tripType: { type: String, enum: ['local', 'outstation'], default: 'local' },
  fromDate: { type: Date, required: true },
  toDate: { type: Date, required: true },
  pickupTime: { type: String },
  dropTime: { type: String },
  totalDays: { type: Number },
  residents: { type: Number, default: 1 },
  vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true },
  vehicleName: { type: String },
  vehicleNumber: { type: String, default: '' },
  vehicleColor: { type: String, default: '' },

  payment: {
    vehicleRent: { type: Number, default: 0 },
    pickupCharge: { type: Number, default: 0 },
    dropCharge: { type: Number, default: 0 },
    fastagAmount: { type: Number, default: 0 },
    totalAmount: { type: Number },
    discountAmount: { type: Number, default: 0 },
    securityDeposit: { type: Number, default: 0 },
    bookingAmountPaid: { type: Number, default: 0 },
    paymentMethod: { type: String, default: 'online' },
    balanceAmount: { type: Number }, // Kept for backwards compatibility
    paymentStatus: { type: String }  // Kept for backwards compatibility
  },

  paymentBreakdown: {
    cash: { type: Number, default: 0 },
    phonePe: { type: Number, default: 0 },
    razorpay: { type: Number, default: 0 },
    balanceAmount: { type: Number, default: 0 },
    totalCollected: { type: Number, default: 0 },
    paymentStatus: { type: String, default: 'partial' },
  },

  pickupDropRequired: { type: Boolean, default: false },
  serviceType: { type: String, default: 'pickup_drop' },

  pickup: {
    location: { type: String, default: '' },
    landmark: { type: String, default: '' },
    mapLink: { type: String, default: '' },
    charge: { type: Number, default: 0 },
  },

  drop: {
    location: { type: String, default: '' },
    landmark: { type: String, default: '' },
    mapLink: { type: String, default: '' },
    charge: { type: Number, default: 0 },
  },

  pickupDropNotes: { type: String, default: '' },
  status: { 
    type: String, 
    enum: ['pending', 'confirmed', 'ongoing', 'completed', 'cancelled'],
    default: 'pending'
  },
  
  handover: { type: Date, default: null },
  vehicleReturn: { type: Date, default: null },
  remarks: { type: String, default: '' },
  isDeleted: { type: Boolean, default: false },
  
  cancellationReason: { type: String },
  assignedDriver: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver' },
  membershipDiscount: { type: Number, default: 0 },
  expiresAt: { type: Date, index: { expireAfterSeconds: 0 } }
}, {
  timestamps: true
});

module.exports = mongoose.model('Booking', bookingSchema);
