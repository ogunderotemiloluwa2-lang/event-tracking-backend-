const { google } = require('googleapis');
const { Readable } = require('stream');

/**
 * Extract folder ID from Google Drive share link
 */
function extractFolderId(folderLink) {
  try {
    const foldersMatch = folderLink.match(/\/folders\/([a-zA-Z0-9-_]+)/);
    if (foldersMatch) return foldersMatch[1];
    const idMatch = folderLink.match(/[?&]id=([a-zA-Z0-9-_]+)/);
    if (idMatch) return idMatch[1];
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Validate Google Drive folder link
 */
function validateFolderLink(folderLink) {
  const folderId = extractFolderId(folderLink);
  if (!folderId) {
    return { valid: false, error: 'Invalid folder link format' };
  }
  return { valid: true, folderId };
}

/**
 * Create OAuth2 client for Google
 */
function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

/**
 * Get authorization URL for user to log in.
 */
function getAuthorizationUrl() {
  const oauth2Client = getOAuth2Client();
  const SCOPES = ['https://www.googleapis.com/auth/drive'];
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  return authUrl;
}

/**
 * Build an OAuth2 client authenticated as the organizer.
 *
 * CRITICAL FIX: We now also set `expiry_date` in the credentials so that
 * googleapis knows when the access token expires. Without this, the library
 * cannot determine if a token needs refreshing, and our own
 * `refreshAndPersistToken` would always try to refresh (causing redundant
 * API calls that break subsequent uploads).
 *
 * When googleapis refreshes the token internally, the 'tokens' event fires
 * so we can persist the new access token + expiry back to the database.
 */
function getAuthenticatedClient({ accessToken, refreshToken, expiryDate, userId }) {
  const oauth2Client = getOAuth2Client();
  const credentials = {
    access_token: accessToken || undefined,
    refresh_token: refreshToken || undefined
  };
  // If we have a saved expiry timestamp, set it so googleapis can
  // determine when to auto-refresh without an explicit call.
  if (expiryDate) {
    credentials.expiry_date = expiryDate;
  }
  oauth2Client.setCredentials(credentials);

  // Persist refreshed tokens so uploads keep working after the 1-hour expiry
  if (userId && refreshToken) {
    oauth2Client.on('tokens', async (tokens) => {
      try {
        const Organizer = require('../models/Organizer');
        const update = {};
        if (tokens.access_token) update.googleAccessToken = tokens.access_token;
        if (tokens.refresh_token) update.googleRefreshToken = tokens.refresh_token;
        // Also persist the expiry_date so subsequent requests know when to refresh
        if (tokens.expiry_date) {
          update.googleTokenExpiry = tokens.expiry_date;
        } else if (tokens.expires_in) {
          update.googleTokenExpiry = Date.now() + tokens.expires_in * 1000;
        }
        await Organizer.findByIdAndUpdate(userId, update);
        console.log('🔄 Google Drive token refreshed and saved for user', userId);
      } catch (err) {
        console.error('Failed to save refreshed Google token:', err.message);
      }
    });
  }

  return oauth2Client;
}

/**
 * Refresh the access token ONLY if it's expired (or close to expiring).
 *
 * ROOT CAUSE OF THE BUG:
 *  1. googleapis' `refreshAccessToken()` replaces `this.credentials` with
 *     Google's response, which is `{ access_token, expires_in, scope }` —
 *     it NEVER includes `refresh_token`. So after a refresh, the oauth2client
 *     LOSES its refresh_token and can no longer auto-refresh.
 *  2. The `expiry_date` was NEVER saved to the database. On every upload, a
 *     new oauth2client was created WITHOUT `expiry_date`, so googleapis
 *     didn't know when the token expires, and we always called refresh.
 *  3. The redundant second refresh (immediately after the first upload) would
 *     hit Google's token endpoint again, sometimes returning tokens with
 *     different scopes or throttling, causing the 403 "Insufficient permissions".
 *
 * WHAT WE DO NOW:
 *  - Before refreshing, check `expiry_date` and skip if still valid.
 *  - Before calling `refreshAccessToken()`, save the `refresh_token` so we
 *    can RESTORE it afterward (since the API response doesn't include it).
 *  - After refresh, save `expiry_date` to DB alongside the new access token.
 *  - On failure, return the existing access token (not null) so the
 *    upload can still attempt the API call — it might still work.
 *
 * Returns the (possibly refreshed) access token string, never null.
 */
async function refreshAndPersistToken(oauth2Client, userId) {
  const creds = oauth2Client.credentials || {};

  if (!creds.refresh_token) {
    console.warn('⚠️ No refresh token available — cannot refresh access token');
    return creds.access_token || '';
  }

  // Check if the stored access token is still valid.
  // Google access tokens expire after 3600 seconds (1 hour).
  // Use a 5-minute buffer to avoid edge cases with clock drift.
  if (creds.expiry_date && Date.now() < creds.expiry_date - 5 * 60 * 1000) {
    console.log('✅ Access token still valid (expires in >5 min) — skipping refresh');
    return creds.access_token || '';
  }

  try {
    // CRITICAL: Save the refresh_token BEFORE calling refreshAccessToken(),
    // because googleapis' refreshAccessToken() replaces this.credentials
    // with Google's response, which DOES NOT include refresh_token.
    const originalRefreshToken = creds.refresh_token;

    const { credentials } = await oauth2Client.refreshAccessToken();
    const freshToken = credentials.access_token;

    // CRITICAL: Restore the refresh_token to the oauth2client's credentials
    // because the refresh response never includes it. Without this, the
    // oauth2client loses the ability to auto-refresh for subsequent API
    // calls (e.g., drive.files.create after a refresh).
    if (!credentials.refresh_token && originalRefreshToken) {
      oauth2Client.setCredentials({
        ...credentials,
        refresh_token: originalRefreshToken
      });
    }

    // Persist the new tokens to the database, INCLUDING expiry_date.
    if (freshToken && userId) {
      const Organizer = require('../models/Organizer');
      const update = { googleAccessToken: freshToken };
      if (credentials.expiry_date) {
        update.googleTokenExpiry = credentials.expiry_date;
      } else if (credentials.expires_in) {
        update.googleTokenExpiry = Date.now() + credentials.expires_in * 1000;
      }
      if (credentials.refresh_token) {
        update.googleRefreshToken = credentials.refresh_token;
      }
      await Organizer.findByIdAndUpdate(userId, update);
      console.log('🔄 Access token refreshed and saved (with expiry) for user', userId);
    }
    return freshToken || '';
  } catch (err) {
    console.error('❌ Failed to refresh access token:', err.message);
    // Return the EXISTING token — it might still be valid for a few more
    // minutes. The Drive API call will fail with a clear 401 if the token
    // is truly expired, and the user will see the correct error.
    return oauth2Client.credentials?.access_token || '';
  }
}

/**
 * Get access token from authorization code
 */
async function getAccessTokenFromCode(code) {
  try {
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    return {
      success: true,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token
    };
  } catch (error) {
    console.error('Error getting access token:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Upload a photo to the organizer's Google Drive folder.
 *
 * Now also accepts `expiryDate` so we can set it on the oauth2client,
 * letting googleapis know when the token expires and avoiding redundant
 * refresh calls.
 */
async function uploadPhotoToGoogleDrive({
  folderId,
  fileBuffer,
  fileName,
  accessToken,
  refreshToken,
  userId,
  expiryDate,
  mimeType = 'image/jpeg',
  photoCaption = '',
  uploaderName = 'Guest',
  eventId = ''
}) {
  try {
    console.log('📤 Uploading photo to organizer Google Drive...');
    console.log('   Folder ID:', folderId);
    console.log('   File name:', fileName);
    console.log('   Has accessToken:', !!accessToken);
    console.log('   Has refreshToken:', !!refreshToken);
    console.log('   Has expiryDate:', !!expiryDate);

    const oauth2Client = getAuthenticatedClient({ accessToken, refreshToken, expiryDate, userId });

    // Refresh ONLY if the token is expired (checks expiry_date internally).
    // This prevents the redundant second refresh that caused the 403 bug.
    const refreshed = await refreshAndPersistToken(oauth2Client, userId);
    console.log('   Token after refresh check: exists=', !!refreshed);

    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const fileMetadata = {
      name: fileName,
      parents: [folderId],
      description: `EventFlow photo${photoCaption ? ': ' + photoCaption : ''}`,
      properties: {
        caption: photoCaption || '',
        uploaderName: uploaderName || 'Guest',
        eventPhoto: 'true',
        eventId: eventId || ''
      }
    };

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media: {
        mimeType,
        body: Readable.from(fileBuffer)
      },
      fields: 'id, name, webViewLink, thumbnailLink, mimeType, size, createdTime'
    });

    console.log('✅ Photo uploaded to Google Drive successfully!');
    console.log('   File ID:', response.data.id);

    return {
      success: true,
      fileId: response.data.id,
      fileName: response.data.name,
      fileLink: response.data.webViewLink,
      thumbnailLink: response.data.thumbnailLink,
      mimeType: response.data.mimeType,
      size: response.data.size,
      createdTime: response.data.createdTime
    };

  } catch (error) {
    const googleErr = error?.response?.data?.error;
    const detail = (googleErr && (googleErr.message || googleErr)) ||
      (Array.isArray(error?.errors) && error.errors[0]?.message) ||
      error.message;
    console.error('❌ Google Drive upload error:', detail);
    console.error('   Full Google error:', JSON.stringify(error?.response?.data || error.message));
    return {
      success: false,
      error: detail,
      code: error.code || googleErr?.status || 'UNKNOWN_ERROR'
    };
  }
}

/**
 * List photos from the organizer's Drive folder, authenticated as them.
 */
async function getPhotosFromGoogleDrive({ folderId, accessToken, refreshToken, userId, expiryDate }) {
  try {
    const oauth2Client = getAuthenticatedClient({ accessToken, refreshToken, expiryDate, userId });
    await refreshAndPersistToken(oauth2Client, userId);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const response = await drive.files.list({
      q: `'${folderId}' in parents and mimeType contains 'image/' and trashed=false`,
      spaces: 'drive',
      fields: 'files(id, name, webViewLink, thumbnailLink, createdTime, size, properties)',
      pageSize: 100,
      orderBy: 'createdTime desc'
    });

    console.log(`📸 Drive query returned ${response.data.files?.length || 0} photos`);
    return response.data.files || [];
  } catch (error) {
    const googleErr = error?.response?.data?.error;
    const detail = (googleErr && (googleErr.message || googleErr)) ||
      error.message;
    console.error('❌ Google Drive list error:', detail);
    throw new Error(detail);
  }
}

/**
 * Verify that the organizer can write to the specified Drive folder.
 */
async function verifyFolderWriteAccess({ folderId, accessToken, refreshToken, userId, expiryDate }) {
  try {
    const oauth2Client = getAuthenticatedClient({ accessToken, refreshToken, expiryDate, userId });
    await refreshAndPersistToken(oauth2Client, userId);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const probe = await drive.files.create({
      requestBody: {
        name: '__eventflow_probe__',
        parents: [folderId],
        description: 'EventFlow permission probe — auto-deleted',
      },
      media: {
        mimeType: 'text/plain',
        body: Readable.from(Buffer.from('probe')),
      },
      fields: 'id'
    });

    try {
      await drive.files.delete({ fileId: probe.data.id });
    } catch (cleanupErr) {
      console.warn('⚠️ Failed to clean up probe file:', cleanupErr.message);
    }

    return { ok: true };
  } catch (error) {
    const googleErr = error?.response?.data?.error;
    const detail = (googleErr && (googleErr.message || googleErr)) ||
      (Array.isArray(error?.errors) && error.errors[0]?.message) ||
      error.message;

    return {
      ok: false,
      error: detail,
      code: error.code || googleErr?.status || 'UNKNOWN_ERROR'
    };
  }
}

module.exports = {
  extractFolderId,
  validateFolderLink,
  getOAuth2Client,
  getAuthorizationUrl,
  getAuthenticatedClient,
  getAccessTokenFromCode,
  uploadPhotoToGoogleDrive,
  getPhotosFromGoogleDrive,
  verifyFolderWriteAccess,
  refreshAndPersistToken
};
