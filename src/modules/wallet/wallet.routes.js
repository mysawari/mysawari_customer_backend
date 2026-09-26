const express = require('express');
const { createLimiter } = require('../../common/utils/rate-limit');
const WalletController = require('./wallet.controller');
const protect = require('../../middleware/protect.middleware');

const router = express.Router();
const controller = new WalletController();

// Financial operations need velocity limits to prevent rapid draining of a compromised account.
const financialLimiter = createLimiter({ name: 'wallet-financial', by: 'user', windowMs: 60 * 60 * 1000, max: 5, message: 'Too many requests, please try again later.' });

const walletReadLimiter = createLimiter({ name: 'wallet-read', by: 'user', windowMs: 60 * 1000, max: 60 });
router.get('/', protect, walletReadLimiter, controller.getWallet);
router.post('/withdraw', protect, financialLimiter, controller.requestWithdrawal);
router.post('/membership', protect, financialLimiter, controller.activateMembership);

module.exports = router;
