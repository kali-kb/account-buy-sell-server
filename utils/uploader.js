const dotenv = require('dotenv');
const cloudinary = require('cloudinary').v2;

dotenv.config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

async function cloudinaryUploader(buffer) {
  try {
    // Convert buffer to base64 string
    const base64Data = buffer.toString('base64');
    const dataUri = `data:image/jpeg;base64,${base64Data}`;
    
    const result = await cloudinary.uploader.upload(dataUri, {
      resource_type: 'auto'
    });
    console.log(result)
    return result.secure_url;
  } catch (error) {
    console.error('Error uploading to Cloudinary:', error);
    throw error;
  }
}

async function deleteFromCloudinary(imageUrl) {
  try {
    // Extract public_id from the Cloudinary URL
    const urlParts = imageUrl.split('/');
    const publicIdWithExtension = urlParts[urlParts.length - 1];
    const publicId = publicIdWithExtension.split('.')[0];
    
    const result = await cloudinary.uploader.destroy(publicId);
    console.log('Cloudinary delete result:', result);
    return result;
  } catch (error) {
    console.error('Error deleting from Cloudinary:', error);
    throw error;
  }
}

module.exports = { cloudinaryUploader, deleteFromCloudinary };
