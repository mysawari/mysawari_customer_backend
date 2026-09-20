// Booking statuses used by the operations app. The customer app must understand
// all of them — in particular `vehicle_handover`, which means the customer has
// the vehicle right now.
const ON_TRIP_STATUS = 'vehicle_handover';

// A booking in any other status still holds its vehicle for those dates.
const CLOSED_BOOKING_STATUSES = ['cancelled', 'completed'];

// Only this amount is collected online (Razorpay) when booking; the rest is settled later.
const BOOKING_ADVANCE_AMOUNT = 500;

// Statuses in which a customer may still extend the trip.
const EXTENDABLE_STATUSES = ['confirmed', 'ongoing', ON_TRIP_STATUS];

// Statuses that count as a ride taken / in progress.
const RIDE_STATUSES = ['completed', 'confirmed', 'ongoing', ON_TRIP_STATUS];

module.exports = { BOOKING_ADVANCE_AMOUNT, ON_TRIP_STATUS, CLOSED_BOOKING_STATUSES, EXTENDABLE_STATUSES, RIDE_STATUSES };
