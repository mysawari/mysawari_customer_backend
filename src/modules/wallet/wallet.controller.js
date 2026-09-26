const ApiResponse = require('../../common/utils/api-response');
const asyncHandler = require('../../common/utils/async-handler');
const Customer = require('../../models/customer.model');
const Membership = require('../../models/membership.model');
const ReferralService = require('../referrals/referral.service');
const AppError = require('../../common/errors/app-error');
const paymentService = require('../payments/payment.service');
const { securityLog } = require('../../common/utils/security-log');

const referrals = new ReferralService();

// One withdrawal at a time per customer: two parallel requests used to both pass the
// "referral earnings only" check and together cash out non-withdrawable bonus money.
const withdrawalLocks = new Set();

const UPI_RE = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,64}$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_RE = /^\d{9,18}$/;
const NAME_RE = /^[A-Za-z .'-]{2,100}$/;

function withdrawalDetails(method, details) {
  const d = details && typeof details === 'object' ? details : {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  if (method === 'upi') {
    const upiId = str(d.upiId);
    if (!UPI_RE.test(upiId)) throw new AppError('Enter a valid UPI ID (e.g. name@upi)', 400);
    return { upiId };
  }
  const accountNumber = str(d.accountNumber).replace(/\s/g, '');
  const ifsc = str(d.ifsc).toUpperCase();
  const bankName = str(d.bankName);
  const accountHolderName = str(d.accountHolderName);
  if (!ACCOUNT_RE.test(accountNumber)) throw new AppError('Enter a valid bank account number', 400);
  if (!IFSC_RE.test(ifsc)) throw new AppError('Enter a valid IFSC code', 400);
  if (!bankName || bankName.length > 100) throw new AppError('Enter a valid bank name', 400);
  if (!NAME_RE.test(accountHolderName)) throw new AppError('Enter a valid account holder name', 400);
  return { accountNumber, ifsc, bankName, accountHolderName };
}

class WalletController {
  getWallet = asyncHandler(async (req, res) => {
    // Referral commission becomes due when a referred person's trip completes; pay it before reading the balance.
    await referrals.settle(req.user._id);
    const customer = (await Customer.findById(req.user._id)) || req.user;
    const userId = customer._id.toString();

    const SawariCashTransaction = require('../../models/sawaricash_transaction.model');
    
    // Process Expired Promotional Coins
    const now = new Date();
    const expiredTransactions = await SawariCashTransaction.find({
      customerId: userId,
      status: 'completed',
      expiresAt: { $lt: now }
    });

    if (expiredTransactions.length > 0) {
      let totalExpired = 0;
      for (const tx of expiredTransactions) {
        // Atomic claim: parallel wallet reads used to expire (and deduct) the same coins twice.
        const claimed = await SawariCashTransaction.findOneAndUpdate(
          { _id: tx._id, status: 'completed' },
          { $set: { status: 'expired' } }
        );
        if (!claimed) continue;

        // Log the debit for expiry
        await SawariCashTransaction.create({
          customerId: userId,
          amount: tx.amount,
          transactionType: 'debit',
          reason: `${tx.reason} Expired`,
          status: 'completed'
        });
        totalExpired += tx.amount;
      }

      if (totalExpired > 0) {
        // Remove the expired coins, never taking the balance below zero (previously nothing was
        // removed at all when the balance was lower than the expired amount).
        await Customer.updateOne(
          { _id: req.user._id },
          [{ $set: { walletBalance: { $max: [0, { $subtract: [{ $ifNull: ['$walletBalance', 0] }, totalExpired] }] } } }]
        );
      }
    }

    const txRecords = await SawariCashTransaction.find({ customerId: userId })
      .sort({ createdAt: -1 })
      .lean();

    // Reload customer to get the potentially updated balance
    const updatedCustomer = await Customer.findById(req.user._id);
    const currentWalletBalance = updatedCustomer.walletBalance || 0;

    // Newest 300 entries are shown; the balance figures below are still worked out from the full history.
    const transactions = txRecords.slice(0, 300).map(t => ({
      id: t._id.toString(),
      customerId: t.customerId.toString(),
      type: t.transactionType === 'debit' ? (t.reason?.toLowerCase().includes('withdrawal') ? 'withdrawal' : 'membership') : 'credit',
      amount: t.transactionType === 'debit' ? -t.amount : t.amount,
      description: t.reason,
      date: t.createdAt,
      status: t.status === 'pending' ? 'PENDING' : t.status === 'refunded' ? 'REFUNDED' : undefined
    }));

    // Calculate withdrawable balance
    const referralCredits = txRecords
      .filter(t => t.transactionType === 'credit' && t.reason?.toLowerCase().includes('referral commission'))
      .reduce((sum, t) => sum + t.amount, 0);

    const withdrawalDebits = txRecords
      .filter(t => t.transactionType === 'debit' && t.reason?.toLowerCase().includes('withdrawal') && t.status !== 'refunded')
      .reduce((sum, t) => sum + t.amount, 0);

    const withdrawableBalance = Math.max(0, Math.min(currentWalletBalance, referralCredits - withdrawalDebits));

    // Check if membership is still active
    const membership = await Membership.findOne({ customerId: userId });
    const isActive = !!(membership && membership.expiresAt && new Date(membership.expiresAt) > new Date());

    return ApiResponse.success(res, {
      walletBalance: currentWalletBalance,
      withdrawableBalance,
      rewardsPoints: updatedCustomer.rewardsPoints || 0,
      transactions,
      membership: isActive ? {
        plan: membership.plan,
        activatedAt: membership.activatedAt,
        expiresAt: membership.expiresAt,
        totalSaved: membership.totalSaved || 0,
      } : null,
    }, 'Wallet fetched successfully');
  });

  requestWithdrawal = asyncHandler(async (req, res) => {
    const { method, details } = req.body || {};
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount) || amount > 100000) {
      throw new AppError('Invalid amount', 400);
    }
    if (!method || !['upi', 'bank'].includes(method)) throw new AppError('Invalid withdrawal method', 400);

    const request = {
      amount,
      method,
      details: withdrawalDetails(method, details),
      status: 'pending',
      requestedAt: new Date()
    };

    const lockKey = String(req.user._id);
    if (withdrawalLocks.has(lockKey)) throw new AppError('A withdrawal is already being processed', 409);
    withdrawalLocks.add(lockKey);
    try {

    // Calculate maximum withdrawable balance from transaction history
    const SawariCashTransaction = require('../../models/sawaricash_transaction.model');
    const txRecords = await SawariCashTransaction.find({ customerId: req.user._id }).lean();
    
    const referralCredits = txRecords
      .filter(t => t.transactionType === 'credit' && t.reason?.toLowerCase().includes('referral commission'))
      .reduce((sum, t) => sum + t.amount, 0);

    const withdrawalDebits = txRecords
      .filter(t => t.transactionType === 'debit' && t.reason?.toLowerCase().includes('withdrawal') && t.status !== 'refunded')
      .reduce((sum, t) => sum + t.amount, 0);

    // Current real wallet balance is fetched directly from the database to ensure we don't over-withdraw
    const currentCustomer = await Customer.findById(req.user._id).select('walletBalance').lean();
    const withdrawableBalance = Math.max(0, Math.min(currentCustomer.walletBalance || 0, referralCredits - withdrawalDebits));

    if (amount > withdrawableBalance) {
      throw new AppError(`You can only withdraw up to ₹${withdrawableBalance} (Only referral earnings can be withdrawn to bank/UPI)`, 400);
    }

    // Atomic check-and-deduct: a read-then-save (as this was) lets two concurrent requests both
    // pass the balance check against the same starting balance and both go through — the same
    // double-withdrawal race the SawariCash-on-booking deduction elsewhere already guards against.
    const customer = await Customer.findOneAndUpdate(
      { _id: req.user._id, walletBalance: { $gte: amount } },
      { $inc: { walletBalance: -amount }, $push: { withdrawalRequests: request } },
      { new: true }
    );
    if (!customer) throw new AppError('Insufficient wallet balance', 400);

    // Add a transaction for the wallet history
    await SawariCashTransaction.create({
      customerId: customer._id,
      amount: amount,
      transactionType: 'debit',
      reason: method === 'upi' ? 'Withdrawal to UPI' : 'Withdrawal to Bank',
      status: 'pending' // Withdrawal is pending approval
    });

    return ApiResponse.success(res, {
      walletBalance: customer.walletBalance,
      request: { amount: request.amount, method: request.method, status: request.status, requestedAt: request.requestedAt },
    }, 'Withdrawal requested successfully');
    } finally {
      withdrawalLocks.delete(lockKey);
    }
  });

  // ── Membership activation ──────────────────────────────────────────────────
  static PLANS = {
    starter: { price: 999,  discountRate: 0.05,  annualCap: 10000 },
    plus:    { price: 1999, discountRate: 0.10,  annualCap: 15000 },
    pro:     { price: 2999, discountRate: 0.125, annualCap: 20000 },
  };

  activateMembership = asyncHandler(async (req, res) => {
    const { plan, razorpayOrderId, razorpayPaymentId } = req.body || {};
    if (!plan || typeof plan !== 'string' || !Object.prototype.hasOwnProperty.call(WalletController.PLANS, plan)) {
      throw new AppError('Invalid membership plan', 400);
    }
    if (!razorpayOrderId || !razorpayPaymentId) {
      throw new AppError('Payment details are required to activate membership', 400);
    }

    const planPrice = WalletController.PLANS[plan].price;

    const customer = await Customer.findById(req.user._id);
    if (!customer) throw new AppError('Customer not found', 404);

    const now = new Date();
    const expiresAt = new Date(now);
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);

    // Confirm the payment with Razorpay (a failed check cleans up after itself)
    try {
      await paymentService.redeemPayment({
        customerId: req.user._id,
        orderId: razorpayOrderId,
        paymentId: razorpayPaymentId,
        amountRupees: planPrice,
      });
    } catch (e) {
      securityLog('payment_rejected', req, { purpose: 'membership', reason: e.message });
      throw e;
    }

    // A renewal/upgrade replaces the plan and resets the annual savings cap; it never touches
    // any other customer or membership record.
    // membershipId and payment.paymentId are required by the schema; the old upsert never set them, so
    // every activation after the first one inserted a second null membershipId and failed on the unique
    // index — after the customer had already paid.
    const membership = await Membership.findOneAndUpdate(
      { customerId: customer._id },
      {
        $set: {
          plan,
          activatedAt: now,
          expiresAt,
          totalSaved: 0,
          payment: {
            amount: planPrice,
            paymentMethod: 'online',
            paymentBreakdown: { cash: 0, phonePe: 0, razorpay: planPrice },
            paymentId: razorpayPaymentId,
            transactionId: razorpayOrderId,
            status: 'completed',
            paidAt: now,
          },
        },
        $setOnInsert: { membershipId: `MEM-${String(customer._id).slice(-6).toUpperCase()}-${Date.now().toString(36).toUpperCase()}` },
      },
      { new: true, upsert: true }
    );

    // Log the membership purchase as a wallet transaction
    const SawariCashTransaction = require('../../models/sawaricash_transaction.model');
    await SawariCashTransaction.create({
      customerId: customer._id,
      amount: WalletController.PLANS[plan].price,
      transactionType: 'debit',
      reason: `${plan.charAt(0).toUpperCase() + plan.slice(1)} Membership Activated`,
      status: 'completed'
    });

    return ApiResponse.success(res, {
      membership: {
        plan: membership.plan,
        activatedAt: membership.activatedAt,
        expiresAt: membership.expiresAt,
        totalSaved: membership.totalSaved,
      }
    }, 'Membership activated successfully');
  });
}

module.exports = WalletController;
