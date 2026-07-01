const express = require('express');
const router = express.Router();
const Event = require('../models/Event');
const Attendee = require('../models/Attendee');
const User = require('../models/User');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { uploadPhotoToGoogleDrive, getPhotosFromGoogleDrive, extractFolderId } = require('../utils/googleDrive');

// Local multer for photo uploads only (not applied globally)
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Get all events
router.get('/', async (req, res) => {
  try {
    const events = await Event.find().populate('attendees');
    res.json(events);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get event by ID
router.get('/:id', async (req, res) => {
  try {
    const event = await Event.findById(req.params.id).populate('attendees');
    if (!event) return res.status(404).json({ message: 'Event not found' });
    res.json(event);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create event
router.post('/', async (req, res) => {
  try {
    const {
      title, description, date, startTime, endTime, location, venue,
      timeZone, dressCode, ageRestriction, additionalInfo,
      capacity, expectedAttendees, organizerId, googleDriveFolderLink
    } = req.body;

    if (!title || !date || !organizerId) {
      return res.status(400).json({ message: 'Title, date, and organizerId are required' });
    }
    
    // Generate unique pass ID (8-character alphanumeric)
    const passId = Math.random().toString(36).substr(2, 8).toUpperCase();
    
    // Generate QR code from pass ID
    const qrCode = await QRCode.toDataURL(passId);
    
    // Extract Google Drive folder ID if provided
    let googleDriveFolderId = null;
    if (googleDriveFolderLink) {
      googleDriveFolderId = extractFolderId(googleDriveFolderLink);
      if (!googleDriveFolderId) {
        return res.status(400).json({ 
          message: 'Invalid Google Drive folder link format',
          hint: 'Please provide a valid Google Drive folder link like: https://drive.google.com/drive/folders/FOLDER_ID'
        });
      }
      console.log('✅ Extracted Google Drive Folder ID:', googleDriveFolderId);
    }
    
    const event = new Event({
      title,
      description,
      date,
      startTime,
      endTime,
      location,
      venue,
      timeZone,
      dressCode,
      ageRestriction,
      additionalInfo,
      capacity,
      expectedAttendees,
      createdBy: organizerId,
      passId,
      qrCode,
      googleDriveFolderLink,
      googleDriveFolderId,
      attendees: []
    });

    await event.save();
    res.status(201).json(event);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update event
router.put('/:id', async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });

    Object.assign(event, req.body);
    event.updatedAt = Date.now();
    await event.save();
    res.json(event);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete event
router.delete('/:id', async (req, res) => {
  try {
    const event = await Event.findByIdAndDelete(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });
    res.json({ message: 'Event deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Send email reminders
router.post('/:id/send-reminders', async (req, res) => {
  try {
    const { reminderType = 'confirmed', customMessage } = req.body;
    const event = await Event.findById(req.params.id).populate('attendees');
    if (!event) return res.status(404).json({ message: 'Event not found' });

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
      }
    });

    let recipients = [];
    if (reminderType === 'all') {
      recipients = event.attendees;
    } else if (reminderType === 'confirmed') {
      recipients = event.attendees.filter(a => a.status === 'yes' || a.status === 'confirmed');
    } else if (reminderType === 'maybe') {
      recipients = event.attendees.filter(a => a.status === 'maybe');
    } else if (reminderType === 'pending') {
      recipients = event.attendees.filter(a => a.status === 'pending');
    }

    for (const attendee of recipients) {
      const emailHtml = `
        <h2>Event Reminder: ${event.title}</h2>
        <p><strong>Date:</strong> ${new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
        <p><strong>Time:</strong> ${event.startTime || 'TBA'}</p>
        <p><strong>Location:</strong> ${event.venue || event.location}</p>
        ${customMessage ? `<hr><p>${customMessage}</p>` : ''}
        <hr><p>We look forward to seeing you!</p>
      `;
      
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: attendee.email,
        subject: `Reminder: ${event.title} Event`,
        html: emailHtml
      });
    }

    res.json({ message: `Reminders sent to ${recipients.length} attendees` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get events by organizer
router.get('/organizer/:organizerId', async (req, res) => {
  try {
    const events = await Event.find({ createdBy: req.params.organizerId }).populate('createdBy', 'name email organization');
    res.json(events);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get event details by passId
router.get('/by-passid/:passId', async (req, res) => {
  try {
    const event = await Event.findOne({ passId: req.params.passId })
      .populate('createdBy', 'name email organization');
    
    if (!event) return res.status(404).json({ message: 'Event not found' });
    
    res.json({
      ...event.toObject(),
      organizer: event.createdBy,
      attendeeCount: event.attendees.length,
      confirmedCount: event.attendees.filter(a => a.status === 'confirmed').length
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Join event by passId
router.post('/join-by-passid', async (req, res) => {
  try {
    const { passId, userId } = req.body;
    
    if (!passId || !userId) {
      return res.status(400).json({ message: 'passId and userId are required' });
    }

    const event = await Event.findOne({ passId });
    if (!event) return res.status(404).json({ message: 'Invalid pass ID' });

    // Check if user already joined
    const alreadyJoined = event.attendees.find(a => a.userId.toString() === userId);
    if (alreadyJoined) {
      return res.status(400).json({ message: 'You already joined this event' });
    }

    // Add attendee to event
    event.attendees.push({
      userId,
      status: 'pending',
      joinedAt: new Date()
    });

    await event.save();
    res.json({ message: 'Successfully joined event', event });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Confirm attendance (organizer accepts)
router.post('/:eventId/confirm-attendee', async (req, res) => {
  try {
    const { attendeeId } = req.body;
    const event = await Event.findById(req.params.eventId);
    
    if (!event) return res.status(404).json({ message: 'Event not found' });

    const attendee = event.attendees.find(a => a.userId.toString() === attendeeId);
    if (!attendee) return res.status(404).json({ message: 'Attendee not found' });

    attendee.status = 'confirmed';
    await event.save();
    
    res.json({ message: 'Attendee confirmed', event });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Global send reminders endpoint
router.post('/send-reminders', async (req, res) => {
  try {
    const { eventId, reminderType = 'confirmed', customMessage } = req.body;
    const event = await Event.findById(eventId).populate('attendees');
    if (!event) return res.status(404).json({ message: 'Event not found' });

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
      }
    });

    let recipients = [];
    if (reminderType === 'all') {
      recipients = event.attendees;
    } else if (reminderType === 'confirmed') {
      recipients = event.attendees.filter(a => a.status === 'yes' || a.status === 'confirmed');
    } else if (reminderType === 'maybe') {
      recipients = event.attendees.filter(a => a.status === 'maybe');
    } else if (reminderType === 'pending') {
      recipients = event.attendees.filter(a => a.status === 'pending');
    }

    for (const attendee of recipients) {
      const emailHtml = `
        <h2>Event Reminder: ${event.title}</h2>
        <p><strong>Date:</strong> ${new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
        <p><strong>Time:</strong> ${event.startTime || 'TBA'}</p>
        <p><strong>Location:</strong> ${event.venue || event.location}</p>
        ${customMessage ? `<hr><p>${customMessage}</p>` : ''}
        <hr><p>We look forward to seeing you!</p>
      `;
      
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: attendee.email,
        subject: `Reminder: ${event.title} Event`,
        html: emailHtml
      });
    }

    res.json({ message: `Reminders sent to ${recipients.length} attendees` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Upload photo DIRECTLY to Google Drive (NO server storage)
router.post('/:eventId/photos', photoUpload.single('file'), async (req, res) => {
  try {
    const { eventId } = req.params;
    const { passId, uploaderName, uploaderEmail, photoCaption } = req.body;
    const file = req.file;

    console.log('\n📸 PHOTO UPLOAD REQUEST RECEIVED');
    console.log('   Event ID:', eventId);
    console.log('   Uploader:', uploaderName);
    console.log('   File:', file?.originalname);

    if (!file) {
      return res.status(400).json({ message: 'No file provided' });
    }

    if (!eventId || !passId) {
      return res.status(400).json({ message: 'Event ID and Pass ID are required' });
    }

    if (!uploaderName || !uploaderEmail) {
      return res.status(400).json({ message: 'Uploader name and email are required' });
    }

    // Find event + its organizer (we upload AS the organizer)
    const event = await Event.findById(eventId).populate('createdBy');
    if (!event) {
      return res.status(404).json({ message: 'Event not found' });
    }

    console.log('   Event found:', event.title);

    // Check if event has Google Drive folder configured
    if (!event.googleDriveFolderId) {
      return res.status(400).json({
        message: 'Event organizer has not configured Google Drive folder for this event',
        details: 'The organizer needs to set up a Google Drive folder in the event settings'
      });
    }

    // The organizer must have connected their Google account (OAuth)
    const organizer = event.createdBy;
    if (!organizer || (!organizer.googleRefreshToken && !organizer.googleAccessToken)) {
      return res.status(400).json({
        message: 'The event organizer has not connected their Google Drive account yet',
        details: 'Ask the organizer to click "Connect Google Drive" on their dashboard, then try again.'
      });
    }

    console.log('   Google Drive Folder ID:', event.googleDriveFolderId);
    console.log('   Uploading as organizer:', organizer.email);

    // Upload DIRECTLY to the organizer's Google Drive
    console.log('📤 Uploading to Google Drive...');
    const uploadResult = await uploadPhotoToGoogleDrive({
      folderId: event.googleDriveFolderId,
      fileBuffer: file.buffer,
      fileName: file.originalname,
      accessToken: organizer.googleAccessToken,
      refreshToken: organizer.googleRefreshToken,
      userId: organizer._id,  // pass userId so refreshed tokens get saved
      mimeType: file.mimetype || 'image/jpeg',
      uploaderName,
      photoCaption
    });

    if (!uploadResult.success) {
      // Give a human, actionable message for the most common Google failures.
      const raw = String(uploadResult.error || '');
      let friendly = `Google Drive rejected the upload: ${raw}`;
      if (/invalid credentials|invalid_grant|unauthorized|401/i.test(raw)) {
        friendly = 'Google Drive access has expired. Ask the organizer to click "Connect Google Drive" again on their dashboard, then retry.';
      } else if (/insufficient|forbidden|403|permission/i.test(raw)) {
        friendly = 'The organizer\'s Google account can\'t write to this folder. Make sure the folder was created in the organizer\'s own Drive and shared with edit access.';
      } else if (/not found|404/i.test(raw)) {
        friendly = 'The Google Drive folder for this event could not be found. Ask the organizer to re-check the folder link.';
      }
      return res.status(500).json({
        message: friendly,
        error: uploadResult.error,
        code: uploadResult.code
      });
    }

    console.log('✅ PHOTO UPLOADED TO GOOGLE DRIVE SUCCESSFULLY');
    console.log('   File ID:', uploadResult.fileId);
    console.log('   URL:', uploadResult.fileLink);

    // Return success with Google Drive URL
    res.json({ 
      message: 'Photo uploaded successfully to Google Drive!',
      photoId: uploadResult.fileId,
      fileName: uploadResult.fileName,
      uploaderName: uploaderName,
      uploaderEmail: uploaderEmail,
      fileSize: uploadResult.size,
      googleDriveFileId: uploadResult.fileId,
      googleDriveUrl: uploadResult.fileLink,
      uploadedAt: uploadResult.createdTime,
      status: 'uploaded_to_drive'
    });

  } catch (error) {
    console.error('❌ Photo upload error:', error.message);
    console.error('Full error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
});

// Get photos from Google Drive for an event.
// Registered under both /photos and /photos-list (frontend calls the latter).
async function listEventPhotos(req, res) {
  try {
    const { eventId } = req.params;

    console.log('\n📸 FETCHING PHOTOS FOR EVENT');
    console.log('   Event ID:', eventId);

    // Get event + organizer (we read AS the organizer)
    const event = await Event.findById(eventId).populate('createdBy');
    if (!event) {
      return res.status(404).json({ message: 'Event not found' });
    }

    console.log('   Event found:', event.title);

    // Check if event has Google Drive folder configured
    if (!event.googleDriveFolderId) {
      return res.json({
        message: 'No Google Drive folder configured for this event',
        photos: [],
        totalCount: 0
      });
    }

    const organizer = event.createdBy;
    if (!organizer || (!organizer.googleRefreshToken && !organizer.googleAccessToken)) {
      return res.json({
        message: 'Organizer has not connected Google Drive',
        photos: [],
        totalCount: 0
      });
    }

    // Fetch photos from Google Drive
    console.log('📥 Fetching photos from Google Drive...');
    const photos = await getPhotosFromGoogleDrive({
      folderId: event.googleDriveFolderId,
      accessToken: organizer.googleAccessToken,
      refreshToken: organizer.googleRefreshToken,
      userId: organizer._id
    });

    console.log(`✅ Retrieved ${photos.length} photos from Google Drive`);

    // Format photos for frontend
    const formattedPhotos = photos.map(photo => ({
      photoId: photo.id,
      fileName: photo.name,
      uploaderName: photo.properties?.uploader || 'Unknown',
      photoCaption: photo.properties?.caption || '',
      uploadedAt: photo.createdTime,
      downloadUrl: photo.webViewLink,
      thumbnailUrl: photo.thumbnailLink || null,
      size: photo.size,
      fileId: photo.id
    }));

    res.json({
      message: 'Photos retrieved successfully from Google Drive',
      photos: formattedPhotos,
      totalCount: formattedPhotos.length
    });

  } catch (error) {
    console.error('❌ Error fetching photos:', error.message);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
}

router.get('/:eventId/photos', listEventPhotos);
router.get('/:eventId/photos-list', listEventPhotos);

module.exports = router;
