const Razorpay = require('razorpay');
const crypto = require('crypto');
const AppError = require('../../common/errors/app-error');

const MAX_ORDER_RUPEES = 500000;

// Payment ids already redeemed for a booking/extension (in-memory, per process).
const redeemedPayments = new Set();

class PaymentService {
  // Created on first use so the API can boot (and non-payment routes work) without Razorpay keys.
  get razorpay() {
    if (!this._razorpay) {
      this._razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
      });
    }
    return this._razorpay;
  }

  get keyId() {
    return process.env.RAZORPAY_KEY_ID;
  }

  async createOrder(customerId, amountRupees) {
    const amount = Number(amountRupees);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_ORDER_RUPEES) {
      throw new AppError('Invalid payment amount', 400);
    }
    const order = await this.razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency: 'INR',
      receipt: `rcpt_${Date.now()}`,
      // Ties the order to the customer so it can't be redeemed by someone else.
      notes: { customerId: String(customerId) },
    });
    return { ...order, keyId: this.keyId };
  }

  verifySignature(orderId, paymentId, signature) {
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /**
   * Confirms with Razorpay itself that this payment exists, belongs to this
   * customer's order, is paid, and covers exactly `amountRupees`. Marks it as
   * redeemed so it can't be reused for a second booking.
   */
  async redeemPayment({ customerId, orderId, paymentId, amountRupees }) {
    if (!orderId || !paymentId) {
      throw new AppError('Payment details are required', 400);
    }
    if (redeemedPayments.has(paymentId)) {
      throw new AppError('This payment has already been used', 400);
    }

    let payment;
    let order;
    try {
      payment = await this.razorpay.payments.fetch(paymentId);
      order = await this.razorpay.orders.fetch(orderId);
    } catch (e) {
      throw new AppError('Unable to verify payment', 400);
    }

    if (!['captured', 'authorized'].includes(payment.status)) {
      throw new AppError('Payment has not been completed', 400);
    }
    if (payment.order_id !== orderId) {
      throw new AppError('Payment does not match the order', 400);
    }
    if (String(order.notes?.customerId) !== String(customerId)) {
      throw new AppError('Payment does not belong to this customer', 403);
    }
    if (payment.amount !== Math.round(Number(amountRupees) * 100)) {
      throw new AppError('Payment amount does not match the booking amount', 400);
    }

    redeemedPayments.add(paymentId);
    return payment;
  }

  releasePayment(paymentId) {
    redeemedPayments.delete(paymentId);
  }
}

module.exports = new PaymentService();
