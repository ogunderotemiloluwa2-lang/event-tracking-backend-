const express = require('express');
const router = express.Router();
const Attendee = require('../models/Attendee');
const Event = require('../models/Event');
const crypto = require('crypto');
const { authenticate, requireOrganizer } = require('../middleware/auth');

// Get all attendees for an event (authenticated, organizer only)
router.get('/event/:eventId', authenticate, requireOrganizer, async (req, res) => {
  try {
    const attendees = await Attendee.find({ event: req.params.eventId });
    res.json(attendees);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Add attendee (authenticated, organizer only)
router.post('/', authenticate, requireOrganizer, async (req, res) => {
  try {
    const { name, email, phone, event, guestCount, dietaryRestrictions, specialRequests } = req.body;
    
    const passId = crypto.randomBytes(16).toString('hex');
    
    const attendee = new Attendee({
      name,
      email,
      phone,
      event,
      passId,
      guestCount,
      dietaryRestrictions,
      specialRequests
    });

    await attendee.save();

    // Add attendee to event
    await Event.findByIdAndUpdate(event, { $push: { attendees: attendee._id } });

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

    attendee.checkInTime = new Date();
    await attendee.save();
    res.json({ message: 'Checked in successfully', attendee });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete attendee (authenticated, organizer only)
router.delete('/:id', authenticate, requireOrganizer, async (req, res) => {
  try {
    const attendee = await Attendee.findByIdAndDelete(req.params.id);
    if (!attendee) return res.status(404).json({ message: 'Attendee not found' });
    
    await Event.findByIdAndUpdate(attendee.event, { $pull: { attendees: attendee._id } });
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
