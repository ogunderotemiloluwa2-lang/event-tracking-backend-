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
 */
function getAuthenticatedClient({ accessToken, refreshToken }) {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({
    access_token: accessToken || undefined,
    refresh_token: refreshToken || undefined
  });
  return oauth2Client;
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
 * @param {string} [opts.uploaderName]
 * @param {string} [opts.photoCaption]
 */
async function uploadPhotoToGoogleDrive({
  folderId,
  fileBuffer,
  fileName,
  accessToken,
  refreshToken,
  mimeType = 'image/jpeg',
  uploaderName = 'Attendee',
  photoCaption = ''
}) {
  try {
    console.log('📤 Uploading photo to organizer Google Drive...');
    console.log('   Folder ID:', folderId);
    console.log('   File name:', fileName);
    console.log('   Uploader:', uploaderName);

    const oauth2Client = getAuthenticatedClient({ accessToken, refreshToken });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const fileMetadata = {
      name: fileName,
      parents: [folderId],
      description: `Uploaded by ${uploaderName} via EventFlow${photoCaption ? ': ' + photoCaption : ''}`,
      properties: {
        uploader: uploaderName,
        caption: photoCaption || '',
        eventPhoto: 'true'
      }
    };

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media: {
        mimeType,
        body: Readable.from(fileBuffer)
      },
      fields: 'id, name, webViewLink, thumbnailLink, mimeType, size, createdTime',
      supportsAllDrives: true
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
    console.error('❌ Google Drive upload error:', error.message);
    return {
      success: false,
      error: error.message,
      code: error.code || 'UNKNOWN_ERROR'
    };
  }
}

/**
 * List photos from the organizer's Drive folder, authenticated as them.
 */
async function getPhotosFromGoogleDrive({ folderId, accessToken, refreshToken }) {
  const oauth2Client = getAuthenticatedClient({ accessToken, refreshToken });
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  const response = await drive.files.list({
    q: `'${folderId}' in parents and mimeType contains 'image/' and trashed=false`,
    spaces: 'drive',
    fields: 'files(id, name, webViewLink, thumbnailLink, createdTime, size, properties)',
    pageSize: 100,
    orderBy: 'createdTime desc',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });

  return response.data.files || [];
}

module.exports = {
  extractFolderId,
  validateFolderLink,
  getOAuth2Client,
  getAuthorizationUrl,
  getAuthenticatedClient,
  getAccessTokenFromCode,
  uploadPhotoToGoogleDrive,
  getPhotosFromGoogleDrive
};
