const BookingCalculator = require('./booking.calculator');
const ApiResponse = require('../../common/utils/api-response');
const asyncHandler = require('../../common/utils/async-handler');

const mongoose = require('mongoose');
const Booking = require('../../models/booking.model');
const Vehicle = require('../../models/vehicle.model');
const Customer = require('../../models/customer.model');
const AppError = require('../../common/errors/app-error');
const paymentService = require('../payments/payment.service');
const { invalidateVehicleCache } = require('../vehicles/vehicle.controller');
const { BOOKING_ADVANCE_AMOUNT, ON_TRIP_STATUS, CLOSED_BOOKING_STATUSES, EXTENDABLE_STATUSES, RIDE_STATUSES } = require('./booking.constants');

const DAY_MS = 24 * 60 * 60 * 1000;
const DRIVER_RATE_PER_DAY = 1400;

function logWalletTx(customerId, type, amount, description) {
  global.walletTransactions = global.walletTransactions || [];
  global.walletTransactions.push({
    id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    customerId: customerId.toString(),
    type,
    amount,
    description,
    date: new Date().toISOString(),
  });
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

// In-memory store for ride journey milestones & rewards (no DB changes)
// Keyed by mobileNumber → { claimedMilestones: string[], rewards: [] }
const rideJourneyStore = new Map();

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
    const { pickup, dropoff, couponCode } = req.body;
    const quote = await this.calculator.calculateQuote(pickup, dropoff, couponCode);
    return ApiResponse.success(res, quote);
  });

  getMyBookings = asyncHandler(async (req, res) => {
    const { mobileNumber, createdAt } = req.user;
    
    // Build query to only fetch bookings made after the user created their account (day of download)
    const query = { mobileNumber, isDeleted: { $ne: true } };
    if (createdAt) {
      query.createdAt = { $gte: createdAt };
    }

    const bookings = await Booking.find(query).populate('vehicleId').sort({ createdAt: -1 });
    // Cancellation outcome is derived from the policy (no extra DB fields needed).
    return ApiResponse.success(res, bookings.map(withCancellationOutcome));
  });

  createBooking = asyncHandler(async (req, res) => {
    const {
      vehicleId, fromDate, toDate, payment = {}, totalDays,
      pickupTime, dropTime, razorpayOrderId, razorpayPaymentId,
    } = req.body;
    const sawariCashUsed = Math.max(0, Number(req.body.sawariCashUsed) || 0);

    if (!mongoose.isValidObjectId(vehicleId)) throw new AppError('Invalid vehicle', 400);
    const from = new Date(fromDate);
    const to = new Date(toDate);
    if (isNaN(from.getTime()) || isNaN(to.getTime()) || to < from) {
      throw new AppError('Invalid booking dates', 400);
    }
    if (from < new Date(Date.now() - DAY_MS)) {
      throw new AppError('Pickup date cannot be in the past', 400);
    }

    const vehicle = await Vehicle.findOne({ _id: vehicleId, isDeleted: false });
    if (!vehicle) throw new AppError('Vehicle not found', 404);
    if (['maintenance', 'service'].includes(vehicle.status)) throw new AppError('Vehicle is not available for booking', 409);
    // "rent" = the vehicle is out with a customer right now, so it can't start a trip today.
    const todayUtc = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
    if (vehicle.status === 'rent' && from.getTime() <= todayUtc) {
      throw new AppError('This vehicle is currently on rent and not available today', 409);
    }

    // Price is derived from the vehicle's real rate, never trusted from the client.
    const baseDays = Math.max(1, Math.round((to - from) / DAY_MS));
    const days = Number(totalDays);
    if (!Number.isInteger(days) || days < baseDays || days > baseDays + 1) {
      throw new AppError('Booking duration does not match the selected dates', 400);
    }
    const expectedTotal = vehicle.pricePerDay * days;
    if (Number(payment.totalAmount) !== expectedTotal) {
      throw new AppError('Booking amount does not match the vehicle price', 400);
    }
    const discount = Math.max(0, Number(payment.discountAmount) || 0);
    if (discount > Math.min((expectedTotal + DRIVER_RATE_PER_DAY * days) * 0.1, 500)) {
      throw new AppError('Invalid discount amount', 400);
    }
    const paidOnline = Math.max(0, Number(payment.bookingAmountPaid) || 0);
    if (paidOnline + sawariCashUsed <= 0) {
      throw new AppError('A booking advance is required', 400);
    }
    // The advance is the fixed booking amount — never more, and exactly that once the trip costs at least that much.
    const advance = paidOnline + sawariCashUsed;
    const rentalAfterDiscount = Math.max(0, expectedTotal - discount);
    if (advance > BOOKING_ADVANCE_AMOUNT || (rentalAfterDiscount >= BOOKING_ADVANCE_AMOUNT && advance !== BOOKING_ADVANCE_AMOUNT)) {
      throw new AppError(`The booking amount must be ₹${BOOKING_ADVANCE_AMOUNT}`, 400);
    }

    const clash = await Booking.exists({
      vehicleId,
      status: { $nin: CLOSED_BOOKING_STATUSES },
      isDeleted: { $ne: true },
      fromDate: { $lte: to },
      toDate: { $gte: from },
    });
    if (clash) throw new AppError('This vehicle is no longer available for the selected dates', 409);

    // 1) Confirm the online part was really paid (with Razorpay itself).
    if (paidOnline > 0) {
      await paymentService.redeemPayment({
        customerId: req.user._id,
        orderId: razorpayOrderId,
        paymentId: razorpayPaymentId,
        amountRupees: paidOnline,
      });
    }

    // 2) Atomically deduct SawariCash (only if the balance still covers it).
    if (sawariCashUsed > 0) {
      const debited = await Customer.findOneAndUpdate(
        { _id: req.user._id, walletBalance: { $gte: sawariCashUsed } },
        { $inc: { walletBalance: -sawariCashUsed } },
        { new: true }
      );
      if (!debited) {
        if (razorpayPaymentId) paymentService.releasePayment(razorpayPaymentId);
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
        tripType: 'local',
        fromDate: from,
        toDate: to,
        pickupTime,
        dropTime,
        totalDays: days,
        payment: {
          totalAmount: expectedTotal,
          discountAmount: discount,
          bookingAmountPaid: paidOnline,
          balanceAmount: Math.max(0, Number(payment.balanceAmount) || 0),
          paymentMethod: paidOnline > 0 ? 'online' : 'wallet',
          paymentStatus: 'paid',
        },
        status: 'confirmed',
      });
    } catch (e) {
      // Nothing was booked — give the cash back and free the payment for a retry.
      if (sawariCashUsed > 0) {
        await Customer.updateOne({ _id: req.user._id }, { $inc: { walletBalance: sawariCashUsed } });
      }
      if (razorpayPaymentId) paymentService.releasePayment(razorpayPaymentId);
      throw e;
    }

    if (sawariCashUsed > 0) {
      global.bookingSawariCash = global.bookingSawariCash || {};
      global.bookingSawariCash[booking._id.toString()] = sawariCashUsed;
      logWalletTx(req.user._id, 'debit', sawariCashUsed, `Used SawariCash for booking ${vehicle.vehicleName}`);
    }

    invalidateVehicleCache(); // availability just changed
    return ApiResponse.success(res, booking, 'Booking created', 201);
  });

  cancelBooking = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { cancellationReason } = req.body;
    if (!mongoose.isValidObjectId(id)) throw new AppError('Booking not found', 404);

    const booking = await Booking.findOne({ _id: id, mobileNumber: req.user.mobileNumber });
    if (!booking) throw new AppError('Booking not found', 404);

    if (booking.status === 'cancelled') throw new AppError('Booking is already cancelled', 400);
    if (!['pending', 'confirmed'].includes(booking.status)) {
      throw new AppError('Only upcoming bookings can be cancelled', 400);
    }

    // Policy is evaluated at the moment of cancellation.
    const outcome = cancellationOutcome(booking, new Date());

    booking.status = 'cancelled';
    booking.cancellationReason = cancellationReason || 'Customer cancelled';
    await booking.save();

    // Refund SawariCash if used
    global.bookingSawariCash = global.bookingSawariCash || {};
    const bookingKey = booking._id.toString();
    const usedCash = global.bookingSawariCash[bookingKey];
    if (usedCash && usedCash > 0) {
      delete global.bookingSawariCash[bookingKey];
      await Customer.updateOne({ _id: req.user._id }, { $inc: { walletBalance: usedCash } });
      logWalletTx(req.user._id, 'credit', usedCash, 'Refund for cancelled booking');
    }

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
    const { additionalDays, withDriver, razorpayOrderId, razorpayPaymentId } = req.body;
    if (!mongoose.isValidObjectId(id)) throw new AppError('Booking not found', 404);

    const booking = await Booking.findOne({ _id: id, mobileNumber: req.user.mobileNumber });
    if (!booking) throw new AppError('Booking not found', 404);

    const quote = await this.quoteExtension(booking, additionalDays, !!withDriver);
    if (!quote.available) throw new AppError(quote.message, 409);

    // Extensions are paid online in full — confirm the payment with Razorpay.
    await paymentService.redeemPayment({
      customerId: req.user._id,
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
      amountRupees: quote.additionalAmount,
    });

    try {
      booking.toDate = quote.newTo;
      booking.totalDays = (booking.totalDays || 1) + quote.additionalDays;
      booking.payment.totalAmount = (booking.payment.totalAmount || 0) + quote.additionalAmount;
      booking.payment.bookingAmountPaid = (booking.payment.bookingAmountPaid || 0) + quote.additionalAmount;
      await booking.save();
    } catch (e) {
      paymentService.releasePayment(razorpayPaymentId);
      throw e;
    }

    invalidateVehicleCache();
    return ApiResponse.success(res, withCancellationOutcome(booking), 'Booking extended');
  });

  // ─── RIDE JOURNEY TRACKING (Read-only DB aggregation + In-Memory rewards) ───

  getRideJourney = asyncHandler(async (req, res) => {
    const { mobileNumber } = req.user;

    // READ-ONLY aggregation — we only query existing bookings, never write to DB
    const allBookings = await Booking.find({ mobileNumber }).populate('vehicleId').sort({ createdAt: -1 }).lean();

    const completedBookings = allBookings.filter(b => b.status === 'completed');
    const confirmedBookings = allBookings.filter(b => ['confirmed', 'ongoing', ON_TRIP_STATUS].includes(b.status));
    const cancelledBookings = allBookings.filter(b => b.status === 'cancelled');

    const totalRides = completedBookings.length + confirmedBookings.length;
    const totalSpent = allBookings
      .filter(b => b.status !== 'cancelled')
      .reduce((sum, b) => sum + (b.payment?.totalAmount || 0), 0);

    const tier = computeTier(totalRides);

    // Determine which milestones are available vs claimed
    const journeyData = rideJourneyStore.get(mobileNumber) || { claimedMilestones: [], rewards: [] };
    
    const milestones = MILESTONES.map(m => ({
      ...m,
      unlocked: totalRides >= m.rides,
      claimed: journeyData.claimedMilestones.includes(m.label),
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
    const { milestoneLabel } = req.body;

    if (!milestoneLabel) {
      return ApiResponse.error(res, 'milestoneLabel is required', 400);
    }

    // Verify the milestone exists
    const milestone = MILESTONES.find(m => m.label === milestoneLabel);
    if (!milestone) {
      return ApiResponse.error(res, 'Invalid milestone', 400);
    }

    // Check ride count (read-only DB query)
    const totalRides = await Booking.countDocuments({
      mobileNumber,
      status: { $in: RIDE_STATUSES },
    });

    if (totalRides < milestone.rides) {
      return ApiResponse.error(res, `You need ${milestone.rides - totalRides} more rides to unlock this reward`, 400);
    }

    // Check if already claimed (in-memory)
    const journeyData = rideJourneyStore.get(mobileNumber) || { claimedMilestones: [], rewards: [] };

    if (journeyData.claimedMilestones.includes(milestoneLabel)) {
      return ApiResponse.error(res, 'This milestone reward has already been claimed', 400);
    }

    // Claim the reward (in-memory only, no DB write)
    journeyData.claimedMilestones.push(milestoneLabel);
    journeyData.rewards.push({
      type: milestone.type,
      label: milestone.label,
      amount: milestone.rewardAmount,
      earnedAt: new Date(),
    });
    rideJourneyStore.set(mobileNumber, journeyData);

    // Update real wallet balance in DB
    req.user.walletBalance = (req.user.walletBalance || 0) + milestone.rewardAmount;
    await req.user.save();

    // Log transaction
    global.walletTransactions = global.walletTransactions || [];
    global.walletTransactions.push({
      id: `tx_${Date.now()}`,
      customerId: req.user._id.toString(),
      type: 'credit',
      amount: milestone.rewardAmount,
      description: `Claimed ${milestone.label} Milestone Reward`,
      date: new Date().toISOString()
    });

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
  
  updateLocation = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { latitude, longitude } = req.body;
    
    const tracking = liveTrackingStore.get(id) || {};
    tracking.customerLocation = { latitude, longitude, updatedAt: new Date() };
    liveTrackingStore.set(id, tracking);
    
    return ApiResponse.success(res, { message: 'Location updated securely in-memory' });
  });

  getLocation = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const tracking = liveTrackingStore.get(id) || {};
    
    return ApiResponse.success(res, tracking);
  });

  updateDriverStatus = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { driverStatus } = req.body; // e.g., 'ON_THE_WAY', 'ARRIVED'
    
    const tracking = liveTrackingStore.get(id) || {};
    tracking.driverStatus = driverStatus;
    tracking.driverStatusUpdatedAt = new Date();
    liveTrackingStore.set(id, tracking);
    
    return ApiResponse.success(res, { message: `Driver status dynamically updated to ${driverStatus}` });
  });
}

module.exports = BookingController;
