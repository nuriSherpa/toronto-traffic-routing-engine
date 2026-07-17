import { Router } from "express";
import { query } from "../db/pool.js";

export const liveRouter = Router();

// Latest known position per vehicle for a route (last 5 minutes of data).
liveRouter.get("/routes/:routeId/vehicles", async (req, res, next) => {
  const { routeId } = req.params;
  try {
    const result = await query(
      `SELECT DISTINCT ON (vehicle_id)
              vehicle_id, direction_id,
              ST_Y(location::geometry) AS lat,
              ST_X(location::geometry) AS lon,
              recorded_at
       FROM vehicle_snapshots
       WHERE global_route_id = $1
         AND recorded_at > now() - interval '5 minutes'
       ORDER BY vehicle_id, recorded_at DESC`,
      [routeId]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// Recent bunching events, optionally filtered by route.
liveRouter.get("/bunching-events", async (req, res, next) => {
  const { routeId, limit = 50 } = req.query;
  try {
    const params = [];
    let where = "";
    if (routeId) {
      params.push(routeId);
      where = `WHERE global_route_id = $${params.length}`;
    }
    params.push(Number(limit));

    const result = await query(
      `SELECT id, global_route_id, direction_id, vehicle_a, vehicle_b,
              gap_seconds, expected_gap_seconds,
              ST_Y(location::geometry) AS lat,
              ST_X(location::geometry) AS lon,
              detected_at
       FROM bunching_events
       ${where}
       ORDER BY detected_at DESC
       LIMIT $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});
