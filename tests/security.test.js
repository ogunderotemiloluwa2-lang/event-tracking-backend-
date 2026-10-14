const request = require('supertest');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Build a minimal Express app with security middleware for testing
const app = express();
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  frameguard: { action: 'deny' },
}));

// Rate limiter for testing
const testLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: { message: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/test-rate-limit', testLimiter, (req, res) => {
  res.json({ ok: true });
});

app.get('/health', (req, res) => {
  res.json({ status: 'Server is running', timestamp: new Date().toISOString() });
});

describe('Security headers', () => {
  it('sets X-Content-Type-Options header', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets X-Frame-Options header', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('sets Content-Security-Policy header', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it('sets X-XSS-Protection header', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-xss-protection']).toBeDefined();
  });
});

describe('Rate limiting', () => {
  it('allows requests under the limit', async () => {
    const res = await request(app).get('/test-rate-limit');
    expect(res.status).toBe(200);
  });

  it('blocks requests over the limit', async () => {
    // Make 3 requests (the limit)
    for (let i = 0; i < 3; i++) {
      await request(app).get('/test-rate-limit');
    }
    // 4th request should be rate limited
    const res = await request(app).get('/test-rate-limit');
    expect(res.status).toBe(429);
    expect(res.body.message).toMatch(/too many/i);
  });
});