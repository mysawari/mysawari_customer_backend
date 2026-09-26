const CustomerAppLead = require('../../models/customer_app_lead.model');
const ApiResponse = require('../../common/utils/api-response');
const asyncHandler = require('../../common/utils/async-handler');
const mongoose = require('mongoose');

const PAGES = ['explore', 'car-details', 'booking', 'checkout', 'payment'];
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const dateOrUndefined = (v) => {
  if (v === undefined || v === null || v === '') return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
};

class LeadController {
  trackLead = asyncHandler(async (req, res) => {
    // If the user is authenticated, use their mobile number from token.
    // If not, they might have sent it in the body (e.g. they logged in but no token sent, or they just entered it).
    // Actually, the API call will have auth token since they must be logged in to reach checkout.
    // The route requires login: the lead is always the signed-in customer's own number, never one
    // taken from the request body (that would let anyone trigger WhatsApp reminders to any number).
    const mobileNumber = req.user?.mobileNumber;
    const customerName = req.user?.customerName || '';
    
    if (!mobileNumber) {
      return ApiResponse.success(res, null, 'Ignored: No mobile number available to track');
    }

    const body = req.body || {};
    const vehicleId = mongoose.isValidObjectId(body.vehicleId) ? body.vehicleId : undefined;
    const vehicleName = text(body.vehicleName, 100);
    const fromDate = dateOrUndefined(body.fromDate);
    const toDate = dateOrUndefined(body.toDate);
    const amount = Number(body.totalAmount);
    const totalAmount = Number.isFinite(amount) && amount >= 0 && amount <= 10000000 ? amount : undefined;
    const lastPageVisited = PAGES.includes(body.lastPageVisited) ? body.lastPageVisited : 'explore';

    // Upsert a lead for this mobile number that hasn't been messaged or recovered yet.
    // This groups repeated visits by the same customer today into one lead.
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const lead = await CustomerAppLead.findOneAndUpdate(
      {
        mobileNumber,
        createdAt: { $gte: startOfDay }
      },
      {
        $set: {
          customerName,
          vehicleId,
          vehicleName,
          fromDate,
          toDate,
          totalAmount,
          lastPageVisited,
          status: 'abandoned'
        }
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true
      }
    );

    return ApiResponse.success(res, { id: lead._id, status: lead.status }, 'Lead tracked successfully');
  });
}

module.exports = new LeadController();
