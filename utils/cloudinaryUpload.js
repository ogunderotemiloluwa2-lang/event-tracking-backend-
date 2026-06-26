const cloudinary = require('cloudinary').v2;

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

/**
 * Upload photo to Cloudinary
 * @param {Buffer} fileBuffer - Image file buffer
 * @param {string} fileName - Original file name
 * @param {string} eventId - Event ID for organization
 * @param {string} uploaderName - Name of person uploading
 * @param {string} photoCaption - Photo caption/description
 * @returns {Promise<Object>} Upload result with URL and metadata
 */
const uploadPhotoToCloudinary = async (fileBuffer, fileName, eventId, uploaderName, photoCaption) => {
  try {
    console.log(`📤 Uploading to Cloudinary: ${fileName}`);
    
    // Create a promise-based wrapper for buffer upload
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'auto',
          folder: `events/${eventId}`, // Organize by event ID
          public_id: `${uploaderName}-${Date.now()}-${fileName.split('.')[0]}`,
          tags: [eventId, uploaderName],
          context: {
            caption: photoCaption,
            uploader: uploaderName,
            event: eventId
          },
          eager: [
            { width: 300, height: 300, crop: 'fill', quality: 'auto', format: 'auto' } // Thumbnail
          ]
        },
        (error, result) => {
          if (error) {
            console.error('❌ Cloudinary upload error:', error);
            reject(error);
          } else {
            console.log(`✅ Successfully uploaded to Cloudinary`);
            console.log(`   URL: ${result.secure_url}`);
            console.log(`   Public ID: ${result.public_id}`);
            resolve(result);
          }
        }
      );

      // Write buffer to upload stream
      uploadStream.end(fileBuffer);
    });
  } catch (err) {
    console.error('Error uploading to Cloudinary:', err);
    throw err;
  }
};

/**
 * Delete photo from Cloudinary
 * @param {string} publicId - Cloudinary public ID of the image
 * @returns {Promise<Object>} Deletion result
 */
const deletePhotoFromCloudinary = async (publicId) => {
  try {
    console.log(`🗑️ Deleting from Cloudinary: ${publicId}`);
    const result = await cloudinary.uploader.destroy(publicId);
    console.log(`✅ Successfully deleted: ${publicId}`);
    return result;
  } catch (err) {
    console.error('Error deleting from Cloudinary:', err);
    throw err;
  }
};

/**
 * Get photos from an event folder
 * @param {string} eventId - Event ID
 * @returns {Promise<Array>} Array of photos in the event folder
 */
const getEventPhotos = async (eventId) => {
  try {
    console.log(`📸 Fetching photos for event: ${eventId}`);
    const result = await cloudinary.search
      .expression(`folder:events/${eventId}`)
      .max_results(500)
      .execute();
    
    console.log(`✅ Found ${result.resources.length} photos`);
    return result.resources;
  } catch (err) {
    console.error('Error fetching photos from Cloudinary:', err);
    throw err;
  }
};

/**
 * Generate optimized URL for image
 * @param {string} publicId - Cloudinary public ID
 * @returns {string} Optimized image URL with auto format and quality
 */
const getOptimizedUrl = (publicId) => {
  return cloudinary.url(publicId, {
    quality: 'auto',
    fetch_format: 'auto',
    width: 'auto',
    crop: 'scale'
  });
};

module.exports = {
  uploadPhotoToCloudinary,
  deletePhotoFromCloudinary,
  getEventPhotos,
  getOptimizedUrl
};
