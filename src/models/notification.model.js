const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  target: {
    type: String,
    enum: ['all', 'specific'],
    default: 'specific'
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    default: null,
    index: true,
  },
  title: {
    type: String,
    required: true,
    trim: true,
  },
  body: {
    type: String,
    required: true,
    trim: true,
  },
  data: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  // To track which customers have read an 'all' broadcast notification. 
  // For 'specific' notifications, it's just marked as read via a simple boolean.
  readBy: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer'
  }],
  isRead: {
    type: Boolean,
    default: false
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

const Notification = mongoose.model('Notification', notificationSchema);

module.exports = Notification;
