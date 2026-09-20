const jwt = require('jsonwebtoken');
const Customer = require('../models/customer.model');
const AppError = require('../common/errors/app-error');
const { JWT_SECRET, JWT_ISSUER, JWT_AUDIENCE } = require('../config/secrets');

const protect = async (req, res, next) => {
  try {
    let token;

    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith('Bearer')
    ) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return next(new AppError('Not authorized to access this route', 401));
    }

    const decoded = jwt.verify(token, JWT_SECRET, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });

    const customer = await Customer.findById(decoded.id);

    if (!customer) {
      return next(new AppError('Not authorized to access this route', 401));
    }
    if (customer.status === 'blocked') {
      return next(new AppError('Account is blocked', 403));
    }

    req.user = customer;
    next();
  } catch (error) {
    return next(new AppError('Not authorized to access this route', 401));
  }
};

module.exports = protect;
