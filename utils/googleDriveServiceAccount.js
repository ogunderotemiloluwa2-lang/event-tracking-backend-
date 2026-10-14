const { google } = require('googleapis');
const { Readable } = require('stream');
const logger = require('./logger');

// Service account credentials from environment
let serviceAccountKey = null;
let drive = null;

try {
  const keyString = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (keyString) {
    serviceAccountKey = typeof keyString === 'string' ? JSON.parse(keyString) : keyString;
    logger.info('Google Service Account loaded from GOOGLE_SERVICE_ACCOUNT_KEY');
  }
} catch (err) {
  logger.warn('Could not parse GOOGLE_SERVICE_ACCOUNT_KEY', { error: err.message });
}

if (serviceAccountKey && serviceAccountKey.private_key) {
  // Initialize Google Auth
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccountKey,
    scopes: ['https://www.googleapis.com/auth/drive']
  });

  drive = google.drive({ version: 'v3', auth });
} else {
  logger.warn('Google Service Account credentials not found in .env — service account features disabled');
}

/**
 * Upload photo to Google Drive folder
 * @param {string} folderId - Google Drive folder ID where photo will be uploaded
 * @param {Buffer} fileBuffer - Image file buffer
 * @param {string} fileName - File name for the photo
 * @param {string} uploaderName - Name of person uploading the photo
 * @param {string} photoCaption - Caption/description for the photo
 * @returns {Promise<Object>} Upload result with file ID and URL
 */
const uploadPhotoToGoogleDrive = async (folderId, fileBuffer, fileName, uploaderName, photoCaption) => {
  try {
    if (!drive) {
      throw new Error('Google Service Account not configured');
    }

    if (!folderId) {
      throw new Error('Google Drive folder ID is required');
    }

    logger.info(`Uploading to Google Drive folder: ${folderId}`, { fileName, uploaderName });

    // Create a readable stream from the buffer
    const stream = Readable.from(fileBuffer);

    // Upload file to Google Drive
    const response = await drive.files.create({
      requestBody: {
        name: fileName,
        mimeType: 'image/jpeg',
        parents: [folderId], // Upload to the specified folder
        description: `Photo uploaded by ${uploaderName}. Caption: ${photoCaption || 'No caption'}`,
        properties: {
          uploader: uploaderName,
          caption: photoCaption,
          eventPhoto: 'true'
        }
      },
      media: {
        mimeType: 'image/jpeg',
        body: stream
      },
      fields: 'id, webViewLink, createdTime, mimeType, size, name'
    });

    logger.info('Successfully uploaded to Google Drive', { fileId: response.data.id, link: response.data.webViewLink });

    return {
      success: true,
      fileId: response.data.id,
      fileName: response.data.name,
      fileLink: response.data.webViewLink,
      mimeType: response.data.mimeType,
      size: response.data.size,
      createdTime: response.data.createdTime,
      uploaderName: uploaderName,
      photoCaption: photoCaption
    };
  } catch (err) {
    logger.error('Google Drive upload error', { error: err.message });
    return {
      success: false,
      error: err.message,
      code: err.code
    };
  }
};

/**
 * Get photos from a Google Drive folder
 * @param {string} folderId - Google Drive folder ID
 * @returns {Promise<Array>} Array of files in the folder
 */
const getPhotosFromGoogleDrive = async (folderId) => {
  try {
    if (!drive) {
      throw new Error('Google Service Account not configured');
    }

    if (!folderId) {
      throw new Error('Google Drive folder ID is required');
    }

    logger.info(`Fetching photos from Google Drive folder: ${folderId}`);

    const response = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='image/jpeg' and trashed=false`,
      spaces: 'drive',
      fields: 'files(id, name, webViewLink, createdTime, size, properties)',
      pageSize: 100,
      orderBy: 'createdTime desc'
    });

    logger.info(`Retrieved ${response.data.files.length} photos from Google Drive`);
    return response.data.files;
  } catch (err) {
    logger.error('Error fetching photos from Google Drive', { error: err.message });
    throw err;
  }
};

/**
 * Delete photo from Google Drive
 * @param {string} fileId - Google Drive file ID
 * @returns {Promise<Boolean>} Success status
 */
const deletePhotoFromGoogleDrive = async (fileId) => {
  try {
    logger.info(`Deleting file from Google Drive: ${fileId}`);
    
    await drive.files.delete({
      fileId: fileId
    });

    logger.info(`Successfully deleted: ${fileId}`);
    return true;
  } catch (err) {
    logger.error('Error deleting from Google Drive', { error: err.message });
    throw err;
  }
};

/**
 * Extract folder ID from Google Drive share link
 * @param {string} link - Google Drive folder link
 * @returns {string|null} Folder ID or null
 */
const extractFolderIdFromLink = (link) => {
  if (!link) return null;
  
  // Match /folders/ID or ?id=ID patterns
  const match = link.match(/\/folders\/([a-zA-Z0-9-_]+)|[?&]id=([a-zA-Z0-9-_]+)/);
  if (match) {
    return match[1] || match[2];
  }
  
  // If it's just an ID, return it as-is
  if (/^[a-zA-Z0-9-_]+$/.test(link)) {
    return link;
  }
  
  return null;
};

module.exports = {
  uploadPhotoToGoogleDrive,
  getPhotosFromGoogleDrive,
  deletePhotoFromGoogleDrive,
  extractFolderIdFromLink
};
