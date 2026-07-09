const mongoose = require('mongoose');

const organizerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: String,
  organization: String,
  password: { type: String, required: true },
  role: { type: String, enum: ['organizer'], default: 'organizer' },
  resetCode: { type: String, default: null },
  resetCodeExpiry: { type: Date, default: null },
  googleAccessToken: { type: String, default: null },
  googleRefreshToken: { type: String, default: null },
  googleDriveFolderId: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
}, { collection: 'organizers' });

module.exports = mongoose.model('Organizer', organizerSchema);
