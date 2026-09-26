const Offer = require('../../models/offer.model');

// Active offers are public and identical for every customer, and the home screen of every user asks for
// them. A short cache means a crowd of users costs one database read every few seconds, not one each.
const OFFERS_TTL_MS = 15 * 1000;
const offersCache = new Map(); // type|'' -> { at, promise }

class CouponService {
  static invalidateOffersCache() {
    offersCache.clear();
  }

  /**
   * Fetch all active, non-expired offers.
   * @param {string} [type] - Optional filter: 'coupon' or 'special_deal'
   */
  static async getActiveOffers(type) {
    const key = type || '';
    const hit = offersCache.get(key);
    if (hit && Date.now() - hit.at < OFFERS_TTL_MS) return hit.promise;

    const filter = { active: true, expiryDate: { $gte: new Date() } };
    if (type) filter.type = type;
    // Concurrent requests share one read; a failed read is not cached.
    const promise = Offer.find(filter).sort({ sortOrder: 1, createdAt: -1 }).lean();
    offersCache.set(key, { at: Date.now(), promise });
    promise.catch(() => offersCache.delete(key));
    return promise;
  }

  /**
   * Fetch a single offer by id.
   */
  static async getOfferById(id) {
    return Offer.findById(id).lean();
  }

  /**
   * Create a new offer (coupon or special deal).
   */
  static async createOffer(data) {
    CouponService.invalidateOffersCache();
    // For special deals, auto-calculate discount percent if not provided
    if (data.type === 'special_deal' && data.originalPrice && data.dealPrice && !data.discountPercent) {
      data.discountPercent = Math.round(((data.originalPrice - data.dealPrice) / data.originalPrice) * 100);
    }
    const offer = await Offer.create(data);
    CouponService.invalidateOffersCache();
    return offer.toObject();
  }

  /**
   * Update an existing offer.
   */
  static async updateOffer(id, data) {
    CouponService.invalidateOffersCache();
    // Recalculate discount percent for special deals if prices changed
    if (data.originalPrice && data.dealPrice && !data.discountPercent) {
      data.discountPercent = Math.round(((data.originalPrice - data.dealPrice) / data.originalPrice) * 100);
    }
    const updated = await Offer.findByIdAndUpdate(id, data, { new: true, runValidators: true }).lean();
    CouponService.invalidateOffersCache();
    return updated;
  }

  /**
   * Delete an offer (hard delete).
   */
  static async deleteOffer(id) {
    CouponService.invalidateOffersCache();
    const deleted = await Offer.findByIdAndDelete(id);
    CouponService.invalidateOffersCache();
    return deleted;
  }

  /**
   * Validate a coupon code against a booking amount.
   * Returns the coupon + calculated discount, or null if invalid.
   */
  static async validateCoupon(code, bookingAmount) {
    if (typeof code !== 'string' || !code.trim()) return null;
    bookingAmount = Number(bookingAmount);
    if (!Number.isFinite(bookingAmount) || bookingAmount < 0) return null;

    const coupon = await Offer.findOne({
      type: 'coupon',
      code: code.trim().toUpperCase(),
      active: true,
      expiryDate: { $gte: new Date() },
    }).lean();

    if (!coupon) return null;
    if (bookingAmount < coupon.minimumBooking) {
      return { valid: false, reason: `Minimum booking of ₹${coupon.minimumBooking} required`, coupon };
    }

    let discount = 0;
    if (!Number.isFinite(Number(coupon.discountValue)) || Number(coupon.discountValue) < 0) return null;
    if (coupon.discountType === 'FLAT') {
      discount = Math.min(coupon.discountValue, bookingAmount);
    } else if (coupon.discountType === 'PERCENTAGE') {
      discount = bookingAmount * (Math.min(coupon.discountValue, 100) / 100);
      if (coupon.maximumDiscount) {
        discount = Math.min(discount, coupon.maximumDiscount);
      }
    } else {
      return null;
    }
    discount = Math.max(0, Math.min(discount, bookingAmount));

    return { valid: true, discount: Math.round(discount), coupon };
  }
}

module.exports = CouponService;
