/**
 * Checkout soft-lock ("hold") rules — first customer to tap Pay gets the car.
 *
 * A hold is a `pending` booking created by the customer app, recognisable because it carries `expiresAt`
 * (pending bookings entered in the operations app don't). No new fields are used:
 *
 *   - The LOCK (whether the car is blocked for others) is measured from `updatedAt`: 2 minutes, renewed by
 *     the app every ~45s while the payment sheet is open, but never beyond 10 minutes after `createdAt`.
 *     An abandoned checkout frees the car after 2 minutes; a customer actively paying keeps it.
 *   - The RECORD lives until `expiresAt` (20 minutes; MongoDB's TTL index then deletes it). It deliberately
 *     outlives the lock, so a payment that completes late always finds its booking and can be honoured or
 *     refunded — it never ends up as "money taken, booking not found".
 */
const LOCK_MS = 2 * 60 * 1000;
const MAX_LOCK_MS = 10 * 60 * 1000;
const RECORD_TTL_MS = 20 * 60 * 1000;
// Turnaround time kept free between two trips of the same vehicle.
const TURNAROUND_MS = 2 * 60 * 60 * 1000;

/**
 * Mongo filter for bookings that currently hold their vehicle: any open booking, an operations-app
 * pending booking, or a customer hold whose lock is still active.
 */
function blockingFilter(now = new Date()) {
  const t = now.getTime();
  return {
    $or: [
      { status: { $ne: 'pending' } },
      { status: 'pending', expiresAt: null },
      {
        status: 'pending',
        expiresAt: { $ne: null },
        updatedAt: { $gt: new Date(t - LOCK_MS) },
        createdAt: { $gt: new Date(t - MAX_LOCK_MS) },
      },
    ],
  };
}

/** Is this hold's lock still active? */
function holdLockActive(booking, now = new Date()) {
  if (!booking || booking.status !== 'pending') return false;
  if (!booking.expiresAt) return true; // operations-app pending booking
  const t = now.getTime();
  const updated = new Date(booking.updatedAt || booking.createdAt || 0).getTime();
  const created = new Date(booking.createdAt || 0).getTime();
  return updated > t - LOCK_MS && created > t - MAX_LOCK_MS;
}

/** When this hold's lock ends (for the app / logs). */
function lockEndsAt(booking) {
  const updated = new Date(booking.updatedAt || booking.createdAt || Date.now()).getTime();
  const created = new Date(booking.createdAt || Date.now()).getTime();
  return new Date(Math.min(updated + LOCK_MS, created + MAX_LOCK_MS));
}

module.exports = { LOCK_MS, MAX_LOCK_MS, RECORD_TTL_MS, TURNAROUND_MS, blockingFilter, holdLockActive, lockEndsAt };
