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
  phone: {
    type: String,
    default: ''
  },
  event: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Event',
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AttendeeUser',
    default: null
  },
  status: {
    type: String,
    enum: ['pending', 'yes', 'no', 'maybe', 'confirmed', 'checked-in'],
    default: 'pending'
  },
  passId: {
    type: String,
    unique: true,
    sparse: true
  },
  qrCode: {
    type: String,
    default: ''
  },
  checkInTime: {
    type: Date,
    default: null
  },
  photos: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Photo'
  }],
  guestCount: {
    type: Number,
    default: 1
  },
  dietaryRestrictions: {
    type: String,
    default: ''
  },
  specialRequests: {
    type: String,
    default: ''
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, { collection: 'attendees' });

module.exports = mongoose.model('Attendee', attendeeSchema);
