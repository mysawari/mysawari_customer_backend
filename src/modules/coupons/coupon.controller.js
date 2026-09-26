const mongoose = require('mongoose');
const CouponService = require('./coupon.service');

const OFFER_TYPES = ['coupon', 'special_deal'];

class CouponController {
  /**
   * @route   GET /api/offers
   * @desc    Get all active offers (coupons + special deals)
   * @access  Public
   * @query   type - optional: 'coupon' | 'special_deal'
   */
  static async getOffers(req, res, next) {
    try {
      const { type } = req.query;
      if (type !== undefined && !OFFER_TYPES.includes(type)) {
        return res.status(400).json({ success: false, message: 'Invalid offer type' });
      }
      const offers = await CouponService.getActiveOffers(type || undefined);
      return res.status(200).json({ success: true, count: offers.length, data: offers });
    } catch (error) {
      next(error);
    }
  }

  /**
   * @route   GET /api/offers/:id
   * @desc    Get a single offer by ID
   * @access  Public
   */
  static async getOfferById(req, res, next) {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(404).json({ success: false, message: 'Offer not found' });
      }
      const offer = await CouponService.getOfferById(req.params.id);
      // Inactive / expired offers are not public.
      if (!offer || !offer.active || new Date(offer.expiryDate) < new Date()) {
        return res.status(404).json({ success: false, message: 'Offer not found' });
      }
      return res.status(200).json({ success: true, data: offer });
    } catch (error) {
      next(error);
    }
  }

  /**
   * @route   POST /api/offers
   * @desc    Create a new offer (coupon or special deal)
   * @access  Admin
   */
  static async createOffer(req, res, next) {
    try {
      const offer = await CouponService.createOffer(req.body);
      return res.status(201).json({ success: true, data: offer });
    } catch (error) {
      // Duplicate coupon code
      if (error.code === 11000) {
        return res.status(400).json({ success: false, message: 'A coupon with this code already exists' });
      }
      next(error);
    }
  }

  /**
   * @route   PUT /api/offers/:id
   * @desc    Update an existing offer
   * @access  Admin
   */
  static async updateOffer(req, res, next) {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(404).json({ success: false, message: 'Offer not found' });
      }
      const offer = await CouponService.updateOffer(req.params.id, req.body);
      if (!offer) {
        return res.status(404).json({ success: false, message: 'Offer not found' });
      }
      return res.status(200).json({ success: true, data: offer });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(400).json({ success: false, message: 'A coupon with this code already exists' });
      }
      next(error);
    }
  }

  /**
   * @route   DELETE /api/offers/:id
   * @desc    Delete an offer
   * @access  Admin
   */
  static async deleteOffer(req, res, next) {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(404).json({ success: false, message: 'Offer not found' });
      }
      const offer = await CouponService.deleteOffer(req.params.id);
      if (!offer) {
        return res.status(404).json({ success: false, message: 'Offer not found' });
      }
      return res.status(200).json({ success: true, message: 'Offer deleted' });
    } catch (error) {
      next(error);
    }
  }

  /**
   * @route   POST /api/offers/validate
   * @desc    Validate a coupon code against a booking amount
   * @access  Public
   */
  static async validateCoupon(req, res, next) {
    try {
      const { code, bookingAmount } = req.body || {};
      const amount = Number(bookingAmount);
      if (typeof code !== 'string' || !code.trim() || code.length > 30 || !Number.isFinite(amount) || amount < 0) {
        return res.status(400).json({ success: false, message: 'code and bookingAmount are required' });
      }
      const result = await CouponService.validateCoupon(code, amount);
      if (!result) {
        return res.status(404).json({ success: false, message: 'Coupon not found or expired' });
      }
      // Only what the app needs — not the whole offer record.
      return res.status(200).json({
        success: true,
        data: { valid: result.valid, discount: result.discount, reason: result.reason, code: result.coupon?.code },
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = CouponController;
