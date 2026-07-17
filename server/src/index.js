import 'dotenv/config';
import express from 'express';
import { healthRouter } from './routes/health.js';
import { staticRouter } from './routes/static.js';
import { liveRouter } from './routes/live.js';

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
app.use(staticRouter);
app.use(liveRouter);

// Basic error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_server_error' });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
