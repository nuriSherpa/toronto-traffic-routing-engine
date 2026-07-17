// server/src/routes/tilesRouter.js
import { Router } from 'express';
import * as TilesController from '../controllers/tilesController.js';

export const tilesRouter = Router();

// GET /api/tiles/10/123/456.mvt
tilesRouter.get('/tiles/:z/:x/:y.mvt', TilesController.getTile);
