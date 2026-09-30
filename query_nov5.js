const mongoose = require('mongoose');
const Booking = require('./src/models/booking.model');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const start = new Date('2026-11-04T00:00:00.000Z');
  const end = new Date('2026-11-06T00:00:00.000Z');
  const bookings = await Booking.find({ toDate: { $gte: start, $lt: end } }).lean();
  console.log("Bookings ending on Nov 5:", bookings.length);
  bookings.forEach(b => {
    console.log(`ID: ${b._id}, status: ${b.status}, from: ${b.fromDate}, to: ${b.toDate}`);
  });
  process.exit(0);
});
