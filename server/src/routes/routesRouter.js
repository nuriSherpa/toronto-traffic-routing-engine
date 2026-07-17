// server/src/routes/routesRouter.js
import { Router } from 'express';
import * as RoutesController from '../controllers/routesController.js';

export const routesRouter = Router();

routesRouter.get('/routes', RoutesController.getAllRoutes);
routesRouter.get('/routes/:routeId/stops', RoutesController.getRouteStops);
routesRouter.get('/routes/:routeId/shape', RoutesController.getRouteShape);
routesRouter.get('/routes/:routeId/full', RoutesController.getRouteFull);
routesRouter.get('/network', RoutesController.getNetwork);
