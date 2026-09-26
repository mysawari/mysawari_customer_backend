const mongoose = require('mongoose');

const customerDeviceSchema = new mongoose.Schema({
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true,
    index: true,
  },
  expoPushToken: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  deviceType: {
    type: String,
    enum: ['ios', 'android', 'web', 'unknown'],
    default: 'unknown'
  }
}, {
  timestamps: true,
  toJSON: {
    transform: function(doc, ret) {
      ret.id = ret._id;
      delete ret._id;
      delete ret.__v;
    }
  }
});

const CustomerDevice = mongoose.model('CustomerDevice', customerDeviceSchema);

module.exports = CustomerDevice;
