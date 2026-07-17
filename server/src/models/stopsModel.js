// server/src/models/stopsModel.js
import { query } from '../db/pool.js';

export async function findAllStops() {
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
}

export async function findStopById(stopId) {
  const result = await query(
    `SELECT global_stop_id, stop_name AS name, stop_code, tts_name, city_name,
            ST_Y(location::geometry) AS lat,
            ST_X(location::geometry) AS lon,
            location_type, wheelchair_boarding,
            parent_station, parent_station_name, level_id
     FROM stops
     WHERE global_stop_id = $1`,
    [stopId],
  );
  return result.rows[0] ?? null;
}

export async function findNearbyStops({ lat, lon, limit }) {
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
    [lon, lat, limit],
  );
  return result.rows;
}

// Routes that serve a given stop — used to enrich a stop detail page
// ("what lines stop here").
export async function findRoutesServingStop(stopId) {
  const result = await query(
    `SELECT DISTINCT r.global_route_id, r.short_name, r.long_name,
            r.route_type, r.mode_name, r.color, r.text_color
     FROM route_stops rs
     JOIN itineraries i ON i.id = rs.itinerary_id
     JOIN routes r ON r.global_route_id = i.global_route_id
     WHERE rs.global_stop_id = $1
     ORDER BY r.sorting_key NULLS LAST, r.short_name`,
    [stopId],
  );
  return result.rows;
}
