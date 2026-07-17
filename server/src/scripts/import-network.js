// staticImport.js
import 'dotenv/config';
import { pool, query } from '../db/pool.js';
import { transitGet } from '../lib/transitClient.js';

// ── Config ──────────────────────────────────────────────────
const TORONTO_LAT = 43.6532;
const TORONTO_LON = -79.3832;
const API_DELAY_MS = 13_000; // 13 seconds between route_details calls (5 req/min safe)

// ── Upsert helpers ──────────────────────────────────────────

async function upsertNetwork(network) {
  await query(
    `INSERT INTO networks (network_id, network_name)
     VALUES ($1, $2)
     ON CONFLICT (network_id) DO UPDATE SET network_name = EXCLUDED.network_name`,
    [network.network_id, network.network_name],
  );
}

async function upsertRoute(route, networkId) {
  await query(
    `INSERT INTO routes (
       global_route_id, network_id, short_name, long_name, route_type,
       mode_name, color, text_color, sorting_key, tts_short_name,
       tts_long_name, route_timezone
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (global_route_id) DO UPDATE SET
       network_id     = EXCLUDED.network_id,
       short_name     = EXCLUDED.short_name,
       long_name      = EXCLUDED.long_name,
       route_type     = EXCLUDED.route_type,
       mode_name      = EXCLUDED.mode_name,
       color          = EXCLUDED.color,
       text_color     = EXCLUDED.text_color,
       sorting_key    = EXCLUDED.sorting_key,
       tts_short_name = EXCLUDED.tts_short_name,
       tts_long_name  = EXCLUDED.tts_long_name,
       route_timezone = EXCLUDED.route_timezone`,
    [
      route.global_route_id,
      networkId,
      route.route_short_name ?? null,
      route.route_long_name ?? null,
      route.route_type,
      route.mode_name ?? null,
      route.route_color ?? null,
      route.route_text_color ?? null,
      route.sorting_key ?? null,
      route.tts_short_name ?? null,
      route.tts_long_name ?? null,
      route.route_timezone ?? null,
    ],
  );
}

async function upsertStop(stop) {
  // parent_station is an object with global_stop_id and station_name
  const parentStationId = stop.parent_station?.global_stop_id ?? null;
  const parentStationName = stop.parent_station?.station_name ?? null;

  await query(
    `INSERT INTO stops (
       global_stop_id, stop_code, stop_name, tts_name, city_name,
       location, location_type, wheelchair_boarding, route_type,
       parent_station, parent_station_name
     )
     VALUES (
       $1, $2, $3, $4, $5,
       ST_SetSRID(ST_MakePoint($6, $7), 4326)::geography,
       $8, $9, $10, $11, $12
     )
     ON CONFLICT (global_stop_id) DO UPDATE SET
       stop_code           = EXCLUDED.stop_code,
       stop_name           = EXCLUDED.stop_name,
       tts_name            = EXCLUDED.tts_name,
       city_name           = EXCLUDED.city_name,
       location            = EXCLUDED.location,
       location_type       = EXCLUDED.location_type,
       wheelchair_boarding = EXCLUDED.wheelchair_boarding,
       route_type          = EXCLUDED.route_type,
       parent_station      = EXCLUDED.parent_station,
       parent_station_name = EXCLUDED.parent_station_name`,
    [
      stop.global_stop_id,
      stop.stop_code ?? null,
      stop.stop_name,
      stop.tts_stop_name ?? null,
      stop.city_name ?? null,
      stop.stop_lon, // longitude first for PostGIS
      stop.stop_lat, // latitude second
      stop.location_type ?? null,
      stop.wheelchair_boarding ?? null,
      stop.route_type ?? null,
      parentStationId,
      parentStationName,
    ],
  );
}

async function upsertItinerary(globalRouteId, itinerary) {
  const branchCode = itinerary.branch_code ?? '';

  // shape is an encoded polyline string (or null)
  const shapeValue = itinerary.shape ?? null;

  const result = await query(
    `INSERT INTO itineraries (
       global_route_id, direction_id, branch_code, headsign,
       direction_headsign, canonical_itinerary, shape
     )
     VALUES (
       $1, $2, $3, $4, $5, $6,
       CASE WHEN $7::text IS NULL OR $7 = ''
         THEN NULL
         ELSE ST_SetSRID(ST_LineFromEncodedPolyline($7), 4326)::geography
       END
     )
     ON CONFLICT (global_route_id, direction_id, branch_code) DO UPDATE SET
       headsign             = EXCLUDED.headsign,
       direction_headsign   = EXCLUDED.direction_headsign,
       canonical_itinerary  = EXCLUDED.canonical_itinerary,
       shape                = EXCLUDED.shape
     RETURNING id`,
    [
      globalRouteId,
      itinerary.direction_id,
      branchCode,
      itinerary.headsign ?? null,
      itinerary.direction_headsign ?? null,
      itinerary.canonical_itinerary ?? false,
      shapeValue,
    ],
  );
  return result.rows[0].id;
}

async function replaceRouteStops(itineraryId, stops) {
  // Delete old sequence and re-insert
  await query(`DELETE FROM route_stops WHERE itinerary_id = $1`, [itineraryId]);

  // Batch insert for performance (but here we keep simple)
  for (let i = 0; i < stops.length; i++) {
    await query(
      `INSERT INTO route_stops (itinerary_id, stop_sequence, global_stop_id)
       VALUES ($1, $2, $3)`,
      [itineraryId, i + 1, stops[i].global_stop_id],
    );
  }
}

// ── Core import functions ───────────────────────────────────

async function findTtcNetwork() {
  console.log('Looking up available networks near Toronto...');
  const data = await transitGet('/v4/public/available_networks', {
    lat: TORONTO_LAT,
    lon: TORONTO_LON,
    country_code: 'CA',
    include_network_geometry: false,
  });
  const networks = data.networks || [];
  const ttc = networks.find((n) => n.network_name?.toUpperCase().includes('TTC'));
  if (!ttc) {
    console.log(
      'Networks found:',
      networks.map((n) => `${n.network_id} (${n.network_name})`),
    );
    throw new Error('Could not find TTC network. Hardcode the correct network_id if needed.');
  }
  console.log(`Found TTC network: ${ttc.network_id}`);
  return ttc;
}

async function fetchRoutes(networkId) {
  console.log(`Fetching routes for network ${networkId}...`);
  const data = await transitGet('/v4/public/routes_for_networks', {
    network_ids: networkId,
    lat: TORONTO_LAT,
    lon: TORONTO_LON,
  });
  const routes = data.routes || [];
  console.log(`Got ${routes.length} routes.`);
  return routes;
}

async function importRouteDetails(route) {
  const data = await transitGet('/v4/public/route_details', {
    global_route_id: route.global_route_id,
    stop_detailed: true,
  });

  const itineraries = data.itineraries || [];

  // The API sometimes returns multiple itinerary objects for the same
  // (direction_id, branch_code) — keep only the one with the most stops
  // to avoid storing incomplete live snapshots.
  const bestMap = new Map();
  for (const itin of itineraries) {
    const key = `${itin.direction_id}::${itin.branch_code ?? ''}`;
    const stopCount = itin.stops?.length ?? 0;
    const existing = bestMap.get(key);
    if (!existing || stopCount > (existing.stops?.length ?? 0)) {
      bestMap.set(key, itin);
    }
  }

  for (const itin of bestMap.values()) {
    const stops = itin.stops || [];
    // Upsert all stops first
    for (const stop of stops) {
      await upsertStop(stop);
    }
    // Upsert the itinerary
    const itineraryId = await upsertItinerary(route.global_route_id, itin);
    // Replace the stop sequence
    await replaceRouteStops(itineraryId, stops);
  }
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  // 1) Network
  const ttc = await findTtcNetwork();
  await upsertNetwork(ttc);

  // 2) Routes
  const routes = await fetchRoutes(ttc.network_id);
  for (const route of routes) {
    await upsertRoute(route, ttc.network_id);
  }
  console.log(`Upserted ${routes.length} routes into DB.`);

  // 3) Route details (stops, itineraries, shapes, stop sequences)
  console.log('Fetching route_details for each route...');
  let done = 0;
  for (const route of routes) {
    try {
      await importRouteDetails(route);
      done++;
      console.log(`[${done}/${routes.length}] ${route.route_short_name || route.global_route_id}`);
    } catch (err) {
      console.error(`Failed ${route.global_route_id}:`, err.message);
    }
    // Respect rate limit – 5 req/min = 12s minimum, using 13s for safety
    if (done < routes.length) {
      await new Promise((resolve) => setTimeout(resolve, API_DELAY_MS));
    }
  }

  console.log('Static import complete.');
  await pool.end();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
