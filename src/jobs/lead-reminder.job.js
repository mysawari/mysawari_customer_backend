const CustomerAppLead = require('../models/customer_app_lead.model');
const watiService = require('../integrations/wati.service');

// Finds abandoned leads older than 30 minutes that haven't been messaged yet
const sendAbandonedCartReminders = async () => {
  try {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    // Don't send messages for leads older than 24 hours
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const leadsToRemind = await CustomerAppLead.find({
      status: 'abandoned',
      whatsappSent: false,
      updatedAt: { $lte: thirtyMinutesAgo, $gte: oneDayAgo }
    });

    for (const lead of leadsToRemind) {
      // Atomically claim the lead to prevent concurrent worker overlaps (e.g. cluster mode)
      const claimedLead = await CustomerAppLead.findOneAndUpdate(
        { _id: lead._id, status: 'abandoned', whatsappSent: false },
        { $set: { whatsappSent: true, status: 'messaged' } },
        { new: true }
      );

      // If another worker already claimed it, skip
      if (!claimedLead) continue;

      console.log(`[LeadJob] Processing abandoned cart for ${claimedLead.mobileNumber}`);
      
      const success = await watiService.sendAbandonedCartReminder(
        claimedLead.mobileNumber, 
        claimedLead.customerName, 
        claimedLead.vehicleName
      );

      if (success) {
        console.log(`[LeadJob] Successfully messaged ${claimedLead.mobileNumber}`);
      } else {
        // Rollback if the message failed to send
        await CustomerAppLead.updateOne(
          { _id: lead._id },
          { $set: { whatsappSent: false, status: 'abandoned' } }
        );
      }
    }
  } catch (error) {
    console.error('[LeadJob] Error processing abandoned carts:', error.message);
  }
};

const startLeadJobs = () => {
  console.log('⏱️  Starting Lead Reminder Background Job (Interval: 5 minutes)');
  // Check every 5 minutes for accuracy
  setInterval(sendAbandonedCartReminders, 5 * 60 * 1000);
  
  // Also run once on startup after 1 minute (to let DB connect)
  setTimeout(sendAbandonedCartReminders, 60 * 1000);
};

module.exports = { startLeadJobs };
