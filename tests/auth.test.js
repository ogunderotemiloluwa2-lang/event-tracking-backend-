const request = require('supertest');
const express = require('express');
const cors = require('cors');
const authRoutes = require('../routes/auth');

// Build a minimal Express app with just the auth routes for testing
const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);

describe('POST /api/auth/login', () => {
  it('returns 400 when email is missing', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ password: 'test123' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/missing/i);
  });

  it('returns 400 when password is missing', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@example.com' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/missing/i);
  });

  it('returns 400 for unknown credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nonexistent@example.com', password: 'anything' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid credentials');
  });
});

describe('POST /api/auth/register', () => {
  it('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'test@example.com' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/missing/i);
  });
});

describe('POST /api/auth/forgot-password', () => {
  it('returns 400 when email is missing', async () => {
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/required/i);
  });

  it('returns 429 when called too quickly', async () => {
    // First call — will succeed or return generic message
    await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'ratelimit@test.com' });

    // Second call within 60s — should be rate limited
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'ratelimit@test.com' });
    expect(res.status).toBe(429);
    expect(res.body.message).toMatch(/wait/i);
  });
});
