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
      console.log(`[LeadJob] Processing abandoned cart for ${lead.mobileNumber}`);
      
      const success = await watiService.sendAbandonedCartReminder(
        lead.mobileNumber, 
        lead.customerName, 
        lead.vehicleName
      );

      if (success) {
        lead.whatsappSent = true;
        lead.status = 'messaged';
        await lead.save();
        console.log(`[LeadJob] Successfully messaged ${lead.mobileNumber}`);
      }
    }
  } catch (error) {
    console.error('[LeadJob] Error processing abandoned carts:', error.message);
  }
};

const startLeadJobs = () => {
  console.log('⏱️  Starting Lead Reminder Background Job (Interval: 15 minutes)');
  // Check every 15 minutes
  setInterval(sendAbandonedCartReminders, 15 * 60 * 1000);
  
  // Also run once on startup after 1 minute (to let DB connect)
  setTimeout(sendAbandonedCartReminders, 60 * 1000);
};

module.exports = { startLeadJobs };
