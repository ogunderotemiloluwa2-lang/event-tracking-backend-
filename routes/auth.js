const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { getAuthorizationUrl, getAccessTokenFromCode } = require('../utils/googleDrive');

// PRODUCTION: Validate required environment variables
if (!process.env.JWT_SECRET) {
  throw new Error(
    '❌ CRITICAL ERROR: JWT_SECRET is not set in .env file\n' +
    'Generate one with: openssl rand -base64 32\n' +
    'Add JWT_SECRET to your .env file'
  );
}

const JWT_SECRET = process.env.JWT_SECRET;

// Normalize emails so sign-in is not broken by capitalization/whitespace
// (mobile keyboards often auto-capitalize the first letter of an email).
const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Register
router.post('/register', async (req, res) => {
  try {
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

    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: user._id, name: user.name, email: user.email,
        role: user.role, phone: user.phone || null, organization: user.organization || null
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Missing fields' });

    const normalizedEmail = normalizeEmail(email);
    const user = await User.findUserByEmail(normalizedEmail);
    if (!user) return res.status(400).json({ message: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: user._id, name: user.name, email: user.email,
        role: user.role, phone: user.phone || null, organization: user.organization || null
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Forgot Password - Send Verification Code
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required' });

    const user = await User.findUserByEmail(email);
    if (!user) return res.status(400).json({ message: 'If email exists, you will receive a verification code' });

    // Generate 6-digit verification code
    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    const resetCodeExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Save reset code to user
    user.resetCode = resetCode;
    user.resetCodeExpiry = resetCodeExpiry;
    await user.save();

    console.log(`📧 Password reset code for ${email}: ${resetCode} (expires in 10 minutes)`);

    res.json({ message: 'A 6-digit verification code has been sent to your email. Valid for 10 minutes.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Verify Reset Code
router.post('/verify-code', async (req, res) => {
  try {
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
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Reset Password
router.post('/reset-password', async (req, res) => {
  try {
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

    res.json({ message: 'Password reset successfully. You can now login with your new password.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Store Google Drive OAuth credentials
router.post('/save-google-drive', async (req, res) => {
  try {
    const { userId, accessToken, refreshToken } = req.body;

    if (!userId || !accessToken) {
      return res.status(400).json({ message: 'User ID and access token are required' });
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
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get user Google Drive status
router.get('/google-drive-status/:userId', async (req, res) => {
  try {
    const user = await User.findUserById(req.params.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    res.json({
      hasGoogleDrive: !!user.googleAccessToken,
      accessToken: user.googleAccessToken ? 'configured' : null
    });
  } catch (err) {
    console.error(err);
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

    console.log('📌 Google Auth URL generated');
    res.json({ authUrl });
  } catch (err) {
    console.error('Error getting Google auth URL:', err);
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

    console.log('🔐 Google OAuth callback received');
    console.log('   Code:', code.substring(0, 20) + '...');

    // Get access token using authorization code
    const tokenResult = await getAccessTokenFromCode(code);

    if (!tokenResult.success) {
      console.error('❌ Failed to get access token:', tokenResult.error);
      return res.status(400).send(`<h1>Authorization Failed</h1><p>${tokenResult.error}</p>`);
    }

    console.log('✅ Access token obtained');
    const { accessToken, refreshToken } = tokenResult;

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

          if (window.opener) {
            window.opener.postMessage({
              type: 'google-auth-success',
              accessToken: '${accessToken}',
              refreshToken: '${refreshToken || ''}'
            }, '*');
            setTimeout(function () { window.close(); }, 1500);
          }
        </script>
      </body>
    </html>
    `;

    res.send(htmlResponse);

  } catch (err) {
    console.error('Error in Google callback:', err);
    res.status(500).send('<h1>Server Error</h1><p>' + err.message + '</p>');
  }
});

// Save Google Drive Token (called from frontend after OAuth)
router.post('/save-google-token', async (req, res) => {
  try {
    const { userId, accessToken, refreshToken } = req.body;

    if (!userId || !accessToken) {
      return res.status(400).json({ message: 'User ID and access token are required' });
    }

    const user = await User.findUserById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    console.log('💾 Saving Google token for user:', user.email);
    
    // Save tokens
    user.googleAccessToken = accessToken;
    if (refreshToken) {
      user.googleRefreshToken = refreshToken;
    }
    await user.save();

    console.log('✅ Google token saved successfully');

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
    console.error('Error saving Google token:', err);
    res.status(500).json({ message: 'Server error: ' + err.message });
  }
});

module.exports = router;
