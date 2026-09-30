const mongoose = require('mongoose');
const Booking = require('./src/models/booking.model');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const cutoff = new Date('2026-11-06T00:00:00.000Z');
  const today = new Date('2026-09-24T00:00:00.000Z');
  
  const bookings = await Booking.find({ 
    status: { $nin: ['cancelled', 'completed'] },
    toDate: { $gte: cutoff },
    fromDate: { $lte: today }
  }).lean();
  
  console.log("Long bookings blocking until Nov:", bookings.length);
  bookings.forEach(b => {
    console.log(`ID: ${b._id}, status: ${b.status}, from: ${b.fromDate}, to: ${b.toDate}, vehicleId: ${b.vehicleId}`);
  });
  process.exit(0);
});
