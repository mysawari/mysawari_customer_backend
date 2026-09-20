const Customer = require('../../models/customer.model');
const AppError = require('../../common/errors/app-error');

const GENDERS = ['Male', 'Female', 'Other', ''];

class CustomerService {
  async getProfile(customerId) {
    const customer = await Customer.findById(customerId);
    if (!customer) {
      throw new AppError('Customer not found', 404);
    }
    return customer;
  }

  async updateProfile(customerId, profileData) {
    const updateFields = {};

    // Only allow updating specific fields
    const name = profileData.customerName || profileData.fullName;
    if (typeof name === 'string' && name.trim()) updateFields.customerName = name.trim();
    if (profileData.email !== undefined) updateFields.email = profileData.email;
    if (profileData.dob !== undefined) updateFields.dob = profileData.dob;
    if (profileData.gender !== undefined) {
      if (!GENDERS.includes(profileData.gender)) {
        throw new AppError('Invalid gender value', 400);
      }
      updateFields.gender = profileData.gender;
    }

    // Documents are stored under documents.* — accept both the nested shape
    // and the flat aadhaarNumber / drivingLicenseNumber the app sends.
    const docs = profileData.documents || {};
    const aadhaar = docs.aadhaarNumber ?? profileData.aadhaarNumber;
    const dl = docs.dlNumber ?? profileData.drivingLicenseNumber;
    if (aadhaar !== undefined) updateFields['documents.aadhaarNumber'] = aadhaar;
    if (dl !== undefined) updateFields['documents.dlNumber'] = dl;

    const customer = await Customer.findByIdAndUpdate(
      customerId,
      { $set: updateFields },
      { new: true, runValidators: true }
    );

    if (!customer) {
      throw new AppError('Customer not found', 404);
    }

    return customer;
  }
}

module.exports = CustomerService;
