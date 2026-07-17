// server/src/routes/stopsRouter.js
import { Router } from 'express';
import * as StopsController from '../controllers/stopsController.js';

export const stopsRouter = Router();

// IMPORTANT: /stops/nearby must be registered before /stops/:stopId,
// otherwise Express matches "nearby" as a :stopId param and getStopDetail
// runs instead of getNearbyStops.
stopsRouter.get('/stops/nearby', StopsController.getNearbyStops);
stopsRouter.get('/stops', StopsController.getAllStops);
stopsRouter.get('/stops/:stopId', StopsController.getStopDetail);
