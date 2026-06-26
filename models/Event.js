const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  description: String,
  date: {
    type: Date,
    required: true
  },
  startTime: String,
  endTime: String,
  location: String,
  venue: String,
  timeZone: {
    type: String,
    default: 'UTC'
  },
  dressCode: String,
  ageRestriction: String,
  additionalInfo: String,
  capacity: Number,
  expectedAttendees: Number,
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  passId: {
    type: String,
    unique: true,
    sparse: true
  },
  qrCode: String,
  attendees: [{
    userId: mongoose.Schema.Types.ObjectId,
    status: { type: String, enum: ['pending', 'confirmed', 'checked-in'], default: 'pending' },
    joinedAt: Date
  }],
  photos: {
    type: String,
    default: 'Photos are now stored directly in Google Drive. See googleDriveFolderLink.',
    deprecated: true
  },
  googleDriveFolderLink: {
    type: String,
    description: 'Shared Google Drive folder link where photos will be uploaded'
  },
  googleDriveFolderId: String,
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Event', eventSchema);
