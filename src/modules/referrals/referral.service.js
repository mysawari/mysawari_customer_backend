const Customer = require('../../models/customer.model');
const Booking = require('../../models/booking.model');
const Referral = require('../../models/referral.model');
const AppError = require('../../common/errors/app-error');
const Token = require('../../models/token.model');
const { sameNetwork } = require('../../common/utils/client-ip');
const { installIdFromDeviceInfo } = require('../../common/utils/device');
const { securityLog } = require('../../common/utils/security-log');

/** Both accounts were used from the same app install (phone) — checked across their recent sessions. */
async function shareADevice(customerA, customerB) {
  const [a, b] = await Promise.all([
    Token.find({ customerId: customerA }).select('deviceInfo').limit(50).lean(),
    Token.find({ customerId: customerB }).select('deviceInfo').limit(50).lean(),
  ]);
  const ids = new Set(a.map((t) => installIdFromDeviceInfo(t.deviceInfo)).filter(Boolean));
  return b.some((t) => ids.has(installIdFromDeviceInfo(t.deviceInfo)));
}

// The referrer earns this share of the referred customer's first completed trip.
const COMMISSION_RATE = 0.10;

const normalizeMobile = (raw) => String(raw || '').replace(/\D/g, '').slice(-10);
const isValidMobile = (mobile) => /^[6-9]\d{9}$/.test(mobile);

const SawariCashTransaction = require('../../models/sawaricash_transaction.model');

async function logWalletTx(customerId, amount, description) {
  try {
    await SawariCashTransaction.create({
      customerId,
      amount,
      transactionType: 'credit',
      reason: description,
      status: 'completed'
    });
  } catch (error) {
    console.error('Failed to log wallet transaction:', error);
  }
}

/** What the commission is worked out on: the vehicle rent after any discount (not fastag / delivery charges). */
function commissionBase(booking) {
  const payment = booking.payment || {};
  const rent = Number(payment.vehicleRent) > 0 ? Number(payment.vehicleRent) : Number(payment.totalAmount) || 0;
  return Math.max(0, rent - (Number(payment.discountAmount) || 0));
}

// settle() runs several queries per referral and is called on every wallet / referral screen load.
// Commission only becomes due when a trip completes, so checking each customer at most once a minute is plenty.
const SETTLE_INTERVAL_MS = 60 * 1000;
const lastSettled = new Map();

class ReferralService {
  /** A customer adds the phone number of someone they want to refer. */
  async addReferral(referrer, { mobileNumber, name }) {
    const mobile = normalizeMobile(mobileNumber);
    if (!isValidMobile(mobile)) throw new AppError('Enter a valid 10-digit mobile number', 400);
    if (mobile === referrer.mobileNumber) throw new AppError('You cannot refer your own number', 400);

    // One referrer per number, so a trip can only ever earn one commission.
    const alreadyReferred = await Referral.exists({ referredMobile: mobile });
    if (alreadyReferred) throw new AppError('This number has already been referred', 409);

    // Commission is for bringing in a new customer: someone who has already booked is not a referral.
    const alreadyBooked = await Booking.exists({ mobileNumber: mobile, isDeleted: { $ne: true } });
    if (alreadyBooked) throw new AppError('This person is already a MySawari customer', 400);

    const cleanName = String(name || '').trim().slice(0, 60);
    
    // Check if the referred user already has a Customer account
    const existingCustomer = await Customer.findOne({ mobileNumber: mobile });
    if (existingCustomer) {
      throw new AppError('This person already has a MySawari account', 400);
    }
    
    const referral = await Referral.create({
      referrerId: referrer._id,
      referredMobile: mobile,
      referredName: cleanName,
      referredId: null,
      status: 'invited'
    });

    return referral;
  }

  /**
   * Credits the commission for every referred number whose first trip has completed. Safe to call as often
   * as needed: each referral is rewarded at most once (the update only matches while it is not yet rewarded).
   */
  async settle(referrerId) {
    const key = String(referrerId);
    const last = lastSettled.get(key);
    if (last && Date.now() - last < SETTLE_INTERVAL_MS) return 0;
    lastSettled.set(key, Date.now());
    if (lastSettled.size > 50000) lastSettled.delete(lastSettled.keys().next().value);

    const referrer = await Customer.findById(referrerId);
    if (!referrer) return 0;

    let credited = 0;
    
    // Find all pending referrals for this referrer
    const pendingReferrals = await Referral.find({
      referrerId: referrer._id,
      status: 'invited'
    });

    for (const ref of pendingReferrals) {
      const booking = await Booking.findOne({
        mobileNumber: ref.referredMobile,
        status: 'completed',
        isDeleted: { $ne: true },
        createdAt: { $gte: ref.invitedAt },
      }).sort({ createdAt: 1 });
      
      if (!booking) continue;

      const amount = Math.round(commissionBase(booking) * COMMISSION_RATE);
      if (amount <= 0) continue;

      // Anti-fraud check: compare IP addresses
      const referredUser = await Customer.findOne({ mobileNumber: ref.referredMobile });
      // Anti-fraud: same signup network (IPv4 address / IPv6 /64, normalized) or the same phone.
      const fraudReason = !referredUser ? null
        : sameNetwork(referrer.signupIp, referredUser.signupIp) ? 'same_network'
        : (await shareADevice(referrer._id, referredUser._id)) ? 'same_device'
        : null;
      if (fraudReason) {
        securityLog('referral_flagged', null, { referrer: String(referrer._id), referred: String(referredUser._id), reason: fraudReason, stage: 'payout' });
        // Fraudulent referral detected
        await Referral.updateOne(
          { _id: ref._id },
          {
            $set: {
              status: 'fraudulent',
              rewardedAt: new Date(),
            }
          }
        );
        continue;
      }

      // Reward the referrer
      const won = await Referral.findOneAndUpdate(
        { _id: ref._id, status: 'invited' },
        {
          $set: {
            status: 'rewarded',
            rewardBookingId: booking._id,
            commissionAmount: amount,
            rewardedAt: new Date(),
          }
        }
      );
      
      if (won) {
        await Customer.updateOne(
          { _id: referrer._id },
          { $inc: { walletBalance: amount } }
        );
        credited += amount;
        logWalletTx(referrer._id, amount, `Referral commission${ref.referredName ? ` — ${ref.referredName}` : ''} (${ref.referredMobile})`);
      }
    }
    return credited;
  }

  /** The customer's referrals, newest first, with the state of each. */
  async list(referrerId) {
    const referrer = await Customer.findById(referrerId).lean();
    if (!referrer) return [];

    // Find direct referrals (invited via app)
    const directReferrals = await Referral.find({ referrerId: referrer._id }).lean();
    
    // Find indirect referrals (people who signed up using the referral code, but were never explicitly invited)
    const indirectSignups = await Customer.find({ referredBy: referrer._id }).lean();

    // Map direct referrals
    const items = directReferrals.map(r => {
      // Check if they signed up
      const account = indirectSignups.find(c => c.mobileNumber === r.referredMobile);
      return {
        id: String(r._id),
        referredName: account && account.customerName !== 'New Customer' ? account.customerName : r.referredName || r.referredMobile,
        mobileNumber: r.referredMobile,
        signupAt: r.invitedAt,
        status: r.status === 'rewarded' ? 'REWARDED' : account ? 'JOINED' : 'INVITED',
        commissionAmount: r.commissionAmount || 0,
      };
    });

    // Add indirect signups that don't have a direct Referral document
    const seenMobiles = new Set(items.map(i => i.mobileNumber));
    for (const account of indirectSignups) {
      if (!seenMobiles.has(account.mobileNumber)) {
        items.push({
          id: String(account._id), // Use customer ID as a fallback ID
          referredName: account.customerName !== 'New Customer' ? account.customerName : account.mobileNumber,
          mobileNumber: account.mobileNumber,
          signupAt: account.createdAt,
          status: 'JOINED', // They signed up, but haven't been rewarded yet (or maybe they have if we ran settle!)
          commissionAmount: 0,
        });
      }
    }

    return items.sort((a, b) => new Date(b.signupAt) - new Date(a.signupAt));
  }
}

module.exports = ReferralService;
module.exports.COMMISSION_RATE = COMMISSION_RATE;
