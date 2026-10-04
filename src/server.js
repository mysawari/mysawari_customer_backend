require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const app = require('./app');

const PORT = process.env.PORT || 5001;

const { startLeadJobs } = require('./jobs/lead-reminder.job');
const { startSmartNotificationJobs } = require('./jobs/smart-notifications.job');

const server = app.listen(PORT, '0.0.0.0', async () => {
  await connectDB();
  startLeadJobs();
  startSmartNotificationJobs();
  // Load the number-plate models now, so the first photo request isn't slow (and a broken model shows up here).
  require('./modules/images/plate-blur').warmUp()
    .then(() => {
      console.log('🔒 Number-plate blur models loaded');
      // Process all vehicle photos in the background so customers never wait for them (off with PLATE_BLUR_PREWARM=false).
      if (process.env.PLATE_BLUR_PREWARM !== 'false') require('./modules/images/image.controller').startPrewarm();
    })
    .catch((err) => console.error('❌ Number-plate blur models failed to load — vehicle photos cannot be served:', err.message));
  console.log(`================================`);
  console.log(`🚀 JS Server running on port ${PORT} (0.0.0.0)`);
  console.log(`================================`);
});

// Connection timeouts tuned for running behind a load balancer (Render etc.):
// - keep-alive must outlive the proxy's idle timeout, or the proxy reuses a socket we just closed (random 502s);
// - a request that never finishes sending its headers / body is cut off instead of holding a socket forever.
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;
server.requestTimeout = 60 * 1000;
server.maxRequestsPerSocket = 1000;

// One stray rejected promise used to shut the whole API down for every customer. It is now logged and the
// server keeps serving; only a truly unknown state (uncaughtException) restarts the process, gracefully.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

let shuttingDown = false;
function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — finishing in-flight requests, then exiting.`);
  // Stop accepting new connections; let running requests finish (bounded), then close the DB.
  server.close(async () => {
    try { await mongoose.connection.close(false); } catch (e) { /* already closed */ }
    process.exit(exitCode);
  });
  setTimeout(() => process.exit(exitCode), 15 * 1000).unref();
}

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] 💥', err);
  shutdown('uncaughtException', 1);
});
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
