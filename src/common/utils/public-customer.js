/**
 * The customer fields the app is allowed to see about itself.
 *
 * Returning the raw Customer document leaked the Aadhaar number, bank / UPI details from withdrawal
 * requests, the signup IP and internal flags on every login, token refresh and profile call.
 * Both `_id` and `id` are included because different app screens read one or the other.
 */
function publicCustomer(customer) {
  if (!customer) return null;
  const c = typeof customer.toObject === 'function' ? customer.toObject() : customer;
  const id = String(c._id || c.id || '');
  return {
    _id: id,
    id,
    customerName: c.customerName || '',
    mobileNumber: c.mobileNumber || '',
    email: c.email || '',
    dob: c.dob || '',
    gender: c.gender || '',
    kycStatus: c.kycStatus,
    // The app shows / edits the driving-licence number; the Aadhaar number is never sent back.
    documents: { dlNumber: c.documents?.dlNumber || '' },
    referralCode: c.referralCode || '',
    walletBalance: c.walletBalance || 0,
    rewardsPoints: c.rewardsPoints || 0,
    createdAt: c.createdAt,
  };
}

module.exports = publicCustomer;
