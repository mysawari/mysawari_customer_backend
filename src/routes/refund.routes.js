const express = require("express");
const Refund = require("../models/refund.model");
const protect = require("../middleware/protect.middleware"); 
const router = express.Router();

// Create a refund request
router.post("/", protect, async (req, res) => {
  try {
    const { bookingId, amount, reason, customerId, customerMobile } = req.body;
    
    // Ensure customer can only request refund for their own account
    if (req.user._id.toString() !== customerId.toString()) {
      return res.status(403).json({ success: false, message: "Unauthorized to request refund for this customer" });
    }

    const newRefund = new Refund({
      bookingId,
      customerId,
      amount,
      reason,
      customerMobile
    });
    
    await newRefund.save();
    res.status(201).json({ success: true, message: "Refund request created successfully", refund: newRefund });
  } catch (error) {
    console.error("Refund error:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

module.exports = router;
