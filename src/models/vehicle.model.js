const mongoose = require('mongoose');

const imageSchema = new mongoose.Schema({
  url: String,
  publicId: String
});

const maintenanceSchema = new mongoose.Schema({
  required: { type: Boolean, default: false },
  reason: String,
  estimatedDays: Number,
  estimatedCompletionDate: Date,
  markedBy: mongoose.Schema.Types.ObjectId,
  markedAt: Date
});

const vehicleSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  vehicleName: { type: String, required: true },
  vehicleNumber: { type: String, required: true, unique: true },
  manufacturer: { type: String },
  model: { type: String },
  variant: { type: String },
  vehicleType: { type: String },
  fuelType: { type: String },
  transmission: { type: String },
  seatingCapacity: { type: Number },
  color: { type: String },
  chassisNumber: { type: String },
  engineNumber: { type: String },
  registrationDate: { type: Date },
  insuranceValidUpto: { type: Date },
  pucValidUpto: { type: Date },
  fitnessValidUpto: { type: Date },
  notes: { type: String },
  images: [imageSchema],
  status: { type: String, enum: ['available', 'booked', 'maintenance'], default: 'available' },
  isDeleted: { type: Boolean, default: false },
  maintenance: maintenanceSchema,
  pricePerDay: { type: Number, required: true }
}, {
  timestamps: true
});

module.exports = mongoose.model('Vehicle', vehicleSchema);
