const Customer = require('../../models/customer.model');
const AppError = require('../../common/errors/app-error');

const publicCustomer = require('../../common/utils/public-customer');

const GENDERS = ['Male', 'Female', 'Other', ''];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOB_RE = /^(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})?$/;
// Aadhaar: 12 digits. Indian DL: 2 letters + 13-14 alphanumerics (spaces / dashes allowed).
const AADHAAR_RE = /^(\d{12})?$/;
const DL_RE = /^([A-Za-z]{2}[0-9A-Za-z\s-]{8,18})?$/;

function optionalString(value, field, { max, pattern }) {
  if (typeof value !== 'string') throw new AppError(`Invalid ${field}`, 400);
  const v = value.trim();
  if (v.length > max || (pattern && !pattern.test(v))) throw new AppError(`Invalid ${field}`, 400);
  return v;
}

class CustomerService {
  async getProfile(customerId) {
    const customer = await Customer.findById(customerId);
    if (!customer) {
      throw new AppError('Customer not found', 404);
    }
    return publicCustomer(customer);
  }

  async updateProfile(customerId, profileData) {
    const updateFields = {};

    // Only allow updating specific fields
    profileData = profileData && typeof profileData === 'object' ? profileData : {};
    const name = profileData.customerName ?? profileData.fullName;
    if (name !== undefined) {
      const clean = optionalString(name, 'name', { max: 60 });
      if (clean) updateFields.customerName = clean;
    }
    if (profileData.email !== undefined) updateFields.email = optionalString(profileData.email, 'email', { max: 120, pattern: new RegExp(`^$|${EMAIL_RE.source}`) });
    if (profileData.dob !== undefined) updateFields.dob = optionalString(profileData.dob, 'date of birth', { max: 10, pattern: DOB_RE });
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
    if (aadhaar !== undefined) updateFields['documents.aadhaarNumber'] = optionalString(aadhaar, 'Aadhaar number', { max: 12, pattern: AADHAAR_RE });
    if (dl !== undefined) updateFields['documents.dlNumber'] = optionalString(dl, 'driving licence number', { max: 20, pattern: DL_RE }).toUpperCase();

    const customer = await Customer.findByIdAndUpdate(
      customerId,
      { $set: updateFields },
      { new: true, runValidators: true }
    );

    if (!customer) {
      throw new AppError('Customer not found', 404);
    }

    return publicCustomer(customer);
  }
  async deleteAccount(customerId) {
    const customer = await Customer.findById(customerId);
    if (!customer) {
      throw new AppError('Customer not found', 404);
    }
    
    // Hard delete the customer document as requested (adhering to no schema change).
    // The mobileNumber remains in the Bookings table for historical accounting.
    await Customer.findByIdAndDelete(customerId);
    
    // Clean up associated active sessions and device tokens
    const Token = require('../../models/token.model');
    const CustomerDevice = require('../../models/customer_device.model');
    
    await Token.deleteMany({ customerId });
    await CustomerDevice.deleteMany({ customerId });
    
    return true;
  }
}

module.exports = CustomerService;
