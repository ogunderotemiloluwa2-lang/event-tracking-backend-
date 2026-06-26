const mongoose = require('mongoose');

const photoSchema = new mongoose.Schema({
  eventId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Event',
    required: true
  },
  filename: {
    type: String,
    required: true
  },
  filesize: Number,
  mimetype: String,
  data: {
    type: String, // Base64 encoded image data
    required: true
  },
  uploaderName: {
    type: String,
    required: true
  },
  uploaderEmail: {
    type: String,
    required: true
  },
  caption: String,
  passId: String,
  googleDriveFileId: String,
  googleDriveFileLink: String,
  uploadedAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Photo', photoSchema);
