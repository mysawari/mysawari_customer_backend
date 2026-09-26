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
    if (!Number.isFinite(amount) || amount < 1 || amount > MAX_ORDER_RUPEES) {
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
    const b = Buffer.from(String(signature || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /**
   * Confirms with Razorpay itself that this payment exists, belongs to this customer's order, covers
   * exactly `amountRupees`, and has never been used before. The "used" mark is written onto the
   * Razorpay order (notes.redeemed), so it survives restarts and is shared by every server instance —
   * the old in-memory list alone let one payment pay for a second booking after any restart.
   * An authorized-but-uncaptured payment is captured here, otherwise Razorpay would refund it later.
   */
  async redeemPayment({ customerId, orderId, paymentId, amountRupees }) {
    if (!orderId || !paymentId || typeof orderId !== 'string' || typeof paymentId !== 'string') {
      throw new AppError('Payment details are required', 400);
    }
    if (!/^order_[A-Za-z0-9]{6,40}$/.test(orderId) || !/^pay_[A-Za-z0-9]{6,40}$/.test(paymentId)) {
      throw new AppError('Invalid payment details', 400);
    }
    if (redeemedPayments.has(paymentId)) {
      throw new AppError('This payment has already been used', 400);
    }
    // Reserve it in this process straight away so two parallel requests can't both pass the checks below.
    redeemedPayments.add(paymentId);

    try {
      let payment;
      let order;
      try {
        payment = await this.razorpay.payments.fetch(paymentId);
        order = await this.razorpay.orders.fetch(orderId);
      } catch (e) {
        throw new AppError('Unable to verify payment', 400);
      }

      const expectedPaise = Math.round(Number(amountRupees) * 100);
      if (!['captured', 'authorized'].includes(payment.status)) {
        throw new AppError('Payment has not been completed', 400);
      }
      if (payment.order_id !== orderId) {
        throw new AppError('Payment does not match the order', 400);
      }
      if (String(order.notes?.customerId) !== String(customerId)) {
        throw new AppError('Payment does not belong to this customer', 403);
      }
      if (payment.amount !== expectedPaise || Number(order.amount) !== expectedPaise || payment.currency !== 'INR') {
        throw new AppError('Payment amount does not match the booking amount', 400);
      }
      if (order.notes?.redeemed === 'yes') {
        throw new AppError('This payment has already been used', 400);
      }

      if (payment.status === 'authorized') {
        try {
          await this.razorpay.payments.capture(paymentId, payment.amount, 'INR');
        } catch (e) {
          throw new AppError('Payment could not be completed. Please try again.', 400);
        }
      }

      // Persistently mark the order as used (kept alongside the customer tag).
      try {
        await this.razorpay.orders.edit(orderId, { notes: { ...(order.notes || {}), redeemed: 'yes' } });
      } catch (e) {
        console.error('[Payments] Could not mark order as redeemed:', e?.error?.description || e.message);
      }
      return payment;
    } catch (e) {
      redeemedPayments.delete(paymentId);
      throw e;
    }
  }

  /**
   * Returns a payment to the customer through Razorpay (the only safe outcome when the car they paid for
   * has gone to someone else). The payment stays marked as used, so it can never pay for anything else.
   * Returns the refund id, or null when Razorpay could not be reached (logged loudly for manual follow-up).
   */
  async refundPayment(paymentId, amountRupees, reason) {
    try {
      const refund = await this.razorpay.payments.refund(paymentId, {
        amount: Math.round(Number(amountRupees) * 100),
        speed: 'normal',
        notes: { reason: String(reason || 'Booking could not be completed').slice(0, 250) },
      });
      console.log(JSON.stringify({ t: new Date().toISOString(), business: 'refund_issued', paymentId, amountRupees, refundId: refund?.id, reason }));
      return refund?.id || 'refund';
    } catch (e) {
      console.error(JSON.stringify({ t: new Date().toISOString(), business: 'refund_failed_manual_action_needed', paymentId, amountRupees, reason, error: e?.error?.description || e.message }));
      return null;
    }
  }

  /**
   * A payment whose booking no longer exists: refund it, but only after proving it really is this
   * customer's, fully paid, and not already used for something else.
   */
  async refundOrphanPayment({ customerId, orderId, paymentId, reason }) {
    if (typeof orderId !== 'string' || typeof paymentId !== 'string'
      || !/^order_[A-Za-z0-9]{6,40}$/.test(orderId) || !/^pay_[A-Za-z0-9]{6,40}$/.test(paymentId)) {
      return null;
    }
    if (redeemedPayments.has(paymentId)) return null;
    redeemedPayments.add(paymentId);
    try {
      const payment = await this.razorpay.payments.fetch(paymentId);
      const order = await this.razorpay.orders.fetch(orderId);
      if (payment.order_id !== orderId || String(order.notes?.customerId) !== String(customerId)) return null;
      if (order.notes?.redeemed === 'yes' || order.notes?.refunded === 'yes') return null;
      if (!['captured', 'authorized'].includes(payment.status)) return null;
      if (payment.status === 'authorized') await this.razorpay.payments.capture(paymentId, payment.amount, 'INR');
      await this.razorpay.orders.edit(orderId, { notes: { ...(order.notes || {}), redeemed: 'yes', refunded: 'yes' } }).catch(() => {});
      return await this.refundPayment(paymentId, payment.amount / 100, reason);
    } catch (e) {
      redeemedPayments.delete(paymentId);
      console.error(JSON.stringify({ t: new Date().toISOString(), business: 'orphan_refund_failed_manual_action_needed', paymentId, error: e?.error?.description || e.message }));
      return null;
    }
  }

  /** Lets a payment be used again after the booking it was checked for could not be saved. */
  async releasePaymentAsync(paymentId, orderId) {
    redeemedPayments.delete(paymentId);
    if (!orderId) return;
    try {
      const order = await this.razorpay.orders.fetch(orderId);
      const { redeemed, ...rest } = order.notes || {};
      await this.razorpay.orders.edit(orderId, { notes: rest });
    } catch (e) {
      console.error('[Payments] Could not release order:', e?.error?.description || e.message);
    }
  }

  releasePayment(paymentId) {
    redeemedPayments.delete(paymentId);
  }

}

module.exports = new PaymentService();
