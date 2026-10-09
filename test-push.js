require('dotenv').config();
const mongoose = require('mongoose');
const notificationService = require('./src/modules/notifications/notification.service');
const CustomerDevice = require('./src/models/customer_device.model');

async function testPush() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to DB');

  const count = await CustomerDevice.countDocuments();
  console.log(`Found ${count} registered device tokens in DB.`);
  // Let's create a broadcast notification, which should hit all registered Expo tokens
  console.log('Triggering test push...');
  try {
    const notif = await notificationService.createNotification({
      target: 'all',
      title: 'Test Notification 🚀',
      body: 'This is a test to verify push delivery is working!',
      payload: { link: '/explore' }
    });
    console.log('Notification created:', notif._id);
  } catch (err) {
    console.error('Push failed:', err);
  }

  setTimeout(() => process.exit(0), 5000); // wait for background promises
}

testPush();
