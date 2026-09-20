const express = require('express');
const WalletController = require('./wallet.controller');
const protect = require('../../middleware/protect.middleware');

const router = express.Router();
const controller = new WalletController();

router.get('/', protect, controller.getWallet);

module.exports = router;
