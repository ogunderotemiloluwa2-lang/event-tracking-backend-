const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const { authenticate, requireOrganizer } = require('../middleware/auth');

// Build a minimal app to test middleware ownership patterns
const app = express();
app.use(express.json());

// Simulate an event-owned resource route
app.get('/api/test-resource/:eventId', authenticate, requireOrganizer, (req, res) => {
  // In a real route this would check event.createdBy === req.user.id
  res.json({ ok: true, userId: req.user.id, role: req.user.role });
});

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-not-for-production';

describe('Authentication middleware', () => {
  it('rejects requests without Authorization header', async () => {
    const res = await request(app).get('/api/test-resource/abc123');
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/authentication required/i);
  });

  it('rejects requests with malformed token', async () => {
    const res = await request(app)
      .get('/api/test-resource/abc123')
      .set('Authorization', 'Bearer not-a-valid-token');
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/invalid or expired token/i);
  });

  it('rejects attendee tokens on organizer-only routes', async () => {
    const token = jwt.sign({ id: 'abc123', role: 'attendee' }, JWT_SECRET, { expiresIn: '1h' });
    const res = await request(app)
      .get('/api/test-resource/abc123')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/only organizers/i);
  });

  it('allows organizer tokens on organizer-only routes', async () => {
    const token = jwt.sign({ id: 'org123', role: 'organizer' }, JWT_SECRET, { expiresIn: '1h' });
    const res = await request(app)
      .get('/api/test-resource/abc123')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('organizer');
  });
});
