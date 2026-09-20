const crypto = require('crypto');
const AppError = require('../common/errors/app-error');

// Reviews photos live in one folder so uploads can be validated by URL.
const REVIEW_FOLDER = 'mysawari/reviews';

function readConfig() {
  let cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  let apiKey = process.env.CLOUDINARY_API_KEY;
  let apiSecret = process.env.CLOUDINARY_API_SECRET;

  // Also accept the single-variable form: cloudinary://<key>:<secret>@<cloud>
  if ((!cloudName || !apiKey || !apiSecret) && process.env.CLOUDINARY_URL) {
    const m = process.env.CLOUDINARY_URL.match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
    if (m) [, apiKey, apiSecret, cloudName] = m;
  }
  return { cloudName, apiKey, apiSecret };
}

class CloudinaryService {
  isConfigured() {
    const { cloudName, apiKey, apiSecret } = readConfig();
    return !!(cloudName && apiKey && apiSecret);
  }

  /**
   * Signed-upload parameters. The API secret stays on the server; the app
   * uploads straight to Cloudinary with the returned signature.
   */
  getUploadSignature() {
    const { cloudName, apiKey, apiSecret } = readConfig();
    if (!cloudName || !apiKey || !apiSecret) {
      throw new AppError('Photo uploads are not configured yet', 503);
    }
    const timestamp = Math.floor(Date.now() / 1000);
    // Cloudinary signs the alphabetically sorted params followed by the secret.
    const toSign = `folder=${REVIEW_FOLDER}&timestamp=${timestamp}`;
    const signature = crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
    return { cloudName, apiKey, timestamp, folder: REVIEW_FOLDER, signature };
  }

  /**
   * Only accept images that really live in our Cloudinary review folder, so a
   * review can't point at arbitrary third-party URLs.
   */
  sanitizeImages(images) {
    if (images === undefined || images === null) return [];
    if (!Array.isArray(images) || images.length > 4) {
      throw new AppError('You can attach up to 4 photos', 400);
    }
    const { cloudName } = readConfig();
    if (!cloudName) throw new AppError('Photo uploads are not configured yet', 503);

    const prefix = `https://res.cloudinary.com/${cloudName}/image/upload/`;
    return images.map((img) => {
      const url = String(img?.url || '');
      const publicId = String(img?.publicId || '');
      if (!url.startsWith(prefix) || !publicId.startsWith(`${REVIEW_FOLDER}/`) || !url.includes(publicId)) {
        throw new AppError('Invalid photo', 400);
      }
      return { url, publicId };
    });
  }
}

module.exports = new CloudinaryService();
