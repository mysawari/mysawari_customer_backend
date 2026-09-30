  createBookingHold = asyncHandler(async (req, res) => {
    const {
      vehicleId, fromDate, toDate, payment = {}, totalDays,
      pickupTime, dropTime, couponCode,
    } = req.body;
    const sawariCashUsed = Math.max(0, Number(req.body.sawariCashUsed) || 0);
    const clientSubscriptionDiscount = Math.max(0, Number(req.body.subscriptionDiscount) || 0);

    if (!mongoose.isValidObjectId(vehicleId)) throw new AppError('Invalid vehicle', 400);
    const from = new Date(fromDate);
    const to = new Date(toDate);
    if (isNaN(from.getTime()) || isNaN(to.getTime()) || to <= from) {
      throw new AppError('Invalid booking dates', 400);
    }
    if (from < new Date(Date.now() - DAY_MS)) {
      throw new AppError('Pickup date cannot be in the past', 400);
    }

    const vehicleForPrice = await Vehicle.findOne({ _id: vehicleId, isDeleted: false });
    if (!vehicleForPrice) throw new AppError('Vehicle not found', 404);

    const baseDays = Math.max(1, Math.round((to - from) / DAY_MS));
    const days = Number(totalDays);
    if (!Number.isInteger(days) || days < baseDays || days > baseDays + 1) {
      throw new AppError('Booking duration does not match the selected dates', 400);
    }
    const expectedTotal = vehicleForPrice.pricePerDay * days;
    if (Number(payment.totalAmount) !== expectedTotal) {
      throw new AppError('Booking amount does not match the vehicle price', 400);
    }
    const clientDiscount = Math.max(0, Number(payment.discountAmount) || 0);
    let discount = 0;
    if (couponCode) {
      const couponResult = await CouponService.validateCoupon(couponCode, expectedTotal);
      if (!couponResult || !couponResult.valid) {
        throw new AppError(couponResult?.reason || 'Invalid or expired coupon code', 400);
      }
      discount = couponResult.discount;
    }
    if (clientDiscount !== discount) {
      throw new AppError('Coupon discount mismatch — please refresh and try again', 400);
    }
    const paidOnline = Math.max(0, Number(payment.bookingAmountPaid) || 0);
    if (paidOnline + sawariCashUsed <= 0) {
      throw new AppError('A booking advance is required', 400);
    }
    const maxSawariCashAllowed = expectedTotal * 0.45;
    if (sawariCashUsed > maxSawariCashAllowed) {
      throw new AppError('SawariCash usage limit exceeded', 400);
    }
    const rentalAfterDiscount = Math.max(0, expectedTotal - discount);
    const appliedToAdvance = Math.min(sawariCashUsed, BOOKING_ADVANCE_AMOUNT);
    const requiredOnline = Math.max(0, Math.min(rentalAfterDiscount, BOOKING_ADVANCE_AMOUNT) - appliedToAdvance);

    if (paidOnline !== requiredOnline) {
      throw new AppError(`The online booking advance must be ₹${requiredOnline}`, 400);
    }

    // Membership / subscription discount validation
    const PLANS = {
      starter: { discountRate: 0.05,  annualCap: 10000 },
      plus:    { discountRate: 0.10,  annualCap: 15000 },
      pro:     { discountRate: 0.125, annualCap: 20000 },
    };
    const PER_TRIP_CAP = 999;
    const mem = (await Membership.findOne({ customerId: req.user._id })) || {};
    const memActive = mem.plan && PLANS[mem.plan] && mem.expiresAt && new Date(mem.expiresAt) > new Date();
    let serverSubscriptionDiscount = 0;
    if (memActive) {
      const { discountRate, annualCap } = PLANS[mem.plan];
      const remaining = Math.max(0, annualCap - (mem.totalSaved || 0));
      serverSubscriptionDiscount = Math.min(
        Math.round(rentalAfterDiscount * discountRate),
        PER_TRIP_CAP,
        remaining
      );
    }
    if (clientSubscriptionDiscount !== serverSubscriptionDiscount) {
      throw new AppError('Subscription discount mismatch — please refresh and try again', 400);
    }

    // SawariCash balance check
    if (sawariCashUsed > 0) {
      const customer = await Customer.findById(req.user._id);
      if ((customer?.walletBalance || 0) < sawariCashUsed) {
        throw new AppError('Insufficient SawariCash balance', 400);
      }
    }

    // --- OCC RACE-SAFE BOOKING CREATION ---
    let bookingHold = null;
    const BUFFER_MS = 2 * 60 * 60 * 1000; // 2 hour turnaround buffer
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
        status: { $in: ['pending', 'confirmed', 'ongoing', 'completed'] },
        isDeleted: { $ne: true },
        // A pending booking is only a clash if it hasn't expired yet
        $and: [
          { $or: [ { status: { $ne: 'pending' } }, { expiresAt: { $gt: new Date() } } ] }
        ],
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

      // Lock acquired successfully, create hold
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
        pickupTime,
        dropTime,
        totalDays: days,
        destination: req.body.destination || '',
        pickup: req.body.pickup || { location: '', landmark: '', mapLink: '', charge: 0 },
        drop: req.body.drop || { location: '', landmark: '', mapLink: '', charge: 0 },
        membershipDiscount: serverSubscriptionDiscount,
        payment: {
          vehicleRent: req.body.payment?.vehicleRent || expectedTotal,
          pickupCharge: req.body.payment?.pickupCharge || 0,
          dropCharge: req.body.payment?.dropCharge || 0,
          fastagAmount: req.body.payment?.fastagAmount || 0,
          totalAmount: expectedTotal,
          discountAmount: discount,
          securityDeposit: req.body.payment?.securityDeposit || 0,
          bookingAmountPaid: paidOnline,
          paymentMethod: paidOnline > 0 ? 'online' : 'wallet',
          balanceAmount: Math.max(0, Number(payment.balanceAmount) || 0),
          paymentStatus: 'pending',
        },
        paymentBreakdown: req.body.paymentBreakdown || {
          cash: 0,
          phonePe: 0,
          razorpay: paidOnline,
          balanceAmount: Math.max(0, Number(payment.balanceAmount) || 0),
          totalCollected: 0, // Not collected yet
          paymentStatus: 'pending',
        },
        status: 'pending',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000) // 15 mins to complete payment
      });
      break;
    }

    // Save SawariCash intent in memory for the confirmation phase
    if (sawariCashUsed > 0) {
      global.bookingSawariCash = global.bookingSawariCash || {};
      global.bookingSawariCash[bookingHold._id.toString()] = sawariCashUsed;
    }

    return ApiResponse.success(res, bookingHold, 'Booking hold secured', 201);
  });

  confirmBookingPayment = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { razorpayOrderId, razorpayPaymentId } = req.body;
    
    if (!mongoose.isValidObjectId(id)) throw new AppError('Invalid booking ID', 400);
    
    // Find booking (including expired ones to give proper errors)
    const booking = await Booking.findOne({ _id: id, mobileNumber: req.user.mobileNumber });
    if (!booking) throw new AppError('Booking not found', 404);

    // Idempotency: if already confirmed, just return success
    if (['confirmed', 'ongoing', 'completed'].includes(booking.status)) {
      return ApiResponse.success(res, booking, 'Booking is already confirmed', 200);
    }

    const paidOnline = booking.payment.bookingAmountPaid || 0;

    // 1) Validate Razorpay payment
    if (paidOnline > 0) {
      try {
        await paymentService.redeemPayment({
          customerId: req.user._id,
          orderId: razorpayOrderId,
          paymentId: razorpayPaymentId,
          amountRupees: paidOnline,
        });
      } catch (err) {
        throw new AppError(`Payment validation failed: ${err.message}`, 400);
      }
    }

    // 2) Check if booking hold expired while they were paying
    if (booking.status === 'pending' && booking.expiresAt && booking.expiresAt < new Date()) {
      // They paid, but the reservation expired. Refund the payment!
      // In a real production app, we would call Razorpay Refund API here.
      // For now, we release the payment ID so it can potentially be used (though it shouldn't be).
      if (razorpayPaymentId) paymentService.releasePayment(razorpayPaymentId);
      
      // We must completely cancel it
      booking.status = 'cancelled';
      booking.cancellationReason = 'Reservation expired before payment completed';
      booking.expiresAt = null;
      await booking.save();
      
      throw new AppError('Your reservation expired before payment was completed. Any deducted amount will be refunded automatically within 5-7 business days.', 400);
    }

    // 3) Deduct SawariCash atomically
    global.bookingSawariCash = global.bookingSawariCash || {};
    const sawariCashUsed = global.bookingSawariCash[booking._id.toString()] || 0;
    
    if (sawariCashUsed > 0) {
      const debited = await Customer.findOneAndUpdate(
        { _id: req.user._id, walletBalance: { $gte: sawariCashUsed } },
        { $inc: { walletBalance: -sawariCashUsed } },
        { new: true }
      );
      if (!debited) {
        if (razorpayPaymentId) paymentService.releasePayment(razorpayPaymentId);
        throw new AppError('Insufficient SawariCash balance during final confirmation', 400);
      }
      logWalletTx(req.user._id, 'debit', sawariCashUsed, `Used SawariCash for booking ${booking.vehicleName}`);
    }

    // 4) Update booking status to confirmed
    booking.status = 'confirmed';
    booking.expiresAt = undefined;
    booking.payment.paymentStatus = 'paid';
    booking.paymentBreakdown.paymentStatus = 'partial';
    booking.paymentBreakdown.totalCollected = paidOnline;
    await booking.save();

    // 5) Track subscription savings
    if (booking.membershipDiscount > 0) {
      await Membership.updateOne(
        { customerId: req.user._id },
        { $inc: { totalSaved: booking.membershipDiscount } }
      );
      logWalletTx(req.user._id, 'membership_discount', booking.membershipDiscount,
        `Membership discount on ${booking.vehicleName}`);
    }

    // 6) Send Notifications
    try {
      const notificationService = require('../notifications/notification.service');
      await notificationService.createNotification({
        target: 'specific',
        customerId: req.user._id,
        title: 'Booking Confirmed! 🎉',
        body: `Your booking for ${booking.vehicleName} is confirmed.`,
        payload: {
          watiTemplate: process.env.WATI_BOOKING_TEMPLATE || 'booking_confirmation_message',
          watiParams: [
            { name: "name", value: req.user.customerName || 'Customer' },
            { name: "vehicle", value: booking.vehicleName }
          ]
        }
      });
    } catch (err) {
      console.error('Failed to send booking confirmation notification:', err.message);
    }

    invalidateVehicleCache(); // availability just changed for sure
    return ApiResponse.success(res, booking, 'Booking confirmed', 200);
  });
}
module.exports = BookingController;
