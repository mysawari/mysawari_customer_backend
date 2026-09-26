const mongoose = require('mongoose');

const imageSchema = new mongoose.Schema({
  url: String,
  publicId: String,
});

const offerSchema = new mongoose.Schema({
  // 'coupon' = discount code for checkout, 'special_deal' = vehicle at a special price
  type: {
    type: String,
    enum: ['coupon', 'special_deal'],
    required: true,
  },

  title: { type: String, required: true },
  subtitle: { type: String, default: '' },

  // ── Coupon-specific fields ──
  code: { type: String, sparse: true, uppercase: true, trim: true },
  discountType: { type: String, enum: ['FLAT', 'PERCENTAGE'] },
  discountValue: { type: Number },
  minimumBooking: { type: Number, default: 0 },
  maximumDiscount: { type: Number, default: null },

  // ── Special deal fields ──
  vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle' },
  originalPrice: { type: Number },
  dealPrice: { type: Number },
  discountPercent: { type: Number },

  // ── Common fields ──
  expiryDate: { type: Date, required: true },
  gradientColors: { type: [String], default: ['#6178D8', '#8B5CF6'] },
  icon: { type: String, default: 'tag' },
  image: imageSchema,
  active: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
}, {
  timestamps: true,
});

// Index for efficient querying of active, non-expired offers
offerSchema.index({ active: 1, expiryDate: 1, type: 1 });
// Unique coupon codes (only when code is present)
offerSchema.index({ code: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Offer', offerSchema);
