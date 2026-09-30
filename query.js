const mongoose = require('mongoose');
const Booking = require('./src/models/booking.model');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const bookings = await Booking.find({ status: { $nin: ['cancelled', 'completed'] } }).lean();
  console.log("Bookings count:", bookings.length);
  bookings.forEach(b => {
    console.log(`Booking ID: ${b._id}, status: ${b.status}, from: ${b.fromDate}, to: ${b.toDate}`);
  });
  process.exit(0);
});
