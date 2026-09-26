const CustomerService = require('./customer.service');

class CustomerController {
  constructor() {
    this.customerService = new CustomerService();
  }

  async getProfile(req, res, next) {
    try {
      const customer = await this.customerService.getProfile(req.user.id);
      res.status(200).json({
        status: 'success',
        data: { customer }
      });
    } catch (error) {
      next(error);
    }
  }

  async updateProfile(req, res, next) {
    try {
      const customerId = req.user.id;
      const profileData = req.body;

      const updatedCustomer = await this.customerService.updateProfile(customerId, profileData);

      res.status(200).json({
        status: 'success',
        data: {
          customer: updatedCustomer
        }
      });
    } catch (error) {
      next(error);
    }
  }
  async deleteProfile(req, res, next) {
    try {
      const customerId = req.user.id;
      await this.customerService.deleteAccount(customerId);
      
      res.status(200).json({
        status: 'success',
        message: 'Account deleted successfully'
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = CustomerController;
