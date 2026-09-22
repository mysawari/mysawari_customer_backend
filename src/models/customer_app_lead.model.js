const mongoose = require('mongoose');

const customerAppLeadSchema = new mongoose.Schema({
  mobileNumber: { type: String, required: true, index: true },
  customerName: { type: String, default: '' },
  vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle' },
  vehicleName: { type: String, default: '' },
  fromDate: { type: Date },
  toDate: { type: Date },
  totalAmount: { type: Number },
  lastPageVisited: { type: String, default: 'explore' },
  status: { 
    type: String, 
    enum: ['abandoned', 'recovered', 'messaged'], 
    default: 'abandoned' 
  },
  whatsappSent: { type: Boolean, default: false }
}, {
  timestamps: true
});

module.exports = mongoose.model('CustomerAppLead', customerAppLeadSchema);
