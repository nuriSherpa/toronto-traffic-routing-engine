// server/src/controllers/routesController.js
// Req/res only — no SQL, no caching. Delegates to services/routesService.js.
import { asyncHandler } from '../middleware/asyncHandler.js';
import { sendSuccess, ApiError } from '../utils/apiResponse.js';
import * as RoutesService from '../services/routesService.js';

export const getAllRoutes = asyncHandler(async (req, res) => {
  const routes = await RoutesService.listRoutes();
  sendSuccess(res, routes, { meta: { count: routes.length } });
});

export const getRouteStops = asyncHandler(async (req, res) => {
  const { routeId } = req.params;
  const direction = Number(req.query.direction ?? 0);
  if (![0, 1].includes(direction)) {
    throw new ApiError('direction must be 0 or 1', { status: 400, code: 'INVALID_DIRECTION' });
  }
  const stops = await RoutesService.getRouteStops(routeId, direction);
  sendSuccess(res, stops, { meta: { routeId, direction, count: stops.length } });
});

export const getRouteShape = asyncHandler(async (req, res) => {
  const { routeId } = req.params;
  const data = await RoutesService.getRouteShape(routeId);
  sendSuccess(res, data);
});

// Full route detail — every branch, both directions. Used for lazy
// click-to-load in the UI rather than being bundled into /network.
export const getRouteFull = asyncHandler(async (req, res) => {
  const { routeId } = req.params;
  const data = await RoutesService.getRouteFull(routeId);
  sendSuccess(res, data);
});

export const getNetwork = asyncHandler(async (req, res) => {
  const { route_type: routeTypeRaw } = req.query;
  const routeType = routeTypeRaw !== undefined ? Number(routeTypeRaw) : undefined;
  if (routeType !== undefined && Number.isNaN(routeType)) {
    throw new ApiError('route_type must be numeric', { status: 400, code: 'INVALID_ROUTE_TYPE' });
  }
  const data = await RoutesService.getNetwork(routeType);
  sendSuccess(res, data, { meta: { count: data.length } });
});
