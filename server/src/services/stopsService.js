// server/src/services/stopsService.js
import { cached } from '../db/redis.js';
import * as StopsModel from '../models/stopsModel.js';
import { ApiError } from '../utils/apiResponse.js';

const STATIC_TTL_SECONDS = 60 * 60; // 1 hour

export async function listStops() {
  return cached('static:stops', STATIC_TTL_SECONDS, () => StopsModel.findAllStops());
}

// Nearby lookups aren't cached — they're keyed on arbitrary lat/lon pairs,
// so a cache would mostly miss and just add overhead.
export async function getNearbyStops({ lat, lon, limit }) {
  return StopsModel.findNearbyStops({ lat, lon, limit });
}

// Not cached either: per-stop detail is cheap and the routes-serving-stop
// join benefits from always being fresh right after a GTFS re-import.
export async function getStopDetail(stopId) {
  const stop = await StopsModel.findStopById(stopId);
  if (!stop) {
    throw new ApiError(`Stop '${stopId}' not found`, { status: 404, code: 'STOP_NOT_FOUND' });
  }
  const routes = await StopsModel.findRoutesServingStop(stopId);
  return { ...stop, routes };
}
