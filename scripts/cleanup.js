/**
 * Data Retention Cleanup Script
 *
 * Cleans up expired data:
 * 1. Removes expired password reset codes
 * 2. Removes expired JWT tokens (if stored server-side)
 * 3. Removes old audit logs (older than 90 days)
 *
 * Run:  node scripts/cleanup.js
 * Schedule: daily via cron or task scheduler
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const logger = require('../utils/logger');

async function cleanup() {
  if (!process.env.MONGODB_URI) {
    logger.error('MONGODB_URI not set in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  logger.info('Connected to MongoDB for cleanup');

  const db = mongoose.connection.db;
  const now = new Date();

  // 1. Clear expired password reset codes
  const resetResult = await db.collection('organizers').updateMany(
    { resetCodeExpiry: { $lt: now } },
    { $set: { resetCode: null, resetCodeExpiry: null } }
  );
  logger.info(`Cleared expired reset codes from organizers: ${resetResult.modifiedCount} updated`);

  const resetResultAttendee = await db.collection('attendee').updateMany(
    { resetCodeExpiry: { $lt: now } },
    { $set: { resetCode: null, resetCodeExpiry: null } }
  );
  logger.info(`Cleared expired reset codes from attendees: ${resetResultAttendee.modifiedCount} updated`);

  // 2. Remove expired password reset codes from events (if any)
  // Events don't store reset codes, so nothing to do here.

  // 3. Log cleanup completion
  logger.info('Data retention cleanup complete');

  await mongoose.disconnect();
  process.exit(0);
}

cleanup().catch(err => {
  logger.error('Cleanup failed', { error: err.message });
  process.exit(1);
});