const mongoose = require('mongoose');
const CustomerActivity = require('../models/customer_activity.model');
const Booking = require('../models/booking.model');
const notificationService = require('../modules/notifications/notification.service');

// Add a "notificationSent" array to bookings/handovers? Wait, we can't change the database schema!
// But we can create a local collection or just use CustomerActivity to log that a notification was sent!
// Or we can just check the time threshold. e.g. "If it was cancelled in the last 15 minutes, send a notification".
// If the job runs every 15 minutes, we will catch it exactly once!

const sendSmartNotifications = async () => {
  try {
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    const now = new Date();

    // 1. Abandoned Checkout (Activity Tracking)
    // Find customers who initiated checkout in the last 15-30 mins
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    const abandonedActivities = await CustomerActivity.aggregate([
      { $match: { action: 'initiate_checkout', createdAt: { $gte: thirtyMinutesAgo, $lte: fifteenMinutesAgo }, customerId: { $ne: null } } },
      { $group: { _id: '$customerId', lastActivity: { $max: '$createdAt' } } }
    ]);

    for (const act of abandonedActivities) {
      // Check if they booked something recently
      const recentBooking = await Booking.findOne({ customerId: act._id, createdAt: { $gte: thirtyMinutesAgo } });
      if (!recentBooking) {
        // Did we already send this? (Check recent notifications sent)
        const recentNotif = await CustomerActivity.findOne({ action: 'sent_abandoned_notif', customerId: act._id, createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } });
        if (!recentNotif) {
          await notificationService.createNotification({
            target: 'specific', customerId: act._id,
            title: 'Still thinking about your trip?', body: 'Your selected car is waiting! Complete your booking before it gets rented out.'
          });
          await CustomerActivity.create({ action: 'sent_abandoned_notif', customerId: act._id });
        }
      }
    }

    // 2. Cancelled Bookings
    const cancelledBookings = await Booking.find({ bookingStatus: 'cancelled', updatedAt: { $gte: fifteenMinutesAgo, $lte: now } });
    for (const booking of cancelledBookings) {
      const recentNotif = await CustomerActivity.findOne({ action: 'sent_cancel_notif', details: { bookingId: booking._id } });
      if (!recentNotif) {
        await notificationService.createNotification({
          target: 'specific', customerId: booking.customerId,
          title: 'Booking Cancelled', body: `Your booking for ${booking.vehicleName} has been cancelled.`
        });
        await CustomerActivity.create({ action: 'sent_cancel_notif', customerId: booking.customerId, details: { bookingId: booking._id } });
      }
    }

    // 3. Handover completed (returned)
    // Query the handovers collection directly (since it's a shared DB)
    const handovers = mongoose.connection.db.collection('handovers');
    const returnedHandovers = await handovers.find({ handoverStatus: 'returned', updatedAt: { $gte: fifteenMinutesAgo, $lte: now } }).toArray();
    
    for (const handover of returnedHandovers) {
      // customerId is not perfectly mapped in handover, but bookingId is.
      const booking = await Booking.findById(handover.bookingId);
      if (booking) {
        const recentNotif = await CustomerActivity.findOne({ action: 'sent_returned_notif', details: { handoverId: handover._id } });
        if (!recentNotif) {
          await notificationService.createNotification({
            target: 'specific', customerId: booking.customerId,
            title: 'Trip Completed', body: 'Thank you for riding with MySawari! Please leave a review.'
          });
          await CustomerActivity.create({ action: 'sent_returned_notif', customerId: booking.customerId, details: { handoverId: handover._id } });
        }
      }
    }

    // 4. Late Returns
    // Active handovers where dropDateTime is passed by > 1 hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const lateHandovers = await handovers.find({ 
      handoverStatus: 'active', 
      'trip.dropDateTime': { $lt: oneHourAgo } 
    }).toArray();

    for (const handover of lateHandovers) {
      const booking = await Booking.findById(handover.bookingId);
      if (booking) {
        const recentNotif = await CustomerActivity.findOne({ action: 'sent_late_notif', customerId: booking.customerId, createdAt: { $gte: new Date(Date.now() - 6 * 60 * 60 * 1000) } }); // Remind every 6 hours max
        if (!recentNotif) {
          await notificationService.createNotification({
            target: 'specific', customerId: booking.customerId,
            title: 'Late Return Reminder', body: `Your rental for ${booking.vehicleName} is overdue. Please return or extend your booking to avoid penalties.`
          });
          await CustomerActivity.create({ action: 'sent_late_notif', customerId: booking.customerId, details: { handoverId: handover._id } });
        }
      }
    }

  } catch (error) {
    console.error('[SmartNotifJob] Error:', error.message);
  }
};

const startSmartNotificationJobs = () => {
  console.log('⏱️  Starting Smart Push Notifications Background Job (Interval: 15 minutes)');
  setInterval(sendSmartNotifications, 15 * 60 * 1000);
  setTimeout(sendSmartNotifications, 2 * 60 * 1000); // Run once shortly after startup
};

module.exports = { startSmartNotificationJobs };
