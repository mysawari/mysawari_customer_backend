const mongoose = require('mongoose');
const Vehicle = require('./src/models/vehicle.model');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const vehicle = await Vehicle.findById('6a3851a0d50531517176213d').lean();
  console.log("Vehicle Status:", vehicle.status);
  console.log("Vehicle Name:", vehicle.vehicleName);
  process.exit(0);
});
