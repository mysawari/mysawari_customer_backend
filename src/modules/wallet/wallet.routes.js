const express = require('express');
const WalletController = require('./wallet.controller');
const protect = require('../../middleware/protect.middleware');

const router = express.Router();
const controller = new WalletController();

router.get('/', protect, controller.getWallet);
router.post('/withdraw', protect, controller.requestWithdrawal);
router.post('/membership', protect, controller.activateMembership);

module.exports = router;
