const request = require('supertest');
const express = require('express');
const cors = require('cors');

// Replicate the CORS setup from server.js
const allowedOrigins = ['http://localhost:3000'];

const app = express();
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(null, false);
  },
  credentials: true
}));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

describe('CORS configuration', () => {
  it('allows requests from localhost:3000', async () => {
    const res = await request(app)
      .get('/health')
      .set('Origin', 'http://localhost:3000');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('blocks requests from unknown origins', async () => {
    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://evil-site.com');
    // When origin is rejected, the header should not be set to the origin
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil-site.com');
  });

  it('allows requests with no origin (server-to-server)', async () => {
    const res = await request(app)
      .get('/health');
    // No origin header → should be allowed
    expect(res.status).toBe(200);
  });
});
