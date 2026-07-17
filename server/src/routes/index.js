// server/src/routes/index.js
// Single entry point mounted in src/index.js as:
//   app.use('/api', apiRouter);
import { Router } from 'express';
import { routesRouter } from './routesRouter.js';
import { stopsRouter } from './stopsRouter.js';

export const apiRouter = Router();

apiRouter.use(routesRouter);
apiRouter.use(stopsRouter);
