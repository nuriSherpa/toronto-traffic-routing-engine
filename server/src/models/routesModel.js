// server/src/models/routesModel.js
// Raw SQL access for routes/itineraries. No caching and no HTTP concerns
// here on purpose — that lives in services/ and controllers/ respectively.
import { query } from '../db/pool.js';

export async function findAllRoutes() {
  const result = await query(
    `SELECT global_route_id, short_name, long_name, route_type, mode_name, color, text_color
     FROM routes
     ORDER BY sorting_key NULLS LAST, short_name`,
  );
  return result.rows;
}

export async function findRouteCanonicalStops(routeId, directionId) {
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
    [routeId, directionId],
  );
  return result.rows;
}

// Shared subquery for building a full stop list (with lat/lon + accessibility
// info) for a single itinerary. Reused by findRouteShape/findRouteFull/findNetwork
// so the JSON shape stays identical everywhere the frontend consumes it.
const ITINERARY_STOPS_SUBQUERY = `
  (
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
`;

export async function findRouteShape(routeId) {
  const result = await query(
    `SELECT
       r.global_route_id, r.short_name, r.long_name, r.color, r.text_color,
       json_agg(
         json_build_object(
           'direction_id', i.direction_id,
           'headsign', i.headsign,
           'shape', ST_AsGeoJSON(i.shape::geometry)::json,
           'stops', ${ITINERARY_STOPS_SUBQUERY}
         ) ORDER BY i.direction_id
       ) AS itineraries
     FROM routes r
     JOIN itineraries i ON i.global_route_id = r.global_route_id
                       AND i.canonical_itinerary = true
     WHERE r.global_route_id = $1
     GROUP BY r.global_route_id, r.short_name, r.long_name, r.color, r.text_color`,
    [routeId],
  );
  return result.rows[0] ?? null;
}

// Every itinerary (all branches, both directions) — not just canonical.
// Used for lazy click-to-load route detail in the UI.
export async function findRouteFull(routeId) {
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
           'stops', ${ITINERARY_STOPS_SUBQUERY}
         ) ORDER BY i.direction_id, i.branch_code
       ) AS itineraries
     FROM routes r
     JOIN itineraries i ON i.global_route_id = r.global_route_id
     WHERE r.global_route_id = $1
     GROUP BY r.global_route_id, r.short_name, r.long_name,
              r.color, r.text_color, r.route_type, r.mode_name`,
    [routeId],
  );
  return result.rows[0] ?? null;
}

export async function findNetwork({ routeType } = {}) {
  const params = [];
  let whereClause = '';
  if (routeType !== undefined) {
    whereClause = 'WHERE r.route_type = $1';
    params.push(routeType);
  }
  const result = await query(
    `SELECT
       r.global_route_id, r.short_name, r.long_name, r.color, r.text_color,
       r.route_type, r.mode_name,
       json_agg(
         json_build_object(
           'direction_id', i.direction_id,
           'headsign', i.headsign,
           'shape', ST_AsGeoJSON(i.shape::geometry)::json,
           'stops', ${ITINERARY_STOPS_SUBQUERY}
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
}
