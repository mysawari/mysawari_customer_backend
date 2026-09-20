const paymentService = require('./payment.service');
const ApiResponse = require('../../common/utils/api-response');
const asyncHandler = require('../../common/utils/async-handler');
const AppError = require('../../common/errors/app-error');

class PaymentController {
  createOrder = asyncHandler(async (req, res) => {
    const { amount } = req.body;
    if (!amount) throw new AppError('Amount is required', 400);

    const order = await paymentService.createOrder(req.user._id, amount);
    return ApiResponse.success(res, order, 'Order created');
  });

  verifySignature = asyncHandler(async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      throw new AppError('Missing Razorpay signature parameters', 400);
    }
    if (!paymentService.verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
      throw new AppError('Invalid signature', 400);
    }
    return ApiResponse.success(res, null, 'Payment verified successfully');
  });
}

module.exports = new PaymentController();
