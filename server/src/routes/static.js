// server/src/routes/staticRouter.js
import { Router } from 'express';
import { query } from '../db/pool.js';
import { cached } from '../db/redis.js';

export const staticRouter = Router();

// Static data is long-lived, so we cache aggressively (1 hour).
const STATIC_TTL_SECONDS = 60 * 60; // 1 hour
const LONG_TTL_SECONDS = 6 * 60 * 60; // 6 hours for network shapes

// --------------------------------------------------------------------
// 1. All routes (simple list)
// --------------------------------------------------------------------
staticRouter.get('/routes', async (req, res, next) => {
  try {
    const data = await cached('static:routes', STATIC_TTL_SECONDS, async () => {
      const result = await query(
        `SELECT global_route_id, short_name, long_name, route_type, mode_name, color, text_color
         FROM routes
         ORDER BY sorting_key NULLS LAST, short_name`,
      );
      return result.rows;
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------------
// 2. Stops for a route's canonical itinerary in a given direction
// --------------------------------------------------------------------
staticRouter.get('/routes/:routeId/stops', async (req, res, next) => {
  const { routeId } = req.params;
  const { direction = 0 } = req.query;

  try {
    const cacheKey = `static:route:${routeId}:dir:${direction}:stops`;
    const data = await cached(cacheKey, STATIC_TTL_SECONDS, async () => {
      const result = await query(
        `SELECT s.global_stop_id, s.stop_name AS name,
                ST_Y(s.location::geometry) AS lat,
                ST_X(s.location::geometry) AS lon,
                s.parent_station, s.parent_station_name,
                s.wheelchair_boarding,
                rs.stop_sequence
         FROM itineraries i
         JOIN route_stops rs ON rs.itinerary_id = i.id
         JOIN stops s ON s.global_stop_id = rs.global_stop_id
         WHERE i.global_route_id = $1
           AND i.direction_id = $2
           AND i.canonical_itinerary = true
         ORDER BY rs.stop_sequence`,
        [routeId, direction],
      );
      return result.rows;
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------------
// 3. Closest stops to a point (KNN)
// --------------------------------------------------------------------
staticRouter.get('/stops/nearby', async (req, res, next) => {
  const { lat, lon, limit = 5 } = req.query;
  if (!lat || !lon) {
    return res.status(400).json({ error: 'lat and lon are required' });
  }

  try {
    const result = await query(
      `SELECT global_stop_id, stop_name AS name, route_type, wheelchair_boarding,
              ST_Y(location::geometry) AS lat,
              ST_X(location::geometry) AS lon,
              ST_Distance(location,
                          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS meters
       FROM stops
       WHERE location_type = 0
       ORDER BY location <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
       LIMIT $3`,
      [Number(lon), Number(lat), Number(limit)],
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------------
// 4. Full network – every route with its shape and ordered stops
//    Accepts optional ?route_type to filter (0=streetcar,1=subway,3=bus)
// --------------------------------------------------------------------
staticRouter.get('/network', async (req, res, next) => {
  const { route_type } = req.query;
  try {
    const cacheKey = `static:network:${route_type ?? 'all'}`;
    const data = await cached(cacheKey, LONG_TTL_SECONDS, async () => {
      let whereClause = '';
      const params = [];
      if (route_type !== undefined) {
        whereClause = 'WHERE r.route_type = $1';
        params.push(Number(route_type));
      }
      const result = await query(
        `SELECT
           r.global_route_id,
           r.short_name,
           r.long_name,
           r.color,
           r.text_color,
           r.route_type,
           r.mode_name,
           json_agg(
             json_build_object(
               'direction_id', i.direction_id,
               'headsign', i.headsign,
               'shape', ST_AsGeoJSON(i.shape::geometry)::json,
               'stops', (
                 SELECT json_agg(
                          json_build_object(
                            'global_stop_id', s.global_stop_id,
                            'name', s.stop_name,
                            'lat', ST_Y(s.location::geometry),
                            'lon', ST_X(s.location::geometry),
                            'sequence', rs.stop_sequence,
                            'parent_station', s.parent_station,
                            'parent_station_name', s.parent_station_name,
                            'wheelchair_boarding', s.wheelchair_boarding
                          ) ORDER BY rs.stop_sequence
                        )
                 FROM route_stops rs
                 JOIN stops s ON s.global_stop_id = rs.global_stop_id
                 WHERE rs.itinerary_id = i.id
               )
             ) ORDER BY i.direction_id
           ) AS itineraries
         FROM routes r
         JOIN itineraries i
           ON i.global_route_id = r.global_route_id
          AND i.canonical_itinerary = true
         ${whereClause}
         GROUP BY r.global_route_id, r.short_name, r.long_name,
                  r.color, r.text_color, r.route_type, r.mode_name, r.sorting_key
         ORDER BY r.sorting_key NULLS LAST, r.short_name`,
        params,
      );
      return result.rows;
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------------
// 5. (Optional) Flat list of all stops for search / clustering
// --------------------------------------------------------------------
staticRouter.get('/stops', async (req, res, next) => {
  try {
    const data = await cached('static:stops', STATIC_TTL_SECONDS, async () => {
      const result = await query(
        `SELECT global_stop_id, stop_name AS name, stop_code, city_name,
                ST_Y(location::geometry) AS lat,
                ST_X(location::geometry) AS lon,
                location_type, wheelchair_boarding,
                parent_station, parent_station_name
         FROM stops
         WHERE location_type = 0
         ORDER BY stop_name`,
      );
      return result.rows;
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------------
// 6. (Optional) Single route's full geometry and stops for map
// --------------------------------------------------------------------
staticRouter.get('/routes/:routeId/shape', async (req, res, next) => {
  const { routeId } = req.params;
  try {
    const cacheKey = `static:route:shape:${routeId}`;
    const data = await cached(cacheKey, LONG_TTL_SECONDS, async () => {
      const result = await query(
        `SELECT
           r.global_route_id, r.short_name, r.long_name, r.color, r.text_color,
           json_agg(
             json_build_object(
               'direction_id', i.direction_id,
               'headsign', i.headsign,
               'shape', ST_AsGeoJSON(i.shape::geometry)::json,
               'stops', (
                 SELECT json_agg(
                          json_build_object(
                            'global_stop_id', s.global_stop_id,
                            'name', s.stop_name,
                            'lat', ST_Y(s.location::geometry),
                            'lon', ST_X(s.location::geometry),
                            'sequence', rs.stop_sequence,
                            'parent_station', s.parent_station,
                            'parent_station_name', s.parent_station_name,
                            'wheelchair_boarding', s.wheelchair_boarding
                          ) ORDER BY rs.stop_sequence
                        )
                 FROM route_stops rs
                 JOIN stops s ON s.global_stop_id = rs.global_stop_id
                 WHERE rs.itinerary_id = i.id
               )
             ) ORDER BY i.direction_id
           ) AS itineraries
         FROM routes r
         JOIN itineraries i ON i.global_route_id = r.global_route_id
                           AND i.canonical_itinerary = true
         WHERE r.global_route_id = $1
         GROUP BY r.global_route_id, r.short_name, r.long_name, r.color, r.text_color`,
        [routeId],
      );
      return result.rows[0]; // single object, not array
    });
    if (!data) {
      return res.status(404).json({ error: 'Route not found' });
    }
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------------
// 7. Full route detail on demand — ALL itineraries (every branch, both
//    directions), not just canonical. Used for lazy click-to-load in the UI.
// --------------------------------------------------------------------
staticRouter.get('/routes/:routeId/full', async (req, res, next) => {
  const { routeId } = req.params;
  try {
    const cacheKey = `static:route:full:${routeId}`;
    const data = await cached(cacheKey, LONG_TTL_SECONDS, async () => {
      const result = await query(
        `SELECT
           r.global_route_id, r.short_name, r.long_name, r.color, r.text_color,
           r.route_type, r.mode_name,
           json_agg(
             json_build_object(
               'direction_id', i.direction_id,
               'branch_code', i.branch_code,
               'headsign', i.headsign,
               'direction_headsign', i.direction_headsign,
               'canonical_itinerary', i.canonical_itinerary,
               'shape', ST_AsGeoJSON(i.shape::geometry)::json,
               'stops', (
                 SELECT json_agg(
                          json_build_object(
                            'global_stop_id', s.global_stop_id,
                            'name', s.stop_name,
                            'lat', ST_Y(s.location::geometry),
                            'lon', ST_X(s.location::geometry),
                            'sequence', rs.stop_sequence,
                            'parent_station', s.parent_station,
                            'parent_station_name', s.parent_station_name,
                            'wheelchair_boarding', s.wheelchair_boarding
                          ) ORDER BY rs.stop_sequence
                        )
                 FROM route_stops rs
                 JOIN stops s ON s.global_stop_id = rs.global_stop_id
                 WHERE rs.itinerary_id = i.id
               )
             ) ORDER BY i.direction_id, i.branch_code
           ) AS itineraries
         FROM routes r
         JOIN itineraries i ON i.global_route_id = r.global_route_id
         WHERE r.global_route_id = $1
         GROUP BY r.global_route_id, r.short_name, r.long_name,
                  r.color, r.text_color, r.route_type, r.mode_name`,
        [routeId],
      );
      return result.rows[0];
    });
    if (!data) {
      return res.status(404).json({ error: 'Route not found' });
    }
    res.json(data);
  } catch (err) {
    next(err);
  }
});
