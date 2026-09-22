const ApiResponse = require('../../common/utils/api-response');
const asyncHandler = require('../../common/utils/async-handler');
const Customer = require('../../models/customer.model');
const ReferralService = require('../referrals/referral.service');
const AppError = require('../../common/errors/app-error');
const paymentService = require('../payments/payment.service');

const referrals = new ReferralService();

// Initialize global transaction history in-memory
global.walletTransactions = global.walletTransactions || [];

class WalletController {
  getWallet = asyncHandler(async (req, res) => {
    // Referral commission becomes due when a referred person's trip completes; pay it before reading the balance.
    await referrals.settle(req.user._id);
    const customer = (await Customer.findById(req.user._id)) || req.user;
    const userId = customer._id.toString();

    const transactions = global.walletTransactions
      .filter(t => t.customerId === userId)
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    // Check if membership is still active
    const membership = customer.membership || {};
    const isActive = membership.plan && membership.expiresAt && new Date(membership.expiresAt) > new Date();

    return ApiResponse.success(res, {
      walletBalance: customer.walletBalance || 0,
      rewardsPoints: customer.rewardsPoints || 0,
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
    const { amount, method, details } = req.body;
    if (!amount || amount <= 0) throw new AppError('Invalid amount', 400);
    if (!method || !['upi', 'bank'].includes(method)) throw new AppError('Invalid withdrawal method', 400);

    const customer = await Customer.findById(req.user._id);
    if (!customer) throw new AppError('Customer not found', 404);
    if ((customer.walletBalance || 0) < amount) {
      throw new AppError('Insufficient wallet balance', 400);
    }

    // Deduct balance and add request
    customer.walletBalance -= amount;
    
    const request = {
      amount,
      method,
      details,
      status: 'pending',
      requestedAt: new Date()
    };
    
    if (!customer.withdrawalRequests) {
      customer.withdrawalRequests = [];
    }
    customer.withdrawalRequests.push(request);
    await customer.save();

    // Add a transaction for the wallet history
    global.walletTransactions.push({
      id: new Date().getTime().toString(),
      customerId: customer._id.toString(),
      type: 'withdrawal',
      amount: -amount,
      status: 'PENDING',
      label: method === 'upi' ? 'Withdrawal to UPI' : 'Withdrawal to Bank',
      date: new Date()
    });

    return ApiResponse.success(res, { 
      walletBalance: customer.walletBalance, 
      request 
    }, 'Withdrawal requested successfully');
  });

  // ── Membership activation ──────────────────────────────────────────────────
  static PLANS = {
    starter: { price: 999,  discountRate: 0.05,  annualCap: 10000 },
    plus:    { price: 1999, discountRate: 0.10,  annualCap: 15000 },
    pro:     { price: 2999, discountRate: 0.125, annualCap: 20000 },
  };

  activateMembership = asyncHandler(async (req, res) => {
    const { plan, razorpayOrderId, razorpayPaymentId } = req.body;
    if (!plan || !WalletController.PLANS[plan]) {
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

    customer.membership = {
      plan,
      activatedAt: now,
      expiresAt,
      totalSaved: 0,
    };

    // Confirm the payment with Razorpay
    try {
      await paymentService.redeemPayment({
        customerId: req.user._id,
        orderId: razorpayOrderId,
        paymentId: razorpayPaymentId,
        amountRupees: planPrice,
      });
    } catch (error) {
      paymentService.releasePayment(razorpayPaymentId);
      throw error;
    }

    await customer.save();

    // Log the membership purchase as a wallet transaction
    global.walletTransactions = global.walletTransactions || [];
    global.walletTransactions.push({
      id: `tx_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      customerId: customer._id.toString(),
      type: 'membership',
      amount: -WalletController.PLANS[plan].price,
      description: `${plan.charAt(0).toUpperCase() + plan.slice(1)} Membership Activated`,
      date: now.toISOString(),
    });

    return ApiResponse.success(res, {
      membership: {
        plan: customer.membership.plan,
        activatedAt: customer.membership.activatedAt,
        expiresAt: customer.membership.expiresAt,
        totalSaved: customer.membership.totalSaved,
      }
    }, 'Membership activated successfully');
  });
}

module.exports = WalletController;
