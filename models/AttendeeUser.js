const mongoose = require('mongoose');

const attendeeUserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: String,
  password: { type: String, required: true },
  role: { type: String, enum: ['attendee'], default: 'attendee' },
  resetCode: { type: String, default: null },
  resetCodeExpiry: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
}, { collection: 'attendee' });

module.exports = mongoose.model('AttendeeUser', attendeeUserSchema);
