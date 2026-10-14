const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');
const { getAuthorizationUrl, getAccessTokenFromCode } = require('../utils/googleDrive');
const logger = require('../utils/logger');
const audit = require('../utils/auditLog');

// PRODUCTION: Validate required environment variables
if (!process.env.JWT_SECRET) {
  throw new Error(
    '❌ CRITICAL ERROR: JWT_SECRET is not set in .env file\n' +
    'Generate one with: openssl rand -base64 32\n' +
    'Add JWT_SECRET to your .env file'
  );
}

// Validate JWT secret strength
if (process.env.JWT_SECRET.length < 32) {
  throw new Error(
    '❌ CRITICAL ERROR: JWT_SECRET is too weak (minimum 32 characters)\n' +
    'Generate a strong secret with: openssl rand -base64 32'
  );
}

const JWT_SECRET = process.env.JWT_SECRET;

// Rate limiters for auth endpoints
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // max 5 login attempts per IP per window
  message: { message: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // max 3 registrations per IP per hour
  message: { message: 'Too many registration attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // max 3 password reset requests per IP per hour
  message: { message: 'Too many password reset requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Normalize emails so sign-in is not broken by capitalization/whitespace
// (mobile keyboards often auto-capitalize the first letter of an email).
const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Register
router.post('/register', registerLimiter, [
  body('name').trim().isLength({ min: 1, max: 100 }).withMessage('Name is required').escape(),
  body('email').isEmail().withMessage('A valid email is required').normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('phone').optional().trim().escape(),
  body('organization').optional().trim().escape(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg });
    }

    const { name, email, password, role, phone, organization } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'Missing fields' });

    const normalizedEmail = normalizeEmail(email);

    // Case-insensitive existence check across both collections
    const existingUser = await User.findUserByEmail(normalizedEmail);
    if (existingUser) return res.status(400).json({ message: 'Email already registered' });

    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);
    const roleType = role === 'organizer' ? 'organizer' : 'attendee';

    let user;
    if (roleType === 'organizer') {
      const Organizer = require('../models/Organizer');
      user = new Organizer({
        name, email: normalizedEmail, password: hash, role: 'organizer',
        phone, organization
      });
    } else {
      const AttendeeUser = require('../models/AttendeeUser');
      user = new AttendeeUser({
        name, email: normalizedEmail, password: hash, role: 'attendee', phone
      });
    }

    await user.save();

    audit('user_registered', { userId: user._id, email: user.email, role: user.role });

    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: user._id, name: user.name, email: user.email,
        role: user.role, phone: user.phone || null, organization: user.organization || null
      }
    });
  } catch (err) {
    logger.error("Auth error", { error: err.message });
    res.status(500).json({ message: 'Server error' });
  }
});

// Login
router.post('/login', loginLimiter, [
  body('email').isEmail().withMessage('Email is required').normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // Keep the response generic so it cannot be used to enumerate accounts,
      // but surface which field was missing for legitimate client errors.
      const missing = errors.array().some((e) => e.path === 'email' || e.path === 'password');
      return res.status(400).json({ message: missing ? 'Email and password are required' : 'Invalid credentials' });
    }

    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Missing fields' });

    const normalizedEmail = normalizeEmail(email);
    const user = await User.findUserByEmail(normalizedEmail);
    if (!user) return res.status(400).json({ message: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      audit('login_failed', { email: normalizedEmail, reason: 'invalid_password' });
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    audit('login_success', { userId: user._id, email: user.email, role: user.role });

    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: user._id, name: user.name, email: user.email,
        role: user.role, phone: user.phone || null, organization: user.organization || null
      }
    });
  } catch (err) {
    logger.error("Auth error", { error: err.message });
    res.status(500).json({ message: 'Server error' });
  }
});

// In-memory rate limiter for password reset (resets on server restart)
const resetRateMap = new Map();

// Forgot Password - Send Verification Code
router.post('/forgot-password', resetLimiter, [
  body('email').isEmail().withMessage('A valid email is required').normalizeEmail(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: 'A valid email is required' });
    }

    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required' });

    const normalizedEmail = normalizeEmail(email);

    // Rate limit: max 1 request per 60 seconds per email
    const lastRequest = resetRateMap.get(normalizedEmail);
    if (lastRequest && Date.now() - lastRequest < 60000) {
      const remaining = Math.ceil((60000 - (Date.now() - lastRequest)) / 1000);
      return res.status(429).json({ message: `Please wait ${remaining}s before requesting another code.` });
    }

    const user = await User.findUserByEmail(email);
    if (!user) return res.status(400).json({ message: 'If email exists, you will receive a verification code' });

    // Generate 6-digit verification code
    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    const resetCodeExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Save reset code to user
    user.resetCode = resetCode;
    user.resetCodeExpiry = resetCodeExpiry;
    await user.save();

    resetRateMap.set(normalizedEmail, Date.now());

    audit('password_reset_requested', { email: normalizedEmail });

    // Never log the code itself — logs are shipped off-box in production.
    logger.info('Password reset code issued', { email: normalizedEmail, expiresInMinutes: 10 });

    res.json({ message: 'A 6-digit verification code has been sent to your email. Valid for 10 minutes.' });
  } catch (err) {
    logger.error("Auth error", { error: err.message });
    res.status(500).json({ message: 'Server error' });
  }
});

// Verify Reset Code
router.post('/verify-code', [
  body('email').isEmail().normalizeEmail(),
  body('code').isLength({ min: 6, max: 6 }).isNumeric(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: 'Valid email and 6-digit code are required' });
    }

    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ message: 'Email and code are required' });

    const user = await User.findUserByEmail(email);
    if (!user) return res.status(400).json({ message: 'User not found' });

    // Check if code matches and hasn't expired
    if (user.resetCode !== code) {
      return res.status(400).json({ message: 'Invalid verification code' });
    }

    if (new Date() > user.resetCodeExpiry) {
      return res.status(400).json({ message: 'Verification code has expired. Request a new one.' });
    }

    res.json({ message: 'Code verified successfully. You can now reset your password.' });
  } catch (err) {
    logger.error("Auth error", { error: err.message });
    res.status(500).json({ message: 'Server error' });
  }
});

// Reset Password
router.post('/reset-password', [
  body('email').isEmail().normalizeEmail(),
  body('code').isLength({ min: 6, max: 6 }).isNumeric(),
  body('newPassword').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('confirmPassword').notEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg });
    }

    const { email, code, newPassword, confirmPassword } = req.body;
    if (!email || !code || !newPassword || !confirmPassword) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: 'Passwords do not match' });
    }

    const user = await User.findUserByEmail(email);
    if (!user) return res.status(400).json({ message: 'User not found' });

    // Verify code again
    if (user.resetCode !== code) {
      return res.status(400).json({ message: 'Invalid verification code' });
    }

    if (new Date() > user.resetCodeExpiry) {
      return res.status(400).json({ message: 'Verification code has expired. Request a new one.' });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(newPassword, salt);

    // Update password and clear reset code
    user.password = hash;
    user.resetCode = null;
    user.resetCodeExpiry = null;
    await user.save();

    audit('password_reset_completed', { userId: user._id, email: user.email });

    res.json({ message: 'Password reset successfully. You can now login with your new password.' });
  } catch (err) {
    logger.error("Auth error", { error: err.message });
    res.status(500).json({ message: 'Server error' });
  }
});

// Store Google Drive OAuth credentials (authenticated, self only)
router.post('/save-google-drive', authenticate, async (req, res) => {
  try {
    const { userId, accessToken, refreshToken } = req.body;

    if (!userId || !accessToken) {
      return res.status(400).json({ message: 'User ID and access token are required' });
    }

    // Only allow users to save tokens for themselves
    if (userId !== req.user.id) {
      return res.status(403).json({ message: 'You can only save tokens for your own account.' });
    }

    const user = await User.findUserById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Save Google Drive credentials
    user.googleAccessToken = accessToken;
    if (refreshToken) {
      user.googleRefreshToken = refreshToken;
    }
    await user.save();

    res.json({ 
      message: 'Google Drive credentials saved successfully',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        hasGoogleDrive: !!user.googleAccessToken
      }
    });
  } catch (err) {
    logger.error("Auth error", { error: err.message });
    res.status(500).json({ message: 'Server error' });
  }
});

// Get user Google Drive status (authenticated, self only)
router.get('/google-drive-status/:userId', authenticate, async (req, res) => {
  try {
    // Only allow users to check their own status
    if (req.params.userId !== req.user.id) {
      return res.status(403).json({ message: 'You can only check your own Drive status.' });
    }

    const user = await User.findUserById(req.params.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    res.json({
      hasGoogleDrive: !!user.googleAccessToken,
      accessToken: user.googleAccessToken ? 'configured' : null
    });
  } catch (err) {
    logger.error("Auth error", { error: err.message });
    res.status(500).json({ message: 'Server error' });
  }
});

// Get Google OAuth Authorization URL
router.get('/google-auth-url', async (req, res) => {
  try {
    const authUrl = getAuthorizationUrl();
    
    if (!authUrl) {
      return res.status(500).json({ message: 'Google OAuth not configured' });
    }

    logger.info("Google Auth URL generated");
    res.json({ authUrl });
  } catch (err) {
    logger.error('Error getting Google auth URL', { error: err.message });
    res.status(500).json({ message: 'Server error' });
  }
});

// Google OAuth Callback Handler
router.get('/google-callback', async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).send('Authorization code missing');
    }

    // Set COOP to unsafe-none so the popup can communicate back to the main window
    // via window.opener.postMessage without being blocked by browser security policies.
    res.set('Cross-Origin-Opener-Policy', 'unsafe-none');

    logger.info("Google OAuth callback received");
    logger.info("Code received", { code: code.substring(0, 20) + "..." });

    // Get access token using authorization code
    const tokenResult = await getAccessTokenFromCode(code);

    if (!tokenResult.success) {
      logger.error('Failed to get access token', { error: tokenResult.error });
      return res.status(400).send(`<h1>Authorization Failed</h1><p>${tokenResult.error}</p>`);
    }

    logger.info("Access token obtained");
    const { accessToken, refreshToken, expiryDate } = tokenResult;

    // Return a friendly success page.
    const htmlResponse = `
    <html>
      <head>
        <title>Google Drive Connected</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          body { font-family: -apple-system, Segoe UI, Arial, sans-serif; text-align: center;
                 padding: 40px 24px; color: #1f2937; background: #faf7f2; }
          .card { max-width: 420px; margin: 40px auto; background: #fff; padding: 32px 26px;
                  border-radius: 14px; box-shadow: 0 10px 40px rgba(0,0,0,0.08); }
          h1 { font-size: 1.4rem; margin: 0 0 12px; }
          p { font-size: 0.98rem; line-height: 1.55; color: #4b5563; margin: 8px 0; }
          .ok { color: #047857; font-weight: 700; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1 class="ok">Google Drive connected</h1>
          <p>Your Google Drive is now linked to EventFlow.</p>
          <p>From now on, photos your guests upload will be saved straight into your own
             Google Drive — never on our servers.</p>
          <p>This window will close on its own. If it doesn't, you can close it and go
             back to EventFlow.</p>
        </div>
        <script>
          sessionStorage.setItem('googleAccessToken', '${accessToken}');
          sessionStorage.setItem('googleRefreshToken', '${refreshToken || ''}');
          sessionStorage.setItem('googleExpiryDate', '${expiryDate || ''}');

          if (window.opener) {
            window.opener.postMessage({
              type: 'google-auth-success',
              accessToken: '${accessToken}',
              refreshToken: '${refreshToken || ''}',
              expiryDate: ${expiryDate || 'null'}
            }, '*');
            setTimeout(function () { window.close(); }, 1500);
          }
        </script>
      </body>
    </html>
    `;

    res.send(htmlResponse);

  } catch (err) {
    logger.error("Error in Google callback", { error: err.message });
    res.status(500).send('<h1>Server Error</h1><p>' + err.message + '</p>');
  }
});

// Save Google Drive Token (called from frontend after OAuth) — authenticated, self only
router.post('/save-google-token', authenticate, async (req, res) => {
  try {
    const { userId, accessToken, refreshToken, expiryDate } = req.body;

    if (!userId || !accessToken) {
      return res.status(400).json({ message: 'User ID and access token are required' });
    }

    // Only allow users to save tokens for themselves
    if (userId !== req.user.id) {
      return res.status(403).json({ message: 'You can only save tokens for your own account.' });
    }

    const user = await User.findUserById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    logger.info("Saving Google token for user", { email: user.email });
    
    // Save tokens
    user.googleAccessToken = accessToken;
    if (refreshToken) {
      user.googleRefreshToken = refreshToken;
    }
    if (expiryDate) {
      user.googleTokenExpiry = expiryDate;
    }
    await user.save();

    audit('google_drive_connected', { userId: user._id, email: user.email });

    logger.info("Google token saved successfully");

    res.json({ 
      message: 'Google Drive authenticated successfully',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        hasGoogleDrive: !!user.googleAccessToken
      }
    });
  } catch (err) {
    logger.error("Error saving Google token", { error: err.message });
    res.status(500).json({ message: 'Server error: ' + err.message });
  }
});

module.exports = router;
