// server/src/services/routesService.js
// Business logic + caching, sitting between controllers and the model.
// Controllers should never import routesModel.js directly.
import { cached } from '../db/redis.js';
import * as RoutesModel from '../models/routesModel.js';
import { ApiError } from '../utils/apiResponse.js';

const STATIC_TTL_SECONDS = 60 * 60; // 1 hour — routes/stops rarely change
const LONG_TTL_SECONDS = 6 * 60 * 60; // 6 hours — shapes/network are heavier payloads

export async function listRoutes() {
  return cached('static:routes', STATIC_TTL_SECONDS, () => RoutesModel.findAllRoutes());
}

export async function getRouteStops(routeId, directionId) {
  const cacheKey = `static:route:${routeId}:dir:${directionId}:stops`;
  return cached(cacheKey, STATIC_TTL_SECONDS, () =>
    RoutesModel.findRouteCanonicalStops(routeId, directionId),
  );
}

export async function getRouteShape(routeId) {
  const cacheKey = `static:route:shape:${routeId}`;
  const data = await cached(cacheKey, LONG_TTL_SECONDS, () => RoutesModel.findRouteShape(routeId));
  if (!data) {
    throw new ApiError(`Route '${routeId}' not found`, { status: 404, code: 'ROUTE_NOT_FOUND' });
  }
  return data;
}

export async function getRouteFull(routeId) {
  const cacheKey = `static:route:full:${routeId}`;
  const data = await cached(cacheKey, LONG_TTL_SECONDS, () => RoutesModel.findRouteFull(routeId));
  if (!data) {
    throw new ApiError(`Route '${routeId}' not found`, { status: 404, code: 'ROUTE_NOT_FOUND' });
  }
  return data;
}

export async function getNetwork(routeType) {
  const cacheKey = `static:network:${routeType ?? 'all'}`;
  return cached(cacheKey, LONG_TTL_SECONDS, () => RoutesModel.findNetwork({ routeType }));
}
