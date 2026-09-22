const CustomerAppLead = require('../../models/customer_app_lead.model');
const ApiResponse = require('../../common/utils/api-response');
const asyncHandler = require('../../common/utils/async-handler');

class LeadController {
  trackLead = asyncHandler(async (req, res) => {
    // If the user is authenticated, use their mobile number from token.
    // If not, they might have sent it in the body (e.g. they logged in but no token sent, or they just entered it).
    // Actually, the API call will have auth token since they must be logged in to reach checkout.
    const mobileNumber = req.user?.mobileNumber || req.body.mobileNumber;
    const customerName = req.user?.customerName || req.body.customerName || '';
    
    if (!mobileNumber) {
      return ApiResponse.success(res, null, 'Ignored: No mobile number available to track');
    }

    const {
      vehicleId,
      vehicleName,
      fromDate,
      toDate,
      totalAmount,
      lastPageVisited
    } = req.body;

    // Upsert a lead for this mobile number that hasn't been messaged or recovered yet.
    // This groups repeated visits by the same customer today into one lead.
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const lead = await CustomerAppLead.findOneAndUpdate(
      {
        mobileNumber,
        status: 'abandoned',
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
          status: 'abandoned',
          whatsappSent: false // reset in case they changed vehicles
        }
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true
      }
    );

    return ApiResponse.success(res, lead, 'Lead tracked successfully');
  });
}

module.exports = new LeadController();
