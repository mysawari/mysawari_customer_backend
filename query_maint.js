const mongoose = require('mongoose');
const Vehicle = require('./src/models/vehicle.model');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const vehicles = await Vehicle.find({ status: { $in: ['service', 'maintenance'] } }).lean();
  console.log("Vehicles in maintenance:", vehicles.length);
  vehicles.forEach(v => {
    console.log(`ID: ${v._id}, Name: ${v.vehicleName}, Status: ${v.status}, Maintenance Until: ${v.maintenance?.estimatedCompletionDate}`);
  });
  process.exit(0);
});
