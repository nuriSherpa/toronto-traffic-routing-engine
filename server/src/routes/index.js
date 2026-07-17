// server/src/routes/index.js
import { Router } from 'express';
import { routesRouter } from './routesRouter.js';
import { stopsRouter } from './stopsRouter.js';
import { tilesRouter } from './tilesRouter.js'; // ← new

export const apiRouter = Router();

apiRouter.use(routesRouter);
apiRouter.use(stopsRouter);
apiRouter.use(tilesRouter); // ← mount it
