const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
      console.warn('⚠️  MONGO_URI is missing in .env! Backend is running without DB connection.');
      return;
    }
    // Bounded waits so a slow / unreachable database fails requests quickly instead of piling them up,
    // and a pool large enough for many simultaneous users.
    const conn = await mongoose.connect(mongoUri, {
      maxPoolSize: Number(process.env.MONGO_POOL_SIZE) || 50,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 10 * 1000,
      socketTimeoutMS: 45 * 1000,
    });
    mongoose.connection.on('disconnected', () => console.warn('⚠️  MongoDB disconnected — the driver will reconnect automatically.'));
    mongoose.connection.on('reconnected', () => console.log('🟢 MongoDB reconnected'));
    mongoose.connection.on('error', (err) => console.error('MongoDB error:', err.message));
    console.log(`================================`);
    console.log(`🟢 MongoDB Connected: ${conn.connection.host}`);
    console.log(`================================`);
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    process.exit(1);
  }
};

module.exports = connectDB;
