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
 * Builds its own OAuth2 client so callers don't have to.
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
 * Uses the stored refresh token so a fresh access token is minted
 * automatically (access tokens expire after ~1 hour).
 *
 * When googleapis refreshes the token internally, the 'tokens' event
 * fires so we can persist the new access token back to the database.
 */
function getAuthenticatedClient({ accessToken, refreshToken, userId }) {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({
    access_token: accessToken || undefined,
    refresh_token: refreshToken || undefined
  });

  // Persist refreshed tokens so uploads keep working after the 1-hour expiry
  if (userId && refreshToken) {
    oauth2Client.on('tokens', async (tokens) => {
      try {
        const Organizer = require('../models/Organizer');
        const update = {};
        if (tokens.access_token) update.googleAccessToken = tokens.access_token;
        // Google only sends a new refresh_token on the very first grant or
        // when the user re-consents — but if we get one, save it.
        if (tokens.refresh_token) update.googleRefreshToken = tokens.refresh_token;
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
 * Safely refresh the access token ONLY if it's expired or about to expire.
 *
 * PROBLEM THIS FIXES:
 * Previously this was called BEFORE every Drive API call, even when the
 * current access token was still valid. On the SECOND consecutive upload,
 * the redundant refresh would trigger a race condition:
 *   1. First upload: refreshAndPersistToken + tokens event both save to DB
 *   2. Second upload: another refresh is triggered, but the refresh token
 *      may have been consumed/invalidated by the first cycle, or the DB
 *      token state is in an inconsistent mid-save state
 *   3. The second refresh corrupts the oauth2client credentials, causing
 *      Google Drive to reject with "Insufficient permissions" (403)
 *
 * SOLUTION: Check the token's expiry_date before refreshing. If it's still
 * valid (within its ~1-hour window), skip the refresh entirely. This
 * eliminates the redundant refresh on consecutive uploads while still
 * ensuring expired tokens get refreshed on time.
 *
 * Returns the (possibly refreshed) access token string, or null if refresh
 * failed AND the existing token is expired.
 */
async function refreshAndPersistToken(oauth2Client, userId) {
  if (!oauth2Client.credentials?.refresh_token) {
    console.warn('⚠️ No refresh token available — cannot refresh access token');
    // Return the existing token so the caller can still try — it might work
    // if the token hasn't expired yet.
    return oauth2Client.credentials?.access_token || null;
  }

  // Check if the stored access token is still valid.
  // Google access tokens expire after 3600 seconds (1 hour).
  // We use a 5-minute buffer to avoid edge cases with clock drift.
  const expiryDate = oauth2Client.credentials.expiry_date;
  if (expiryDate && Date.now() < expiryDate - 5 * 60 * 1000) {
    console.log('✅ Access token still valid (expires in >5 min) — skipping refresh');
    return oauth2Client.credentials.access_token || null;
  }

  try {
    const { credentials } = await oauth2Client.refreshAccessToken();
    const freshToken = credentials.access_token;

    if (freshToken && userId) {
      const Organizer = require('../models/Organizer');
      // Save BOTH the new access token AND the refresh token (if Google
      // issued a new one during refresh — this happens occasionally and
      // the old refresh token is invalidated, so we MUST save the new one).
      const update = { googleAccessToken: freshToken };
      if (credentials.refresh_token) {
        update.googleRefreshToken = credentials.refresh_token;
      }
      await Organizer.findByIdAndUpdate(userId, update);
      console.log('🔄 Access token explicitly refreshed and saved for user', userId);
    }
    return freshToken || null;
  } catch (err) {
    console.error('❌ Failed to refresh access token:', err.message);
    // Return the existing token — it might still be valid for a few more minutes
    // even if we couldn't refresh. The Drive API call will fail with a clear
    // 401 if the token is truly expired, and the user will see the correct error.
    return oauth2Client.credentials?.access_token || null;
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
 * Authenticates AS THE ORGANIZER using their stored tokens. The refresh
 * token (when present) lets googleapis transparently mint a fresh access
 * token, so uploads keep working after the 1-hour access-token expiry.
 *
 * @param {Object} opts
 * @param {string} opts.folderId      - Destination Drive folder ID
 * @param {Buffer} opts.fileBuffer    - Image bytes
 * @param {string} opts.fileName      - File name
 * @param {string} opts.accessToken   - Organizer's access token (may be stale)
 * @param {string} opts.refreshToken  - Organizer's refresh token (preferred)
 * @param {string} [opts.mimeType]    - File mime type (defaults image/jpeg)
 * @param {string} [opts.photoCaption]
 * @param {string} [opts.eventId]   - MongoDB _id of the event (for cross-event filtering)
 */
async function uploadPhotoToGoogleDrive({
  folderId,
  fileBuffer,
  fileName,
  accessToken,
  refreshToken,
  userId,
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

    const oauth2Client = getAuthenticatedClient({ accessToken, refreshToken, userId });

    // Safely refresh the token ONLY if it's expired. The refresh also
    // persists the fresh token to the DB. If the token is still valid,
    // the refresh is skipped entirely (no redundant API calls).
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
    // Google returns the useful detail nested under response.data.error — surface
    // it so the caller (and ultimately the guest) sees the real reason.
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
async function getPhotosFromGoogleDrive({ folderId, accessToken, refreshToken, userId }) {
  try {
    const oauth2Client = getAuthenticatedClient({ accessToken, refreshToken, userId });
    await refreshAndPersistToken(oauth2Client, userId);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    // Fetch ALL event photos from the folder. Server-side filtering by eventId
    // is done in listEventPhotos (events.js) so that legacy photos uploaded before
    // the eventId tagging fix are still visible (they don't have the property).
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
 * Uploads a tiny, self-deleting probe file. If that works, the folder is
 * writable. Returns { ok: true } or { ok: false, error: '...' }.
 *
 * @param {Object} opts
 * @param {string} opts.folderId      - Destination Drive folder ID
 * @param {string} opts.accessToken   - Organizer's access token (may be stale)
 * @param {string} opts.refreshToken  - Organizer's refresh token
 * @param {string} opts.userId        - Organizer's MongoDB _id (for token persistence)
 */
async function verifyFolderWriteAccess({ folderId, accessToken, refreshToken, userId }) {
  try {
    const oauth2Client = getAuthenticatedClient({ accessToken, refreshToken, userId });
    await refreshAndPersistToken(oauth2Client, userId);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    // Create a tiny probe file so we can test write permissions without
    // relying solely on a metadata read (which doesn't prove write access).
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

    // Immediately delete the probe file so the folder stays clean.
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
