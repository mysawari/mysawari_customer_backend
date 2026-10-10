const mongoose = require('mongoose');
const CustomerDevice = require('./src/models/customer_device.model.js');

mongoose.connect("mongodb+srv://admintech_db_user:8ecIxuNvrEengCuh@cluster0.9vpt6zf.mongodb.net/data").then(async () => {
  const count = await CustomerDevice.countDocuments();
  console.log(`Found ${count} device tokens in the database.`);
  if (count > 0) {
    const devices = await CustomerDevice.find({});
    console.log("Tokens:");
    devices.forEach(d => console.log(d.expoPushToken));
  }
  process.exit(0);
}).catch(err => {
  console.error("Failed to connect:", err);
  process.exit(1);
});
