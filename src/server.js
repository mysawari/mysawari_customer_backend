require('dotenv').config();
const connectDB = require('./config/db');
const app = require('./app');

const PORT = process.env.PORT || 5001;

const { startLeadJobs } = require('./jobs/lead-reminder.job');

const server = app.listen(PORT, '0.0.0.0', async () => {
  await connectDB();
  startLeadJobs();
  console.log(`================================`);
  console.log(`🚀 JS Server running on port ${PORT} (0.0.0.0)`);
  console.log(`================================`);
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION! 💥 Shutting down...', err);
  server.close(() => {
    process.exit(1);
  });
});
