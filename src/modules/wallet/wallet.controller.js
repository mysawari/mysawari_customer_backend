const ApiResponse = require('../../common/utils/api-response');
const asyncHandler = require('../../common/utils/async-handler');

// Initialize global transaction history in-memory
global.walletTransactions = global.walletTransactions || [];

class WalletController {
  getWallet = asyncHandler(async (req, res) => {
    const customer = req.user;
    const userId = customer._id.toString();

    const transactions = global.walletTransactions
      .filter(t => t.customerId === userId)
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    return ApiResponse.success(res, {
      walletBalance: customer.walletBalance || 0,
      rewardsPoints: customer.rewardsPoints || 0,
      transactions
    }, 'Wallet fetched successfully');
  });
}

module.exports = WalletController;
