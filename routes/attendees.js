const express = require('express');
const router = express.Router();
const Attendee = require('../models/Attendee');
const Event = require('../models/Event');
const crypto = require('crypto');
const { authenticate, requireOrganizer } = require('../middleware/auth');
const { findUserById } = require('../models/User');

// Get all attendees for an event (authenticated, organizer only)
router.get('/event/:eventId', authenticate, requireOrganizer, async (req, res) => {
  try {
    // Verify the organizer owns this event
    const event = await Event.findById(req.params.eventId);
    if (!event) return res.status(404).json({ message: 'Event not found' });
    if (event.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: 'You can only view attendees for your own events.' });
    }
    let attendees = await Attendee.find({ event: req.params.eventId });

    // Sync: ensure every entry in Event.attendees[] has a corresponding
    // Attendee record, so analytics and management show accurate counts.
    const attendeeUserIds = new Set(attendees.filter(a => a.userId).map(a => a.userId.toString()));
    for (const entry of event.attendees) {
      if (entry.userId && !attendeeUserIds.has(entry.userId.toString())) {
        try {
          const userRecord = await findUserById(entry.userId);
          if (userRecord) {
            const passId = crypto.randomBytes(16).toString('hex');
            const newAttendee = new Attendee({
              name: userRecord.name || 'Attendee',
              email: userRecord.email || '',
              event: event._id,
              userId: entry.userId,
              passId,
              status: entry.status || 'pending'
            });
            await newAttendee.save();
            attendees.push(newAttendee);
            attendeeUserIds.add(entry.userId.toString());
          }
        } catch (syncErr) {
          console.error('Failed to sync attendee:', syncErr.message);
        }
      }
    }

    res.json(attendees);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Add attendee (authenticated, organizer only)
router.post('/', authenticate, requireOrganizer, async (req, res) => {
  try {
    const { name, email, phone, event: eventId, guestCount, dietaryRestrictions, specialRequests } = req.body;
    
    // Verify the organizer owns this event
    const eventDoc = await Event.findById(eventId);
    if (!eventDoc) return res.status(404).json({ message: 'Event not found' });
    if (eventDoc.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: 'You can only add attendees to your own events.' });
    }
    
    const passId = crypto.randomBytes(16).toString('hex');
    
    const attendee = new Attendee({
      name,
      email,
      phone,
      event: eventId,
      passId,
      guestCount,
      dietaryRestrictions,
      specialRequests
    });

    await attendee.save();

    res.status(201).json(attendee);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update attendee RSVP status (authenticated, organizer only)
router.put('/:id', authenticate, requireOrganizer, async (req, res) => {
  try {
    const { status } = req.body;
    const attendee = await Attendee.findById(req.params.id);
    if (!attendee) return res.status(404).json({ message: 'Attendee not found' });

    // Verify the organizer owns the event this attendee belongs to
    const event = await Event.findById(attendee.event);
    if (!event || event.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: 'You can only update attendees for your own events.' });
    }

    attendee.status = status;
    attendee.updatedAt = Date.now();
    await attendee.save();
    res.json(attendee);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Check in attendee (authenticated, organizer only)
router.put('/:id/checkin', authenticate, requireOrganizer, async (req, res) => {
  try {
    const attendee = await Attendee.findById(req.params.id);
    if (!attendee) return res.status(404).json({ message: 'Attendee not found' });

    // Verify the organizer owns the event this attendee belongs to
    const event = await Event.findById(attendee.event);
    if (!event || event.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: 'You can only check in attendees for your own events.' });
    }

    attendee.checkInTime = new Date();
    attendee.status = 'checked-in';
    await attendee.save();
    res.json({ message: 'Checked in successfully', attendee });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete attendee (authenticated, organizer only)
router.delete('/:id', authenticate, requireOrganizer, async (req, res) => {
  try {
    const attendee = await Attendee.findById(req.params.id);
    if (!attendee) return res.status(404).json({ message: 'Attendee not found' });

    // Verify the organizer owns the event this attendee belongs to
    const event = await Event.findById(attendee.event);
    if (!event || event.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: 'You can only delete attendees for your own events.' });
    }

    await Attendee.findByIdAndDelete(req.params.id);
    res.json({ message: 'Attendee removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Submit attendee info (RSVP, dietary, etc.) — authenticated
router.post('/info', authenticate, async (req, res) => {
  try {
    const { eventId, userId, rsvpStatus, guestCount, dietaryRestrictions, specialRequests } = req.body;
    
    let attendee = await Attendee.findOne({ event: eventId, userId });
    
    if (!attendee) {
      attendee = new Attendee({
        event: eventId,
        userId,
        name: req.body.name || 'Attendee',
        email: req.body.email || '',
        status: rsvpStatus || 'pending'
      });
    }
    
    attendee.status = rsvpStatus;
    attendee.guestCount = guestCount || 0;
    attendee.dietaryRestrictions = dietaryRestrictions || '';
    attendee.specialRequests = specialRequests || '';
    attendee.updatedAt = Date.now();
    
    await attendee.save();
    res.json(attendee);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Check in attendee by pass ID (authenticated, organizer only)
router.post('/checkin/:eventId', authenticate, requireOrganizer, async (req, res) => {
  try {
    const { passId } = req.body;
    const attendee = await Attendee.findOne({ event: req.params.eventId, passId });
    
    if (!attendee) return res.status(404).json({ message: 'Attendee not found' });
    
    attendee.checkInTime = new Date();
    attendee.status = 'checked-in';
    await attendee.save();

    // Also update the Event.attendees[] status if this attendee has a userId
    if (attendee.userId) {
      try {
        const event = await Event.findById(attendee.event);
        if (event) {
          const eventAttendee = event.attendees.find(a => a.userId.toString() === attendee.userId.toString());
          if (eventAttendee) {
            eventAttendee.status = 'checked-in';
            await event.save();
          }
        }
      } catch (syncErr) {
        console.error('Failed to sync check-in to Event.attendees:', syncErr.message);
      }
    }
    
    res.json({ message: 'Checked in successfully', attendee });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

module.exports = router;
