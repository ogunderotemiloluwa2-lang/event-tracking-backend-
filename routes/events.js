const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Event = require('../models/Event');
const Attendee = require('../models/Attendee');
const { findUserById } = require('../models/User');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { authenticate, requireOrganizer, sanitizeEvent, sanitizeEvents } = require('../middleware/auth');
const { uploadPhotoToGoogleDrive, getPhotosFromGoogleDrive, extractFolderId, verifyFolderWriteAccess, getAuthenticatedClient, refreshAndPersistToken } = require('../utils/googleDrive');

// Local multer for photo uploads only (not applied globally)
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Get all events (public — only non-sensitive fields)
router.get('/', async (req, res) => {
  try {
    const events = await Event.find().populate('createdBy', 'name email organization').populate('attendees');
    // Strip all Google Drive data before sending to client
    const safe = sanitizeEvents(events, null);
    res.json(safe);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get event by ID (authenticated — strips Drive data unless user is the organizer)
router.get('/:id', authenticate, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id).populate('createdBy', 'name email organization').populate('attendees');
    if (!event) return res.status(404).json({ message: 'Event not found' });
    const safe = sanitizeEvent(event, req.user.id);
    res.json(safe);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create event (authenticated)
router.post('/', authenticate, async (req, res) => {
  try {
    const {
      title, description, date, startTime, endTime, location, venue,
      timeZone, dressCode, ageRestriction, additionalInfo,
      capacity, expectedAttendees, googleDriveFolderLink
    } = req.body;

    if (!title || !date) {
      return res.status(400).json({ message: 'Title and date are required' });
    }
    
    // Use the authenticated user's ID — never trust client-supplied organizerId
    const organizerId = req.user.id;
    
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

      // Validate that the organizer can write to this folder
      const organizer = await findUserById(organizerId);
      if (organizer && (organizer.googleRefreshToken || organizer.googleAccessToken)) {
        console.log('🔍 Validating folder write access...');
        const validation = await verifyFolderWriteAccess({
          folderId: googleDriveFolderId,
          accessToken: organizer.googleAccessToken,
          refreshToken: organizer.googleRefreshToken,
          expiryDate: organizer.googleTokenExpiry,
          userId: organizerId
        });

        if (!validation.ok) {
          return res.status(400).json({
            message: 'Google Drive folder validation failed',
            details: `The organizer's Google account can't write to this folder. Make sure the folder was created in YOUR OWN Google Drive (not shared by someone else). Then paste its link again.`,
            error: validation.error,
            code: validation.code
          });
        }
        console.log('✅ Folder write access verified');
      } else {
        console.log('⚠️ Google Drive not connected — skipping folder validation. Photos will fail until Drive is connected.');
      }
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
    // Strip Drive data from response
    const safe = sanitizeEvent(event, req.user.id);
    res.status(201).json(safe);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update event (authenticated, organizer only)
router.put('/:id', authenticate, requireOrganizer, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });

    // Only the event creator can update
    if (event.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: 'You can only edit your own events.' });
    }

    // If a new Drive folder link is provided, extract and validate
    if (req.body.googleDriveFolderLink) {
      const folderId = extractFolderId(req.body.googleDriveFolderLink);
      if (folderId) {
        // Validate the folder is writable by the organizer
        const organizer = await findUserById(req.user.id);
        if (organizer && (organizer.googleRefreshToken || organizer.googleAccessToken)) {
          console.log('🔍 Validating folder write access on update...');
          const validation = await verifyFolderWriteAccess({
            folderId,
            accessToken: organizer.googleAccessToken,
            refreshToken: organizer.googleRefreshToken,
            expiryDate: organizer.googleTokenExpiry,
            userId: req.user.id
          });

          if (!validation.ok) {
            return res.status(400).json({
              message: 'Google Drive folder validation failed',
              details: `This folder isn't writable by your account. Create a folder in YOUR OWN Google Drive and paste its link here.`,
              error: validation.error,
              code: validation.code
            });
          }
          console.log('✅ Folder write access verified on update');
        }
        event.googleDriveFolderId = folderId;
      }
    }

    // Whitelist which fields can be updated — never blindly copy req.body
    const ALLOWED_UPDATES = [
      'title', 'description', 'date', 'startTime', 'endTime',
      'location', 'venue', 'timeZone', 'dressCode', 'ageRestriction',
      'additionalInfo', 'capacity', 'expectedAttendees'
    ];
    for (const field of ALLOWED_UPDATES) {
      if (req.body[field] !== undefined) {
        event[field] = req.body[field];
      }
    }
    event.updatedAt = Date.now();
    await event.save();
    const safe = sanitizeEvent(event, req.user.id);
    res.json(safe);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete event (authenticated, organizer only)
router.delete('/:id', authenticate, requireOrganizer, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });

    // Only the event creator can delete
    if (event.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: 'You can only delete your own events.' });
    }

    await Event.findByIdAndDelete(req.params.id);
    res.json({ message: 'Event deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Send email reminders (authenticated, organizer only)
router.post('/:id/send-reminders', authenticate, requireOrganizer, async (req, res) => {
  try {
    const { reminderType = 'confirmed', customMessage } = req.body;
    const event = await Event.findById(req.params.id).populate('attendees');
    if (!event) return res.status(404).json({ message: 'Event not found' });

    // Only the event creator can send reminders
    if (event.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: 'You can only send reminders for your own events.' });
    }

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

    // Resolve real email addresses from Attendee records or identity models
    let sentCount = 0;
    for (const attendee of recipients) {
      let email = attendee.email;
      if (!email && attendee.userId) {
        const attRecord = await Attendee.findOne({ event: event._id, userId: attendee.userId });
        if (attRecord && attRecord.email) {
          email = attRecord.email;
        } else {
          const userRecord = await findUserById(attendee.userId);
          if (userRecord) email = userRecord.email;
        }
      }
      if (!email) continue;

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
        to: email,
        subject: `Reminder: ${event.title} Event`,
        html: emailHtml
      });
      sentCount++;
    }

    res.json({ message: `Reminders sent to ${sentCount} attendees` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get events by organizer (authenticated — only returns own events)
// Use /organizer/me to get the current user's events from the JWT token
router.get('/organizer/:organizerId', authenticate, async (req, res) => {
  try {
    // Resolve the organizerId: "me" means the authenticated user
    const targetId = req.params.organizerId === 'me' ? req.user.id : req.params.organizerId;
    
    // Only allow users to view their own organizer events
    if (targetId !== req.user.id) {
      return res.status(403).json({ message: 'You can only view your own events.' });
    }
    const events = await Event.find({ createdBy: targetId }).populate('createdBy', 'name email organization');
    const safe = sanitizeEvents(events, req.user.id);
    res.json(safe);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get event details by passId (public — only non-sensitive fields)
router.get('/by-passid/:passId', async (req, res) => {
  try {
    const event = await Event.findOne({ passId: req.params.passId })
      .populate('createdBy', 'name email organization');
    
    if (!event) return res.status(404).json({ message: 'Event not found' });
    
    const safe = sanitizeEvent(event, null);
    const response = {
      ...safe,
      organizer: event.createdBy,
      attendeeCount: event.attendees.length,
      confirmedCount: event.attendees.filter(a => a.status === 'confirmed').length
    };

    // If caller provided a valid token, include their unique attendee pass info
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const jwt = require('jsonwebtoken');
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const isInEvent = event.attendees.some(a => a.userId.toString() === decoded.id);
        if (isInEvent) {
          const attendeeRecord = await Attendee.findOne({ event: event._id, userId: decoded.id });
          if (attendeeRecord && attendeeRecord.passId) {
            response.attendeePassId = attendeeRecord.passId;
            response.attendeeQrCode = attendeeRecord.qrCode;
          }
        }
      } catch (e) {
        // Token invalid — just return public data
      }
    }

    res.json(response);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get all events a user has joined as attendee (authenticated)
// Use /by-user/me to get the current user's events from the JWT token
router.get('/by-user/:userId', authenticate, async (req, res) => {
  try {
    // Resolve the userId: "me" means the authenticated user
    const targetUserId = req.params.userId === 'me' ? req.user.id : req.params.userId;
    
    // Only allow users to view their own joined events
    if (targetUserId !== req.user.id) {
      return res.status(403).json({ message: 'You can only view your own events.' });
    }
    const events = await Event.find({ 'attendees.userId': targetUserId })
      .populate('createdBy', 'name email organization');
    const safe = sanitizeEvents(events, null);
    res.json(safe);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Join event by passId (authenticated)
router.post('/join-by-passid', authenticate, async (req, res) => {
  try {
    const { passId } = req.body;
    
    if (!passId) {
      return res.status(400).json({ message: 'passId is required' });
    }

    // Use the authenticated user's ID — never trust client-supplied userId
    const userId = req.user.id;

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

    // Also create an Attendee record so the attendee appears in management/check-in
    try {
      const userRecord = await findUserById(userId);
      if (userRecord) {
        const existingAttendee = await Attendee.findOne({ event: event._id, userId });
        if (!existingAttendee) {
          const attendeePassId = crypto.randomBytes(16).toString('hex');
          const attendee = new Attendee({
            name: userRecord.name || 'Attendee',
            email: userRecord.email || '',
            event: event._id,
            userId,
            passId: attendeePassId,
            status: 'pending'
          });
          await attendee.save();
        }
      }
    } catch (bridgeErr) {
      // Non-critical: the join succeeded in Event.attendees[]
      console.error('Failed to create Attendee bridge record:', bridgeErr.message);
    }

    res.json({ message: 'Successfully joined event' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Leave event (attendee removes themselves) — authenticated
router.post('/leave-by-passid', authenticate, async (req, res) => {
  try {
    const { passId } = req.body;
    
    if (!passId) {
      return res.status(400).json({ message: 'passId is required' });
    }

    // Use the authenticated user's ID
    const userId = req.user.id;

    const event = await Event.findOne({ passId });
    if (!event) return res.status(404).json({ message: 'Event not found' });

    const attendeeIndex = event.attendees.findIndex(a => a.userId.toString() === userId);
    if (attendeeIndex === -1) {
      return res.status(404).json({ message: 'You are not registered for this event' });
    }

    event.attendees.splice(attendeeIndex, 1);
    await event.save();

    // Also remove the linked Attendee record
    try {
      await Attendee.findOneAndDelete({ event: event._id, userId });
    } catch (bridgeErr) {
      console.error('Failed to remove Attendee bridge record:', bridgeErr.message);
    }

    res.json({ message: 'Successfully left event' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Confirm attendance (organizer accepts) — authenticated
router.post('/:eventId/confirm-attendee', authenticate, requireOrganizer, async (req, res) => {
  try {
    const { attendeeId } = req.body;
    const event = await Event.findById(req.params.eventId);
    
    if (!event) return res.status(404).json({ message: 'Event not found' });

    // Only the event creator can confirm attendees
    if (event.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: 'You can only confirm attendees for your own events.' });
    }

    const attendee = event.attendees.find(a => a.userId.toString() === attendeeId);
    if (!attendee) return res.status(404).json({ message: 'Attendee not found' });

    attendee.status = 'confirmed';
    await event.save();

    // Generate a unique passId + QR for this attendee's personal pass
    try {
      let attendeeRecord = await Attendee.findOne({ event: event._id, userId: attendeeId });
      if (!attendeeRecord) {
        // Create one for legacy attendees who joined before the bridge was added
        const userRecord = await findUserById(attendeeId);
        const attendeePassId = crypto.randomBytes(16).toString('hex');
        attendeeRecord = new Attendee({
          name: userRecord?.name || 'Attendee',
          email: userRecord?.email || '',
          event: event._id,
          userId: attendeeId,
          passId: attendeePassId,
          status: 'confirmed'
        });
      } else {
        // Update existing record
        const uniquePassId = crypto.randomBytes(16).toString('hex');
        attendeeRecord.passId = uniquePassId;
        attendeeRecord.status = 'confirmed';
      }
      // Generate QR code for the unique attendee passId
      const attendeeQr = await QRCode.toDataURL(attendeeRecord.passId);
      attendeeRecord.qrCode = attendeeQr;
      await attendeeRecord.save();
    } catch (bridgeErr) {
      console.error('Failed to update Attendee bridge record:', bridgeErr.message);
    }
    
    res.json({ message: 'Attendee confirmed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Global send reminders endpoint (authenticated, organizer only)
router.post('/send-reminders', authenticate, requireOrganizer, async (req, res) => {
  try {
    const { eventId, reminderType = 'confirmed', customMessage } = req.body;
    const event = await Event.findById(eventId).populate('attendees');
    if (!event) return res.status(404).json({ message: 'Event not found' });

    // Only the event creator can send reminders
    if (event.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: 'You can only send reminders for your own events.' });
    }

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

    // Resolve real email addresses from Attendee records or identity models
    let sentCount = 0;
    for (const attendee of recipients) {
      let email = attendee.email;
      if (!email && attendee.userId) {
        const attRecord = await Attendee.findOne({ event: event._id, userId: attendee.userId });
        if (attRecord && attRecord.email) {
          email = attRecord.email;
        } else {
          const userRecord = await findUserById(attendee.userId);
          if (userRecord) email = userRecord.email;
        }
      }
      if (!email) continue;

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
        to: email,
        subject: `Reminder: ${event.title} Event`,
        html: emailHtml
      });
      sentCount++;
    }

    res.json({ message: `Reminders sent to ${sentCount} attendees` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Upload photo DIRECTLY to Google Drive (NO server storage)
router.post('/:eventId/photos', authenticate, photoUpload.single('file'), async (req, res) => {
  try {
    const { eventId } = req.params;
    const { passId, photoCaption, uploaderName } = req.body;
    const file = req.file;

    console.log('\n📸 PHOTO UPLOAD REQUEST RECEIVED');
    console.log('   Event ID:', eventId);
    console.log('   File:', file?.originalname);

    if (!file) {
      return res.status(400).json({ message: 'No file provided' });
    }

    if (!eventId || !passId) {
      return res.status(400).json({ message: 'Event ID and Pass ID are required' });
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
      expiryDate: organizer.googleTokenExpiry,
      userId: organizer._id,  // pass userId so refreshed tokens get saved
      mimeType: file.mimetype || 'image/jpeg',
      photoCaption,
      uploaderName: uploaderName || 'Guest',
      eventId: event._id.toString()  // tag photo with event ID so we can filter by it
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
    const allPhotos = await getPhotosFromGoogleDrive({
      folderId: event.googleDriveFolderId,
      accessToken: organizer.googleAccessToken,
      refreshToken: organizer.googleRefreshToken,
      expiryDate: organizer.googleTokenExpiry,
      userId: organizer._id
    });

    // STRICT eventId filtering — only show photos explicitly tagged for this
    // specific event. Legacy photos (uploaded before the eventId tagging fix was
    // deployed) don't have an eventId property and will no longer appear, but this
    // guarantees ZERO cross-event photo leakage when multiple events share the
    // same Google Drive folder.
    const photos = allPhotos.filter(photo => {
      return photo.properties?.eventId === eventId;
    });

    console.log(`✅ Retrieved ${allPhotos.length} raw photos, filtered to ${photos.length} for event ${eventId}`);

    // Format photos for frontend
    const formattedPhotos = photos.map(photo => ({
      photoId: photo.id,
      fileName: photo.name,
      photoCaption: photo.properties?.caption || '',
      uploaderName: photo.properties?.uploaderName || 'Guest',
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

router.get('/:eventId/photos', authenticate, listEventPhotos);
router.get('/:eventId/photos-list', authenticate, listEventPhotos);

// Proxy Google Drive image — serves the image bytes using the organizer's OAuth tokens
// so the frontend <img> tag doesn't hit Google's auth wall.
router.get('/:eventId/drive-image/:fileId', authenticate, async (req, res) => {
  try {
    const { eventId, fileId } = req.params;

    const event = await Event.findById(eventId).populate('createdBy');
    if (!event) return res.status(404).json({ message: 'Event not found' });

    const organizer = event.createdBy;
    if (!organizer || (!organizer.googleRefreshToken && !organizer.googleAccessToken)) {
      return res.status(400).json({ message: 'Organizer has not connected Google Drive' });
    }

    const oauth2Client = getAuthenticatedClient({
      accessToken: organizer.googleAccessToken,
      refreshToken: organizer.googleRefreshToken,
      expiryDate: organizer.googleTokenExpiry,
      userId: organizer._id
    });
    await refreshAndPersistToken(oauth2Client, organizer._id);

    // Get the fresh access token from credentials
    const accessToken = oauth2Client.credentials?.access_token;
    if (!accessToken) return res.status(500).json({ message: 'Failed to get access token' });

    // Fetch the image from Google Drive using the access token
    const axios = require('axios');
    const driveResponse = await axios({
      method: 'GET',
      url: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      responseType: 'stream',
    });

    // Forward content-type and content-length
    if (driveResponse.headers['content-type']) {
      res.setHeader('Content-Type', driveResponse.headers['content-type']);
    }
    if (driveResponse.headers['content-length']) {
      res.setHeader('Content-Length', driveResponse.headers['content-length']);
    }
    // Cache for 1 hour so repeated views don't re-fetch
    res.setHeader('Cache-Control', 'public, max-age=3600');

    driveResponse.data.pipe(res);
  } catch (error) {
    console.error('❌ Drive image proxy error:', error.message);
    res.status(500).json({ message: 'Failed to fetch image from Google Drive' });
  }
});

module.exports = router;
