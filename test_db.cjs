const mongoose = require('mongoose');
const CustomerDevice = require('./src/models/customer_device.model.js');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const count = await CustomerDevice.countDocuments();
  console.log("Total CustomerDevice docs:", count);
  const sample = await CustomerDevice.findOne();
  console.log("Sample token:", sample ? sample.expoPushToken : "None");
  process.exit(0);
});
