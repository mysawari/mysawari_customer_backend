const BookingCalculator = require('./booking.calculator');
const ApiResponse = require('../../common/utils/api-response');
const asyncHandler = require('../../common/utils/async-handler');

const mongoose = require('mongoose');
const Booking = require('../../models/booking.model');
const ExtendBooking = require('../../models/extend_booking.model');
const SawariCashTransaction = require('../../models/sawaricash_transaction.model');
const Vehicle = require('../../models/vehicle.model');
const Customer = require('../../models/customer.model');
const CustomerAppLead = require('../../models/customer_app_lead.model');
const Membership = require('../../models/membership.model');
const AppError = require('../../common/errors/app-error');
const paymentService = require('../payments/payment.service');
const CouponService = require('../coupons/coupon.service');
const { securityLog } = require('../../common/utils/security-log');
const { RECORD_TTL_MS, TURNAROUND_MS, blockingFilter, holdLockActive, lockEndsAt } = require('./booking.holds');
const { parseTrip, resolveAmounts, bookingFields, cleanText, DRIVER_RATE_PER_DAY } = require('./booking.money');
const { invalidateVehicleCache } = require('../vehicles/vehicle.controller');
const { BOOKING_ADVANCE_AMOUNT, ON_TRIP_STATUS, CLOSED_BOOKING_STATUSES, EXTENDABLE_STATUSES, RIDE_STATUSES } = require('./booking.constants');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TRACKED_BOOKINGS = 5000;

async function logWalletTx(customerId, type, amount, description) {
  try {
    await SawariCashTransaction.create({
      customerId,
      amount,
      transactionType: type === 'debit' ? 'debit' : 'credit',
      reason: description,
      status: 'completed'
    });
  } catch (err) {
    console.error('Failed to log wallet transaction:', err);
  }
}

/** Free cancellation until 24h before pickup; after that the advance is forfeited. */
function cancellationOutcome(booking, cancelledAt) {
  const paid = booking.payment?.bookingAmountPaid || 0;
  const hoursBefore = (new Date(booking.fromDate).getTime() - cancelledAt.getTime()) / (60 * 60 * 1000);
  const refundable = hoursBefore >= 24;
  return {
    cancellationFee: refundable ? 0 : paid,
    refundAmount: refundable ? paid : 0,
    refundStatus: refundable && paid > 0 ? 'PROCESSING' : undefined,
    cancelledAt: cancelledAt.toISOString(),
  };
}

function withCancellationOutcome(booking) {
  const plain = typeof booking.toObject === 'function' ? booking.toObject() : booking;
  if (plain.status !== 'cancelled') return plain;
  return { ...plain, ...cancellationOutcome(plain, new Date(plain.updatedAt || Date.now())) };
}

// In-memory store for live tracking and transient driver statuses
// Since we cannot alter the database schemas, we use memory to power the operations app live tracking.
const liveTrackingStore = new Map();

// One milestone claim at a time per customer, so a double-tap can't claim twice.
const claimLocks = new Set();
const milestoneReason = (label) => `Claimed ${label} Milestone Reward`;

// Milestone definitions — every Nth ride unlocks a reward
const MILESTONES = [
  { rides: 4,  label: '4th Ride Bonus',  rewardAmount: 50,  type: 'SAWARI_CASH' },
  { rides: 8,  label: '8th Ride Bonus',  rewardAmount: 100, type: 'SAWARI_CASH' },
  { rides: 12, label: '12th Ride Bonus', rewardAmount: 200, type: 'SAWARI_CASH' },
  { rides: 20, label: '20th Ride Bonus', rewardAmount: 500, type: 'SAWARI_CASH' },
  { rides: 30, label: '30th Ride Bonus', rewardAmount: 1000, type: 'SAWARI_CASH' },
];

function computeTier(totalRides) {
  if (totalRides >= 20) return 'Platinum';
  if (totalRides >= 12) return 'Gold';
  if (totalRides >= 8)  return 'Silver';
  return 'Bronze';
}

class BookingController {
  constructor() {
    this.calculator = new BookingCalculator();
  }

  quote = asyncHandler(async (req, res) => {
    const { pickup, dropoff, couponCode } = req.body || {};
    const point = (p) => p && typeof p === 'object'
      && Number.isFinite(Number(p.latitude)) && Math.abs(Number(p.latitude)) <= 90
      && Number.isFinite(Number(p.longitude)) && Math.abs(Number(p.longitude)) <= 180
      ? { latitude: Number(p.latitude), longitude: Number(p.longitude) } : null;
    const from = point(pickup);
    const to = point(dropoff);
    if (!from || !to) throw new AppError('Valid pickup and dropoff coordinates are required', 400);
    const quote = await this.calculator.calculateQuote(from, to, typeof couponCode === 'string' ? couponCode.slice(0, 30) : undefined);
    return ApiResponse.success(res, quote);
  });

  getMyBookings = asyncHandler(async (req, res) => {
    const { mobileNumber, createdAt } = req.user;
    
    // Build query to only fetch bookings made after the user created their account (day of download)
    const query = { mobileNumber, isDeleted: { $ne: true } };
    if (createdAt) {
      query.createdAt = { $gte: createdAt };
    }

    // Only the vehicle fields the app shows. The full document carried the raw (un-blurred) photo URLs.
    const bookings = await Booking.find(query).populate('vehicleId', 'vehicleName pricePerDay').sort({ createdAt: -1 }).limit(300);
    // Cancellation outcome is derived from the policy (no extra DB fields needed).
    return ApiResponse.success(res, bookings.map(withCancellationOutcome));
  });

  getActiveHandover = asyncHandler(async (req, res) => {
    const { mobileNumber } = req.user;
    // Fetch the active handover (where handoverStatus is not returned or completed)
    // using the best approach (native MongoDB driver since there is no Mongoose model here).
    const handover = await mongoose.connection.db.collection('handovers').findOne(
      { 
        "customer.mobileNumber": mobileNumber, 
        handoverStatus: { $nin: ['returned', 'completed', 'cancelled'] },
        isDeleted: { $ne: true }
      },
      {
        projection: {
          _id: 1,
          "vehicle.vehicleName": 1,
          "vehicle.vehicleNumber": 1,
          "vehicle.vehicleColor": 1,
          "vehicle.handoverKm": 1,
          "trip.tripType": 1,
          "trip.numberOfDays": 1,
          "trip.pickupDateTime": 1,
          "trip.dropDateTime": 1,
          "payment.totalAmount": 1,
          "payment.balanceAmount": 1,
          "payment.paymentStatus": 1,
          handoverStatus: 1,
          bookingStatus: 1,
          createdAt: 1
        }
      }
    );

    if (!handover) {
      return ApiResponse.success(res, null, 'No active handover found');
    }
    return ApiResponse.success(res, handover, 'Active handover fetched successfully');
  });

  createBooking = asyncHandler(async (req, res) => {
    const body = req.body || {};
    const { vehicleId, razorpayOrderId, razorpayPaymentId } = body;

    if (!mongoose.isValidObjectId(vehicleId)) throw new AppError('Invalid vehicle', 400);
    const { from, to, days } = parseTrip(body, { allowSameInstant: true });

    const vehicle = await Vehicle.findOne({ _id: vehicleId, isDeleted: false });
    if (!vehicle) throw new AppError('Vehicle not found', 404);
    if (['maintenance', 'service'].includes(vehicle.status)) throw new AppError('Vehicle is not available for booking', 409);
    // "rent" = the vehicle is out with a customer right now, so it can't start a trip today.
    const todayUtc = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
    if (vehicle.status === 'rent' && from.getTime() <= todayUtc) {
      throw new AppError('This vehicle is currently on rent and not available today', 409);
    }

    // Coupons are only ever priced by the server.
    let discount = 0;
    if (body.couponCode) {
      const couponResult = await CouponService.validateCoupon(String(body.couponCode), vehicle.pricePerDay * days);
      if (!couponResult || !couponResult.valid) throw new AppError(couponResult?.reason || 'Invalid or expired coupon code', 400);
      discount = couponResult.discount;
    }
    if ((Number(body.payment?.discountAmount) || 0) !== discount) {
      throw new AppError('Coupon discount mismatch — please refresh and try again', 400);
    }

    const membership = await Membership.findOne({ customerId: req.user._id }).lean();
    const amounts = resolveAmounts({ body, pricePerDay: vehicle.pricePerDay, days, discount, membership });

    const clash = await Booking.exists({
      vehicleId,
      status: { $in: ['confirmed', 'ongoing', ON_TRIP_STATUS] },
      isDeleted: { $ne: true },
      fromDate: { $lte: to },
      toDate: { $gte: from },
    });
    if (clash) throw new AppError('This vehicle is no longer available for the selected dates', 409);

    // 1) Confirm the online part was really paid (with Razorpay itself).
    if (amounts.paidOnline > 0) {
      await paymentService.redeemPayment({
        customerId: req.user._id,
        orderId: razorpayOrderId,
        paymentId: razorpayPaymentId,
        amountRupees: amounts.paidOnline,
      });
    }

    // 2) Atomically deduct SawariCash (only if the balance still covers it).
    if (amounts.sawariCashUsed > 0) {
      const debited = await Customer.findOneAndUpdate(
        { _id: req.user._id, walletBalance: { $gte: amounts.sawariCashUsed } },
        { $inc: { walletBalance: -amounts.sawariCashUsed } },
        { new: true }
      );
      if (!debited) {
        if (razorpayPaymentId) paymentService.releasePaymentAsync(razorpayPaymentId, razorpayOrderId).catch(() => {});
        throw new AppError('Insufficient SawariCash balance', 400);
      }
    }

    let booking;
    try {
      booking = await Booking.create({
        mobileNumber: req.user.mobileNumber,
        customerName: req.user.customerName,
        vehicleId,
        vehicleName: vehicle.vehicleName,
        vehicleNumber: vehicle.vehicleNumber || '',
        vehicleColor: vehicle.color || '',
        tripType: 'local',
        fromDate: from,
        toDate: to,
        totalDays: days,
        ...bookingFields(body, amounts, { paidStatus: 'paid' }),
        status: 'confirmed',
      });
    } catch (e) {
      // Nothing was booked — give the cash back and free the payment for a retry.
      if (amounts.sawariCashUsed > 0) {
        await Customer.updateOne({ _id: req.user._id }, { $inc: { walletBalance: amounts.sawariCashUsed } });
      }
      if (razorpayPaymentId) paymentService.releasePaymentAsync(razorpayPaymentId, razorpayOrderId).catch(() => {});
      throw e;
    }

    if (amounts.sawariCashUsed > 0) {
      await SawariCashTransaction.create({
        customerId: req.user._id,
        mobileNumber: req.user.mobileNumber,
        bookingId: booking._id,
        amount: amounts.sawariCashUsed,
        transactionType: 'debit',
        reason: `Used SawariCash for booking ${vehicle.vehicleName}`,
        status: 'completed'
      });
    }

    // Track subscription savings
    if (amounts.subscriptionDiscount > 0) {
      await Membership.updateOne({ customerId: req.user._id }, { $inc: { totalSaved: amounts.subscriptionDiscount } });
    }

    // Mark any abandoned lead for this user as recovered
    await CustomerAppLead.updateOne(
      { mobileNumber: req.user.mobileNumber, status: 'abandoned' },
      { $set: { status: 'recovered' } }
    );

    invalidateVehicleCache(); // availability just changed
    return ApiResponse.success(res, booking, 'Booking created', 201);
  });

  cancelBooking = asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) throw new AppError('Booking not found', 404);
    const reason = cleanText(req.body?.cancellationReason, 200) || 'Customer cancelled';

    // Atomic status change: two parallel cancel requests used to both pass the status check and both
    // refund the SawariCash. Only the request that actually flips the status continues.
    const booking = await Booking.findOneAndUpdate(
      { _id: id, mobileNumber: req.user.mobileNumber, status: { $in: ['pending', 'confirmed'] } },
      { $set: { status: 'cancelled', cancellationReason: reason } },
      { new: true }
    );
    if (!booking) {
      const existing = await Booking.findOne({ _id: id, mobileNumber: req.user.mobileNumber }).select('status').lean();
      if (!existing) throw new AppError('Booking not found', 404);
      if (existing.status === 'cancelled') throw new AppError('Booking is already cancelled', 400);
      throw new AppError('Only upcoming bookings can be cancelled', 400);
    }

    // Policy is evaluated at the moment of cancellation.
    const outcome = cancellationOutcome(booking, new Date());

    // Refund SawariCash at most once: the transaction is flipped to "refunded" atomically first.
    const sawariCashTx = await SawariCashTransaction.findOneAndUpdate(
      { bookingId: booking._id, status: 'completed', transactionType: 'debit' },
      { $set: { status: 'refunded' } },
      { new: true }
    );
    if (sawariCashTx && sawariCashTx.amount > 0) {
      await Customer.updateOne({ _id: req.user._id }, { $inc: { walletBalance: sawariCashTx.amount } });
      logWalletTx(req.user._id, 'credit', sawariCashTx.amount, 'Refund for cancelled booking');
    }
    // A hold that was never paid only had an intent recorded — it is simply dropped.
    await SawariCashTransaction.deleteMany({ bookingId: booking._id, status: 'pending', transactionType: 'debit' });

    invalidateVehicleCache(); // the vehicle is free again
    return ApiResponse.success(res, { ...booking.toObject(), ...outcome }, 'Booking cancelled');
  });

  // ─── EXTENSIONS ───

  /** Works out (and validates) what extending `booking` by `days` would cost. */
  async quoteExtension(booking, days, withDriver) {
    const additionalDays = Number(days);
    if (!Number.isInteger(additionalDays) || additionalDays < 1 || additionalDays > 30) {
      throw new AppError('Extension must be between 1 and 30 days', 400);
    }
    if (!EXTENDABLE_STATUSES.includes(booking.status)) {
      return { available: false, message: `Cannot extend a ${booking.status} booking`, additionalDays: 0, additionalAmount: 0 };
    }

    const vehicle = await Vehicle.findById(booking.vehicleId);
    if (!vehicle || vehicle.isDeleted) {
      return { available: false, message: 'Vehicle not found', additionalDays: 0, additionalAmount: 0 };
    }

    const newTo = new Date(booking.toDate.getTime() + additionalDays * DAY_MS);
    const clash = await Booking.exists({
      _id: { $ne: booking._id },
      vehicleId: booking.vehicleId,
      status: { $nin: CLOSED_BOOKING_STATUSES },
      isDeleted: { $ne: true },
      // Open bookings, operations-app pending bookings and live checkout holds all block the car.
      $and: [blockingFilter()],
      fromDate: { $lte: newTo },
      toDate: { $gt: booking.toDate },
    });
    if (clash) {
      return {
        available: false,
        message: 'This vehicle is already reserved after your current booking and cannot be extended.',
        additionalDays: 0,
        additionalAmount: 0,
      };
    }

    const perDay = vehicle.pricePerDay + (withDriver ? DRIVER_RATE_PER_DAY : 0);
    return { available: true, additionalDays, additionalAmount: perDay * additionalDays, newTo };
  }

  checkExtension = asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) throw new AppError('Booking not found', 404);
    const booking = await Booking.findOne({ _id: id, mobileNumber: req.user.mobileNumber });
    if (!booking) throw new AppError('Booking not found', 404);

    const { newTo, ...result } = await this.quoteExtension(booking, req.query.days, req.query.withDriver === 'true');
    return ApiResponse.success(res, result);
  });

  extendBooking = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { additionalDays, withDriver } = req.body || {};
    if (!mongoose.isValidObjectId(id)) throw new AppError('Booking not found', 404);

    const booking = await Booking.findOne({ _id: id, mobileNumber: req.user.mobileNumber });
    if (!booking) throw new AppError('Booking not found', 404);

    const quote = await this.quoteExtension(booking, additionalDays, withDriver === true);
    if (!quote.available) throw new AppError(quote.message, 409);

    // One open request per booking, so the endpoint can't be used to flood the operations team.
    const openRequest = await ExtendBooking.exists({ bookingId: booking._id, status: 'pending' });
    if (openRequest) throw new AppError('An extension request for this booking is already waiting for approval', 409);

    let handoverId = null;
    // Fetch the active handover if any exists for this booking/vehicle
    const activeHandover = await mongoose.connection.db.collection('handovers').findOne({
      "customer.mobileNumber": req.user.mobileNumber,
      "vehicle.vehicleId": booking.vehicleId.toString(),
      handoverStatus: { $nin: ['returned', 'completed', 'cancelled'] },
      isDeleted: { $ne: true }
    });
    if (activeHandover) {
      handoverId = activeHandover._id;
    }

    const extensionReq = await ExtendBooking.create({
      bookingId: booking._id,
      handoverId: handoverId,
      vehicleId: booking.vehicleId,
      customerId: req.user._id,
      mobileNumber: req.user.mobileNumber,
      additionalDays: quote.additionalDays,
      newToDate: quote.newTo,
      additionalAmount: quote.additionalAmount,
      status: 'pending' // No changes in other collections, ops app will review this
    });

    return ApiResponse.success(res, extensionReq, 'Booking extension request submitted successfully');
  });

  // ─── RIDE JOURNEY TRACKING (Read-only DB aggregation + In-Memory rewards) ───

  getRideJourney = asyncHandler(async (req, res) => {
    const { mobileNumber } = req.user;

    // READ-ONLY aggregation — we only query existing bookings, never write to DB
    const allBookings = await Booking.find({ mobileNumber }).populate('vehicleId', 'vehicleName').sort({ createdAt: -1 }).lean();

    const completedBookings = allBookings.filter(b => b.status === 'completed');
    const confirmedBookings = allBookings.filter(b => ['confirmed', 'ongoing', ON_TRIP_STATUS].includes(b.status));
    const cancelledBookings = allBookings.filter(b => b.status === 'cancelled');

    const totalRides = completedBookings.length;
    const totalSpent = completedBookings.reduce((sum, b) => sum + (b.payment?.totalAmount || 0), 0);

    const tier = computeTier(totalRides);

    // Claims are the milestone credits in the customer's SawariCash history, so they survive restarts.
    const claimTx = await SawariCashTransaction.find({
      customerId: req.user._id,
      transactionType: 'credit',
      reason: { $in: MILESTONES.map((m) => milestoneReason(m.label)) },
    }).lean();
    const claimedLabels = MILESTONES.filter((m) => claimTx.some((t) => t.reason === milestoneReason(m.label))).map((m) => m.label);
    const journeyData = {
      rewards: claimTx.map((t) => {
        const m = MILESTONES.find((x) => milestoneReason(x.label) === t.reason);
        return { type: m.type, label: m.label, amount: t.amount, earnedAt: t.createdAt };
      }),
    };

    const milestones = MILESTONES.map(m => ({
      ...m,
      unlocked: totalRides >= m.rides,
      claimed: claimedLabels.includes(m.label),
    }));

    // Find next milestone
    const nextMilestone = MILESTONES.find(m => totalRides < m.rides) || null;
    const ridesToNextMilestone = nextMilestone ? nextMilestone.rides - totalRides : 0;

    // Recent ride history (last 10 bookings, non-cancelled)
    const recentRides = allBookings
      .filter(b => b.status !== 'cancelled')
      .slice(0, 10)
      .map(b => ({
        id: b._id,
        vehicleName: b.vehicleId?.vehicleName || b.vehicleName || 'Vehicle',
        status: b.status,
        fromDate: b.fromDate,
        toDate: b.toDate,
        totalDays: b.totalDays || 1,
        amount: b.payment?.totalAmount || 0,
        createdAt: b.createdAt,
      }));

    return ApiResponse.success(res, {
      totalRides,
      completedRides: completedBookings.length,
      confirmedRides: confirmedBookings.length,
      cancelledRides: cancelledBookings.length,
      totalSpent,
      tier,
      milestones,
      nextMilestone: nextMilestone ? {
        label: nextMilestone.label,
        ridesNeeded: ridesToNextMilestone,
        rewardAmount: nextMilestone.rewardAmount,
      } : null,
      earnedRewards: journeyData.rewards,
      recentRides,
    });
  });

  claimMilestoneReward = asyncHandler(async (req, res) => {
    const { mobileNumber } = req.user;
    const { milestoneLabel } = req.body || {};

    if (!milestoneLabel || typeof milestoneLabel !== 'string') {
      return ApiResponse.error(res, 'milestoneLabel is required', 400);
    }

    // Verify the milestone exists
    const milestone = MILESTONES.find(m => m.label === milestoneLabel);
    if (!milestone) {
      return ApiResponse.error(res, 'Invalid milestone', 400);
    }

    const lockKey = String(req.user._id);
    if (claimLocks.has(lockKey)) return ApiResponse.error(res, 'A claim is already in progress', 409);
    claimLocks.add(lockKey);
    try {
      // Only completed trips count (a confirmed booking can still be cancelled after claiming).
      const totalRides = await Booking.countDocuments({ mobileNumber, status: 'completed', isDeleted: { $ne: true } });
      if (totalRides < milestone.rides) {
        return ApiResponse.error(res, `You need ${milestone.rides - totalRides} more rides to unlock this reward`, 400);
      }

      // The credit record IS the claim: it lives in the database, so a restart can't reset it
      // (the old in-memory list let the same reward be claimed again after every deploy).
      const reason = milestoneReason(milestone.label);
      const existing = await SawariCashTransaction.findOneAndUpdate(
        { customerId: req.user._id, transactionType: 'credit', reason },
        { $setOnInsert: { customerId: req.user._id, mobileNumber, amount: milestone.rewardAmount, transactionType: 'credit', reason, status: 'completed' } },
        { upsert: true, new: false }
      );
      if (existing) {
        return ApiResponse.error(res, 'This milestone reward has already been claimed', 400);
      }

      // $inc, never read-modify-save: saving a stale balance used to overwrite concurrent debits.
      await Customer.updateOne({ _id: req.user._id }, { $inc: { walletBalance: milestone.rewardAmount } });
    } finally {
      claimLocks.delete(lockKey);
    }

    return ApiResponse.success(res, {
      message: `🎉 ${milestone.label} claimed! +${milestone.rewardAmount} SawariCash`,
      reward: {
        type: milestone.type,
        label: milestone.label,
        amount: milestone.rewardAmount,
      },
    });
  });

  // ─── LIVE TRACKING & DISPATCH (In-Memory) ───
  
  /** The booking must belong to the signed-in customer (any customer could read/write any booking before). */
  async ownBookingId(req) {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) throw new AppError('Booking not found', 404);
    const owned = await Booking.exists({ _id: id, mobileNumber: req.user.mobileNumber, isDeleted: { $ne: true } });
    if (!owned) throw new AppError('Booking not found', 404);
    return String(id);
  }

  updateLocation = asyncHandler(async (req, res) => {
    const id = await this.ownBookingId(req);
    const latitude = Number(req.body?.latitude);
    const longitude = Number(req.body?.longitude);
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
      throw new AppError('Valid latitude and longitude are required', 400);
    }

    const tracking = liveTrackingStore.get(id) || {};
    tracking.customerLocation = { latitude, longitude, updatedAt: new Date() };
    liveTrackingStore.set(id, tracking);
    if (liveTrackingStore.size > MAX_TRACKED_BOOKINGS) liveTrackingStore.delete(liveTrackingStore.keys().next().value);

    return ApiResponse.success(res, { message: 'Location updated securely in-memory' });
  });

  getLocation = asyncHandler(async (req, res) => {
    const id = await this.ownBookingId(req);
    const tracking = liveTrackingStore.get(id) || {};
    return ApiResponse.success(res, tracking);
  });

  // Operations app only (route requires the admin key) — a customer must not set their own driver status.
  updateDriverStatus = asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) throw new AppError('Booking not found', 404);
    const DRIVER_STATUSES = ['ASSIGNED', 'ON_THE_WAY', 'ARRIVED', 'HANDED_OVER', 'COMPLETED'];
    const driverStatus = String(req.body?.driverStatus || '').toUpperCase();
    if (!DRIVER_STATUSES.includes(driverStatus)) throw new AppError('Invalid driver status', 400);
    if (!(await Booking.exists({ _id: id }))) throw new AppError('Booking not found', 404);

    const tracking = liveTrackingStore.get(String(id)) || {};
    tracking.driverStatus = driverStatus;
    tracking.driverStatusUpdatedAt = new Date();
    liveTrackingStore.set(String(id), tracking);
    if (liveTrackingStore.size > MAX_TRACKED_BOOKINGS) liveTrackingStore.delete(liveTrackingStore.keys().next().value);

    return ApiResponse.success(res, { message: `Driver status updated to ${driverStatus}` });
  });

  createBookingHold = asyncHandler(async (req, res) => {
    const body = req.body || {};
    const { vehicleId, couponCode } = body;

    if (!mongoose.isValidObjectId(vehicleId)) throw new AppError('Invalid vehicle', 400);
    const { from, to, days } = parseTrip(body);

    const vehicleForPrice = await Vehicle.findOne({ _id: vehicleId, isDeleted: false });
    if (!vehicleForPrice) throw new AppError('Vehicle not found', 404);

    const expectedTotal = vehicleForPrice.pricePerDay * days;
    let discount = 0;
    if (couponCode) {
      if (typeof couponCode !== 'string') throw new AppError('Invalid or expired coupon code', 400);
      const couponResult = await CouponService.validateCoupon(couponCode, expectedTotal);
      if (!couponResult || !couponResult.valid) {
        throw new AppError(couponResult?.reason || 'Invalid or expired coupon code', 400);
      }
      discount = couponResult.discount;
    }
    if ((Number(body.payment?.discountAmount) || 0) !== discount) {
      throw new AppError('Coupon discount mismatch — please refresh and try again', 400);
    }

    const membership = await Membership.findOne({ customerId: req.user._id }).lean();
    const amounts = resolveAmounts({ body, pricePerDay: vehicleForPrice.pricePerDay, days, discount, membership });

    // SawariCash balance check (the actual deduction happens atomically at confirmation)
    if (amounts.sawariCashUsed > 0) {
      const customer = await Customer.findById(req.user._id).select('walletBalance').lean();
      if ((customer?.walletBalance || 0) < amounts.sawariCashUsed) {
        throw new AppError('Insufficient SawariCash balance', 400);
      }
    }

    // One checkout at a time per customer: a new hold releases this customer's earlier holds. This stops one
    // person from soft-locking many cars at once, and a customer retrying payment is never blocked by their
    // own previous attempt. (Operations-app pending bookings have no expiresAt and are never touched.)
    await this.releaseHoldsOf(req.user.mobileNumber, 'Replaced by a newer checkout');

    // --- OCC RACE-SAFE BOOKING CREATION ---
    let bookingHold = null;
    const BUFFER_MS = TURNAROUND_MS;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const vehicle = await Vehicle.findOne({ _id: vehicleId, isDeleted: false });
      if (!vehicle) throw new AppError('Vehicle not found', 404);
      if (['maintenance', 'service'].includes(vehicle.status)) throw new AppError('Vehicle is not available for booking', 409);

      const todayUtc = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
      if (vehicle.status === 'rent' && from.getTime() <= todayUtc) {
        throw new AppError('This vehicle is currently on rent and not available today', 409);
      }

      const clash = await Booking.exists({
        vehicleId,
        status: { $nin: CLOSED_BOOKING_STATUSES },
        isDeleted: { $ne: true },
        // Open bookings, operations-app pending bookings and other customers' live holds block the car.
        $and: [blockingFilter()],
        // Exact Overlap Condition with buffer
        fromDate: { $lt: new Date(to.getTime() + BUFFER_MS) },
        toDate: { $gt: new Date(from.getTime() - BUFFER_MS) },
      });

      if (clash) {
        throw new AppError('This vehicle was just reserved by someone else for these dates', 409);
      }

      // Optimistic Concurrency Control bump
      const updated = await Vehicle.updateOne(
        { _id: vehicleId, __v: vehicle.__v },
        { $inc: { __v: 1 } }
      );

      if (updated.modifiedCount === 0) {
        if (attempt === maxRetries) {
          throw new AppError('High traffic! Could not secure vehicle lock, please try again.', 409);
        }
        continue; // Retry
      }

      // Lock acquired successfully, create hold (every money field comes from resolveAmounts, never the client)
      bookingHold = await Booking.create({
        mobileNumber: req.user.mobileNumber,
        customerName: req.user.customerName,
        vehicleId,
        vehicleName: vehicle.vehicleName,
        vehicleNumber: vehicle.vehicleNumber || '',
        vehicleColor: vehicle.color || '',
        tripType: 'local',
        fromDate: from,
        toDate: to,
        totalDays: days,
        ...bookingFields(body, amounts, { paidStatus: 'pending' }),
        status: 'pending',
        // Record lifetime (TTL clean-up). The lock itself is shorter — see booking.holds.js.
        expiresAt: new Date(Date.now() + RECORD_TTL_MS),
      });
      break;
    }

    // Save SawariCash intent reliably in the DB for the confirmation phase
    if (amounts.sawariCashUsed > 0) {
      await SawariCashTransaction.create({
        customerId: req.user._id,
        mobileNumber: req.user.mobileNumber,
        bookingId: bookingHold._id,
        amount: amounts.sawariCashUsed,
        transactionType: 'debit',
        reason: `Used SawariCash for booking ${bookingHold.vehicleName}`,
        status: 'pending'
      });
    }

    const held = typeof bookingHold.toObject === 'function' ? bookingHold.toObject() : bookingHold;
    return ApiResponse.success(res, { ...held, lockedUntil: lockEndsAt(held) }, 'Booking hold secured', 201);
  });

  confirmBookingPayment = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { razorpayOrderId, razorpayPaymentId } = req.body || {};

    if (!mongoose.isValidObjectId(id)) throw new AppError('Invalid booking ID', 400);
    if ((razorpayOrderId && typeof razorpayOrderId !== 'string') || (razorpayPaymentId && typeof razorpayPaymentId !== 'string')) {
      throw new AppError('Invalid payment details', 400);
    }

    const booking = await Booking.findOne({ _id: id, mobileNumber: req.user.mobileNumber });

    // The booking record is gone (it was cleaned up long after the checkout was abandoned) but money
    // arrived for it: never keep that money — refund it automatically.
    if (!booking) {
      if (razorpayPaymentId) {
        const refundId = await paymentService.refundOrphanPayment({
          customerId: req.user._id, orderId: razorpayOrderId, paymentId: razorpayPaymentId,
          reason: 'Checkout expired before payment completed',
        });
        if (refundId) {
          securityLog('payment_refunded', req, { reason: 'booking_missing', paymentId: razorpayPaymentId });
          throw new AppError('This checkout expired before your payment completed. Your payment has been refunded automatically (5-7 business days).', 409);
        }
      }
      throw new AppError('Booking not found', 404);
    }

    // Idempotency: if already confirmed, just return success
    if (['confirmed', 'ongoing', 'completed', ON_TRIP_STATUS].includes(booking.status)) {
      return ApiResponse.success(res, booking, 'Booking is already confirmed', 200);
    }

    const paidOnline = booking.payment.bookingAmountPaid || 0;

    // A checkout the customer already left (or replaced) but paid anyway: refund, never keep the money.
    if (booking.status !== 'pending') {
      if (paidOnline > 0 && razorpayPaymentId) {
        const refundId = await paymentService.refundOrphanPayment({
          customerId: req.user._id, orderId: razorpayOrderId, paymentId: razorpayPaymentId,
          reason: 'Checkout was closed before payment completed',
        });
        if (refundId) {
          throw new AppError('This checkout was closed before your payment completed. Your payment has been refunded automatically (5-7 business days).', 409);
        }
      }
      throw new AppError('This booking can no longer be confirmed', 400);
    }

    // 1) Validate (and capture) the Razorpay payment
    if (paidOnline > 0) {
      try {
        await paymentService.redeemPayment({
          customerId: req.user._id,
          orderId: razorpayOrderId,
          paymentId: razorpayPaymentId,
          amountRupees: paidOnline,
        });
      } catch (err) {
        securityLog('payment_rejected', req, { booking: String(booking._id), reason: err.message });
        throw new AppError(`Payment validation failed: ${err.message}`, 400);
      }
    }

    // 2) The lock ran out while they were paying. Don't throw the sale away: if the car is still free for
    //    these dates, the booking goes through. Only if someone else really took it is the payment refunded.
    if (!holdLockActive(booking)) {
      const stillFree = await this.reclaimVehicle(booking);
      if (!stillFree) {
        await Booking.updateOne(
          { _id: booking._id, status: 'pending' },
          { 
            $set: { 
              status: 'cancelled', 
              cancellationReason: 'Vehicle was taken by another customer before payment completed',
              'payment.paymentStatus': 'paid',
              'paymentBreakdown.totalCollected': paidOnline
            } 
          }
        );
        await SawariCashTransaction.deleteMany({ bookingId: booking._id, status: 'pending', transactionType: 'debit' });
        
        securityLog('payment_needs_manual_refund', req, { booking: String(booking._id), reason: 'lock_lost' });
        throw new AppError(
          'Sorry — this vehicle was booked by someone else while you were paying. Our team will manually refund your payment; please contact support if you need help.',
          409
        );
      }
    }

    // 3) Atomically move pending -> confirmed. Only one request can win this, so parallel confirms
    //    can't deduct SawariCash or count the membership saving twice.
    const confirmed = await Booking.findOneAndUpdate(
      { _id: booking._id, status: 'pending' },
      {
        $set: {
          status: 'confirmed',
          'payment.paymentStatus': 'paid',
          'paymentBreakdown.paymentStatus': 'partial',
          'paymentBreakdown.totalCollected': paidOnline,
        },
        $unset: { expiresAt: 1 },
      },
      { new: true }
    );
    if (!confirmed) {
      const current = await Booking.findById(booking._id);
      return ApiResponse.success(res, current, 'Booking is already confirmed', 200);
    }

    // 4) Deduct SawariCash atomically
    const pendingTx = await SawariCashTransaction.findOne({
      bookingId: booking._id,
      status: 'pending',
      transactionType: 'debit'
    });
    if (pendingTx && pendingTx.amount > 0) {
      const debited = await Customer.findOneAndUpdate(
        { _id: req.user._id, walletBalance: { $gte: pendingTx.amount } },
        { $inc: { walletBalance: -pendingTx.amount } },
        { new: true }
      );
      if (!debited) {
        // Put the hold back exactly as it was so the customer can retry.
        await Booking.updateOne(
          { _id: booking._id, status: 'confirmed' },
          {
            $set: {
              status: 'pending',
              'payment.paymentStatus': 'pending',
              'paymentBreakdown.paymentStatus': 'pending',
              'paymentBreakdown.totalCollected': 0,
              expiresAt: booking.expiresAt || new Date(Date.now() + RECORD_TTL_MS),
            },
          }
        );
        if (razorpayPaymentId) paymentService.releasePaymentAsync(razorpayPaymentId, razorpayOrderId).catch(() => {});
        throw new AppError('Insufficient SawariCash balance during final confirmation', 400);
      }
      await SawariCashTransaction.updateOne({ _id: pendingTx._id, status: 'pending' }, { $set: { status: 'completed' } });
    }

    // 5) Track subscription savings
    if (confirmed.membershipDiscount > 0) {
      await Membership.updateOne(
        { customerId: req.user._id },
        { $inc: { totalSaved: confirmed.membershipDiscount } }
      );
    }

    // 6) Send Notifications
    try {
      const notificationService = require('../notifications/notification.service');
      await notificationService.createNotification({
        target: 'specific',
        customerId: req.user._id,
        title: 'Booking Confirmed! 🎉',
        body: `Your booking for ${confirmed.vehicleName} is confirmed.`,
        payload: {
          watiTemplate: process.env.WATI_BOOKING_TEMPLATE || 'booking_confirmation_message',
          watiParams: [
            { name: "name", value: req.user.customerName || 'Customer' },
            { name: "vehicle", value: confirmed.vehicleName }
          ]
        }
      });
    } catch (err) {
      console.error('Failed to send booking confirmation notification:', err.message);
    }

    // Mark any abandoned lead for this user as recovered
    await CustomerAppLead.updateOne(
      { mobileNumber: req.user.mobileNumber, status: 'abandoned' },
      { $set: { status: 'recovered' } }
    );

    invalidateVehicleCache(); // availability just changed for sure
    return ApiResponse.success(res, confirmed, 'Booking confirmed', 200);
  });

  /** Cancels this customer's open checkout holds (never operations-app bookings, which have no expiresAt). */
  async releaseHoldsOf(mobileNumber, reason, onlyId) {
    const filter = { mobileNumber, status: 'pending', expiresAt: { $ne: null } };
    if (onlyId) filter._id = onlyId;
    const holds = await Booking.find(filter).select('_id').lean();
    if (!holds.length) return 0;
    const ids = holds.map((h) => h._id);
    await Booking.updateMany({ _id: { $in: ids }, status: 'pending' }, { $set: { status: 'cancelled', cancellationReason: reason } });
    await SawariCashTransaction.deleteMany({ bookingId: { $in: ids }, status: 'pending', transactionType: 'debit' });
    invalidateVehicleCache();
    return ids.length;
  }

  /**
   * After a hold's lock has lapsed: can this customer still have the car? True when nothing else now
   * blocks it for these dates. Serialised against concurrent holds with the same vehicle version check
   * the hold itself uses, so a late payment and a new customer can't both win.
   */
  async reclaimVehicle(booking) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const vehicle = await Vehicle.findOne({ _id: booking.vehicleId, isDeleted: false });
      if (!vehicle || ['maintenance', 'service'].includes(vehicle.status)) return false;
      const clash = await Booking.exists({
        _id: { $ne: booking._id },
        vehicleId: booking.vehicleId,
        status: { $nin: CLOSED_BOOKING_STATUSES },
        isDeleted: { $ne: true },
        $and: [blockingFilter()],
        fromDate: { $lt: new Date(new Date(booking.toDate).getTime() + TURNAROUND_MS) },
        toDate: { $gt: new Date(new Date(booking.fromDate).getTime() - TURNAROUND_MS) },
      });
      if (clash) return false;
      const bumped = await Vehicle.updateOne({ _id: vehicle._id, __v: vehicle.__v }, { $inc: { __v: 1 } });
      if (bumped.modifiedCount === 1) return true;
    }
    return false;
  }

  /**
   * The app calls this every ~45s while the payment sheet is open: the car stays locked for a customer who
   * is actively paying (up to 10 minutes in total), and frees itself 2 minutes after they walk away.
   */
  keepHoldAlive = asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) throw new AppError('Booking not found', 404);
    const hold = await Booking.findOne({ _id: id, mobileNumber: req.user.mobileNumber, status: 'pending', expiresAt: { $ne: null } })
      .select('createdAt updatedAt expiresAt status').lean();
    if (!hold) throw new AppError('Booking not found', 404);
    if (!holdLockActive(hold)) {
      return ApiResponse.success(res, { locked: false, lockedUntil: lockEndsAt(hold) });
    }
    // Any write refreshes updatedAt (Mongoose timestamps) — that is what extends the lock.
    await Booking.updateOne({ _id: hold._id, status: 'pending' }, { $set: { expiresAt: new Date(new Date(hold.createdAt).getTime() + RECORD_TTL_MS) } });
    const now = new Date();
    return ApiResponse.success(res, { locked: true, lockedUntil: lockEndsAt({ ...hold, updatedAt: now }) });
  });

  /** The customer closed the payment sheet: free the car for others straight away. */
  releaseHold = asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) throw new AppError('Booking not found', 404);
    const released = await this.releaseHoldsOf(req.user.mobileNumber, 'Checkout closed by customer', id);
    return ApiResponse.success(res, { released: released > 0 });
  });
}
module.exports = BookingController;
