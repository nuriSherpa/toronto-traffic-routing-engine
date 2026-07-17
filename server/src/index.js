import 'dotenv/config';
import express from 'express';
import { healthRouter } from './routes/health.js';
import { liveRouter } from './routes/live.js';
import { apiRouter } from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*'); // allow all origins
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

app.get('/', (req, res) => {
  res.json({ name: 'transit-bunching-server', status: 'running' });
});

app.use(healthRouter);
app.use('/api/v1', apiRouter); // routes/stops/network endpoints, versioned
app.use(liveRouter);

// 404 for anything that fell through, then the central error handler.
// Must stay in this order, and errorHandler must be last.
app.use(notFoundHandler);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
