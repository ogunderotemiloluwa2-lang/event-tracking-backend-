const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Verify the JWT token from the Authorization header.
 * Attaches `req.user` (the decoded token payload) on success.
 */
function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication required. Please log in.' });
  }

  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, role }
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token. Please log in again.' });
  }
}

/**
 * Verify the user is an organizer.
 * Must be used AFTER `authenticate`.
 */
function requireOrganizer(req, res, next) {
  if (!req.user || req.user.role !== 'organizer') {
    return res.status(403).json({ message: 'Only organizers can perform this action.' });
  }
  next();
}

/**
 * Strip sensitive Google Drive fields from an event object before sending to client.
 * Drive fields are ONLY kept if the requester is the event's organizer.
 */
function sanitizeEvent(event, userId) {
  const obj = event.toObject ? event.toObject() : { ...event };
  
  // Always strip these from client responses
  delete obj.googleDriveFolderLink;
  delete obj.googleDriveFolderId;
  
  // Strip QR code unless it's the organizer viewing their own event
  if (!userId || !event.createdBy || (event.createdBy._id || event.createdBy).toString() !== userId) {
    delete obj.qrCode;
  }
  
  return obj;
}

/**
 * Strip sensitive fields from an array of events.
 */
function sanitizeEvents(events, userId) {
  return events.map(event => sanitizeEvent(event, userId));
}

module.exports = { authenticate, requireOrganizer, sanitizeEvent, sanitizeEvents };
