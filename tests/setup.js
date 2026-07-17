// Test setup — loads .env.test if present, otherwise falls back to .env
const path = require('path');
const fs = require('fs');

const testEnv = path.resolve(__dirname, '..', '.env.test');
if (fs.existsSync(testEnv)) {
  require('dotenv').config({ path: testEnv });
} else {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
}

// Ensure JWT_SECRET is set for tests
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-jwt-secret-not-for-production';
}
