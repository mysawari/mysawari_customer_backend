const mongoose = require('mongoose');
const CustomerDevice = require('./src/models/customer_device.model.js');

mongoose.connect("mongodb+srv://admintech_db_user:8ecIxuNvrEengCuh@cluster0.9vpt6zf.mongodb.net/data").then(async () => {
  const count = await CustomerDevice.countDocuments();
  console.log(`Found ${count} device tokens in the database.`);
  await CustomerDevice.deleteMany({});
  console.log('Successfully cleared all stale tokens.');
  process.exit(0);
}).catch(err => {
  console.error("Failed to connect:", err);
  process.exit(1);
});
