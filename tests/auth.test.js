const request = require('supertest');
const express = require('express');

// The auth routes talk to MongoDB through models/User. Tests must not require a
// live database, so the model is mocked for the whole suite.
jest.mock('../models/User', () => ({
  findUserByEmail: jest.fn(),
  findUserById: jest.fn(),
}));

const User = require('../models/User');
const authRoutes = require('../routes/auth');

// Build a minimal Express app with just the auth routes for testing
const app = express();
app.use(express.json());
app.use('/api/v1/auth', authRoutes);

beforeEach(() => {
  User.findUserByEmail.mockReset();
  User.findUserById.mockReset();
  User.findUserByEmail.mockResolvedValue(null);
});

describe('POST /api/v1/auth/login', () => {
  it('returns 400 when email is missing', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ password: 'test123' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/required/i);
  });

  it('returns 400 when password is missing', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'test@example.com' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/required/i);
  });

  it('returns 400 for unknown credentials', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nonexistent@example.com', password: 'anything' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid credentials');
  });
});

describe('POST /api/v1/auth/register', () => {
  it('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'test@example.com' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/required/i);
  });

  it('returns 400 when the password is too short', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Test', email: 'test@example.com', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at least 8 characters/i);
  });
});

describe('POST /api/v1/auth/forgot-password', () => {
  it('returns 400 when email is missing', async () => {
    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/required/i);
  });

  it('returns 429 when called too quickly for the same email', async () => {
    User.findUserByEmail.mockResolvedValue({
      _id: 'user-1',
      email: 'ratelimit@test.com',
      save: jest.fn().mockResolvedValue(true),
    });

    // First call — issues a code and starts the 60s cooldown
    const first = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'ratelimit@test.com' });
    expect(first.status).toBe(200);

    // Second call within 60s — should be rate limited
    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'ratelimit@test.com' });
    expect(res.status).toBe(429);
    expect(res.body.message).toMatch(/wait/i);
  });
});
