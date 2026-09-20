const Vehicle = require('../../models/vehicle.model');
const Booking = require('../../models/booking.model');
const { CLOSED_BOOKING_STATUSES } = require('../bookings/booking.constants');

const DAY_MS = 24 * 60 * 60 * 1000;

// Only what the app actually uses — the full documents carry maintenance history,
// company / creator ids and more, which made every load roughly twice as heavy.
const VEHICLE_FIELDS =
  'vehicleName vehicleType fuelType transmission seatingCapacity status isDeleted pricePerDay images.url maintenance.estimatedCompletionDate';

// Short-lived cache so a burst of users (or one user opening three screens) costs
// one database read, not many. It is dropped whenever this API changes a booking,
// and expires on its own within seconds for changes made by the operations app.
const CACHE_TTL_MS = 10 * 1000;
let cache = null; // { at, payload }
let inFlight = null;

function invalidateVehicleCache() {
  cache = null;
}

async function buildPayload() {
  // Any booking that isn't cancelled/completed still holds the vehicle:
  // pending, confirmed, out on a trip (vehicle_handover) and so on.
  // Bookings that ended long ago are ignored even if the ops app never closed
  // them out; whether a vehicle is out *right now* is the vehicle's own status ("rent").
  const cutoff = new Date(Date.now() - 2 * DAY_MS); // slack for timezones

  const [vehicles, openBookings] = await Promise.all([
    Vehicle.find({ isDeleted: { $ne: true } }).select(VEHICLE_FIELDS).lean(),
    Booking.find({
      status: { $nin: CLOSED_BOOKING_STATUSES },
      isDeleted: { $ne: true },
      toDate: { $gte: cutoff },
    })
      .select('vehicleId fromDate toDate status')
      .lean(),
  ]);

  const rangesByVehicle = new Map();
  for (const b of openBookings) {
    if (!b.vehicleId || !b.fromDate || !b.toDate) continue;
    const key = b.vehicleId.toString();
    if (!rangesByVehicle.has(key)) rangesByVehicle.set(key, []);
    rangesByVehicle.get(key).push({
      start: b.fromDate.toISOString(),
      end: b.toDate.toISOString(),
      status: b.status,
    });
  }

  const data = vehicles.map((vehicle) => {
    const { maintenance, ...rest } = vehicle;
    return {
      ...rest,
      bookedRanges: (rangesByVehicle.get(vehicle._id.toString()) || []).sort(
        (a, b) => new Date(a.start) - new Date(b.start)
      ),
      maintenanceUntil: maintenance?.estimatedCompletionDate || null,
    };
  });

  return { success: true, count: data.length, generatedAt: new Date().toISOString(), data };
}

class VehicleController {
  /**
   * @route GET /api/vehicles
   * @desc Every live vehicle with the raw facts needed to work out availability
   *       for any date: its status, when maintenance ends, and all open bookings.
   *       (The app derives "available on date X" from these, so date changes in
   *       the UI don't need another round trip.)
   * @access Public
   */
  static async getAvailableVehicles(req, res, next) {
    try {
      if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
        return res.status(200).json(cache.payload);
      }
      // Concurrent requests share one database read.
      if (!inFlight) {
        inFlight = buildPayload().finally(() => { inFlight = null; });
      }
      const payload = await inFlight;
      cache = { at: Date.now(), payload };
      return res.status(200).json(payload);
    } catch (error) {
      console.error('Error fetching vehicles:', error);
      next(error);
    }
  }
}

module.exports = VehicleController;
module.exports.invalidateVehicleCache = invalidateVehicleCache;
