const mongoose = require('mongoose');
const Booking = require('./src/models/booking.model');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const cutoff = new Date('2026-11-01T00:00:00.000Z');
  const bookings = await Booking.find({ toDate: { $gte: cutoff } }).lean();
  console.log("Bookings ending in Nov or later:", bookings.length);
  bookings.forEach(b => {
    console.log(`ID: ${b._id}, status: ${b.status}, from: ${b.fromDate}, to: ${b.toDate}, vehicleId: ${b.vehicleId}`);
  });
  process.exit(0);
});
