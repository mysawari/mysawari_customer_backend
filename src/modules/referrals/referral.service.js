const Customer = require('../../models/customer.model');
const Booking = require('../../models/booking.model');
const AppError = require('../../common/errors/app-error');

// The referrer earns this share of the referred customer's first completed trip.
const COMMISSION_RATE = 0.10;

const normalizeMobile = (raw) => String(raw || '').replace(/\D/g, '').slice(-10);
const isValidMobile = (mobile) => /^[6-9]\d{9}$/.test(mobile);

function logWalletTx(customerId, amount, description) {
  global.walletTransactions = global.walletTransactions || [];
  global.walletTransactions.push({
    id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    customerId: customerId.toString(),
    type: 'credit',
    amount,
    description,
    date: new Date().toISOString(),
  });
}

/** What the commission is worked out on: the vehicle rent after any discount (not fastag / delivery charges). */
function commissionBase(booking) {
  const payment = booking.payment || {};
  const rent = Number(payment.vehicleRent) > 0 ? Number(payment.vehicleRent) : Number(payment.totalAmount) || 0;
  return Math.max(0, rent - (Number(payment.discountAmount) || 0));
}

class ReferralService {
  /** A customer adds the phone number of someone they want to refer. */
  async addReferral(referrer, { mobileNumber, name }) {
    const mobile = normalizeMobile(mobileNumber);
    if (!isValidMobile(mobile)) throw new AppError('Enter a valid 10-digit mobile number', 400);
    if (mobile === referrer.mobileNumber) throw new AppError('You cannot refer your own number', 400);

    // One referrer per number, so a trip can only ever earn one commission.
    const alreadyReferred = await Customer.exists({ 'referrals.mobileNumber': mobile });
    if (alreadyReferred) throw new AppError('This number has already been referred', 409);

    // Commission is for bringing in a new customer: someone who has already booked is not a referral.
    const alreadyBooked = await Booking.exists({ mobileNumber: mobile, isDeleted: { $ne: true } });
    if (alreadyBooked) throw new AppError('This person is already a MySawari customer', 400);

    const cleanName = String(name || '').trim().slice(0, 60);
    const updated = await Customer.findOneAndUpdate(
      { _id: referrer._id, 'referrals.mobileNumber': { $ne: mobile } },
      { $push: { referrals: { mobileNumber: mobile, name: cleanName, status: 'invited', invitedAt: new Date() } } },
      { new: true }
    );
    if (!updated) throw new AppError('This number has already been referred', 409);
    return updated.referrals[updated.referrals.length - 1];
  }

  /**
   * Credits the commission for every referred number whose first trip has completed. Safe to call as often
   * as needed: each referral is rewarded at most once (the update only matches while it is not yet rewarded).
   */
  async settle(referrerId) {
    const referrer = await Customer.findById(referrerId);
    if (!referrer) return 0;

    let credited = 0;
    for (const ref of referrer.referrals || []) {
      if (ref.status === 'rewarded') continue;

      const booking = await Booking.findOne({
        mobileNumber: ref.mobileNumber,
        status: 'completed',
        isDeleted: { $ne: true },
        createdAt: { $gte: ref.invitedAt },
      }).sort({ createdAt: 1 });
      if (!booking) continue;

      const amount = Math.round(commissionBase(booking) * COMMISSION_RATE);
      if (amount <= 0) continue;

      // Anti-fraud check: compare IP addresses
      const referredUser = await Customer.findOne({ mobileNumber: ref.mobileNumber });
      if (referredUser && referrer.signupIp && referredUser.signupIp && referrer.signupIp === referredUser.signupIp) {
        // Fraudulent referral detected
        await Customer.findOneAndUpdate(
          { _id: referrer._id, referrals: { $elemMatch: { _id: ref._id, status: { $ne: 'rewarded' } } } },
          {
            $set: {
              'referrals.$.status': 'fraudulent',
              'referrals.$.rewardedAt': new Date(),
            }
          }
        );
        continue;
      }

      const won = await Customer.findOneAndUpdate(
        { _id: referrer._id, referrals: { $elemMatch: { _id: ref._id, status: { $ne: 'rewarded' } } } },
        {
          $set: {
            'referrals.$.status': 'rewarded',
            'referrals.$.rewardBookingId': booking._id,
            'referrals.$.commissionAmount': amount,
            'referrals.$.rewardedAt': new Date(),
          },
          $inc: { walletBalance: amount },
        }
      );
      if (won) {
        credited += amount;
        logWalletTx(referrer._id, amount, `Referral commission${ref.name ? ` — ${ref.name}` : ''} (${ref.mobileNumber})`);
      }
    }
    return credited;
  }

  /** The customer's referrals, newest first, with the state of each. */
  async list(referrerId) {
    const referrer = await Customer.findById(referrerId).lean();
    if (!referrer) return [];

    const refs = referrer.referrals || [];
    const joined = await Customer.find({ mobileNumber: { $in: refs.map(r => r.mobileNumber) } })
      .select('mobileNumber customerName')
      .lean();
    const joinedByMobile = new Map(joined.map(c => [c.mobileNumber, c]));

    const items = refs.map(r => {
      const account = joinedByMobile.get(r.mobileNumber);
      return {
        id: String(r._id),
        referredName: r.name || (account && account.customerName !== 'New Customer' ? account.customerName : '') || r.mobileNumber,
        mobileNumber: r.mobileNumber,
        signupAt: r.invitedAt,
        status: r.status === 'rewarded' ? 'REWARDED' : account ? 'JOINED' : 'INVITED',
        commissionAmount: r.commissionAmount || 0,
      };
    });

    // People who signed up with this customer's code (older, in-memory tracking) still show, without commission.
    const seen = new Set(items.map(i => i.mobileNumber));
    for (const legacy of (global.referralStore || []).filter(r => r.referrerId === String(referrerId))) {
      if (seen.has(legacy.referredMobile)) continue;
      items.push({
        id: legacy.id,
        referredName: legacy.referredName,
        mobileNumber: legacy.referredMobile,
        signupAt: legacy.signupAt,
        status: 'JOINED',
        commissionAmount: 0,
      });
    }

    return items.sort((a, b) => new Date(b.signupAt) - new Date(a.signupAt));
  }
}

module.exports = ReferralService;
module.exports.COMMISSION_RATE = COMMISSION_RATE;
