// server/src/controllers/stopsController.js
import { asyncHandler } from '../middleware/asyncHandler.js';
import { sendSuccess, ApiError } from '../utils/apiResponse.js';
import * as StopsService from '../services/stopsService.js';

export const getAllStops = asyncHandler(async (req, res) => {
  const stops = await StopsService.listStops();
  sendSuccess(res, stops, { meta: { count: stops.length } });
});

// Full station info for a single stop, including which routes serve it.
export const getStopDetail = asyncHandler(async (req, res) => {
  const { stopId } = req.params;
  const data = await StopsService.getStopDetail(stopId);
  sendSuccess(res, data);
});

export const getNearbyStops = asyncHandler(async (req, res) => {
  const { lat, lon, limit = 5 } = req.query;
  if (!lat || !lon) {
    throw new ApiError('lat and lon are required', { status: 400, code: 'MISSING_COORDS' });
  }
  const parsedLat = Number(lat);
  const parsedLon = Number(lon);
  const parsedLimit = Number(limit);
  if (Number.isNaN(parsedLat) || Number.isNaN(parsedLon)) {
    throw new ApiError('lat and lon must be numeric', { status: 400, code: 'INVALID_COORDS' });
  }
  const stops = await StopsService.getNearbyStops({
    lat: parsedLat,
    lon: parsedLon,
    limit: parsedLimit,
  });
  sendSuccess(res, stops, { meta: { count: stops.length } });
});
