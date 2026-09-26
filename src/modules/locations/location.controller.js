const PhotonService = require('../../integrations/photon/photon.service');
const ApiResponse = require('../../common/utils/api-response');
const asyncHandler = require('../../common/utils/async-handler');
const AppError = require('../../common/errors/app-error');

class LocationController {
  constructor() {
    this.service = new PhotonService();
  }

  autocomplete = asyncHandler(async (req, res) => {
    const { q, lat, lon } = req.query;
    // Validate input length to prevent abuse and SSRF-like proxy requests.
    if (!q || typeof q !== 'string' || q.trim().length === 0 || q.length > 200) {
      throw new AppError('A valid search query is required (max 200 characters)', 400);
    }
    const predictions = await this.service.autocomplete(q.trim(), lat, lon);
    return ApiResponse.success(res, { predictions });
  });

  reverse = asyncHandler(async (req, res) => {
    const { lat, lon } = req.query;
    if (!lat || !lon || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
      throw new AppError('Valid lat and lon are required', 400);
    }
    const location = await this.service.reverseGeocode(lat, lon);
    return ApiResponse.success(res, { location });
  });
}

module.exports = LocationController;
