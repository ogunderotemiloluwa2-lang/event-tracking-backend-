const mongoose = require('mongoose');

const attendeeSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  email: {
    type: String,

    required: true  
  },
  phone: String,
  event: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Event',
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'yes', 'no', 'maybe'],
    default: 'pending'
  },
  passId: {
    type: String,
    unique: true,
    sparse: true
  },
  checkInTime: Date,
  photos: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Photo'
  }],
  guestCount: {
    type: Number,
    default: 1
  },
  dietaryRestrictions: String,
  specialRequests: String,
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Attendee', attendeeSchema);
