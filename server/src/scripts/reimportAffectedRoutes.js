// server/src/scripts/reimportAffectedRoutes.js
// One-off maintenance script: finds routes whose static data was corrupted
// by the old blank-branch_code dedup bug (multiple real branches sharing an
// unlabeled branch_code on one direction got collapsed into a single row),
// and re-imports just those routes with the fixed logic.
//
// Branch inference: the API only labels ONE direction's itineraries with a
// real branch_code (e.g. "A"/"B"); the return direction sends branch_code=""
// for every branch. We infer which blank itinerary belongs to which branch
// by matching its FIRST stop's coordinates against the LAST stop's
// coordinates of a labeled itinerary — loop terminals reuse the same
// physical location but often have a DIFFERENT global_stop_id depending on
// direction of travel, so we match by proximity, not exact stop ID.
import 'dotenv/config';
import { pool, query } from '../db/pool.js';
import { transitGet } from '../lib/transitClient.js';

const API_DELAY_MS = 13_000; // 13 seconds between route_details calls (5 req/min safe)
const MATCH_RADIUS_METERS = 100; // loop terminals: same physical spot, different stop_id

// ── Geo helper ────────────────────────────────────────────────

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── Upsert helpers (same as staticImport.js) ─────────────────

async function upsertStop(stop) {
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
      stop.stop_lon,
      stop.stop_lat,
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
  await query(`DELETE FROM route_stops WHERE itinerary_id = $1`, [itineraryId]);
  for (let i = 0; i < stops.length; i++) {
    await query(
      `INSERT INTO route_stops (itinerary_id, stop_sequence, global_stop_id)
       VALUES ($1, $2, $3)`,
      [itineraryId, i + 1, stops[i].global_stop_id],
    );
  }
}

// ── Fixed import logic (handles blank branch_code collisions) ──

async function importRouteDetailsFixed(globalRouteId) {
  const data = await transitGet('/v4/public/route_details', {
    global_route_id: globalRouteId,
    stop_detailed: true,
  });

  const itineraries = data.itineraries || [];

  const labeled = itineraries.filter((it) => it.branch_code);
  const unlabeled = itineraries.filter((it) => !it.branch_code);

  // Dedup labeled itineraries by (direction_id, branch_code) — keep the
  // highest stop count (handles repeated live snapshots).
  const bestMap = new Map();
  for (const itin of labeled) {
    const key = `${itin.direction_id}::${itin.branch_code}`;
    const stopCount = itin.stops?.length ?? 0;
    const existing = bestMap.get(key);
    if (!existing || stopCount > (existing.stops?.length ?? 0)) {
      bestMap.set(key, itin);
    }
  }

  // Group unlabeled itineraries by first stop — a blank branch_code can hide
  // multiple genuinely distinct branches (loop routes returning via
  // different paths). Keep the highest stop-count version per group.
  const unlabeledGroups = new Map();
  for (const itin of unlabeled) {
    const stops = itin.stops || [];
    const firstStopId = stops[0]?.global_stop_id ?? '__no_stops__';
    const stopCount = stops.length;
    const existing = unlabeledGroups.get(firstStopId);
    if (!existing || stopCount > (existing.stops?.length ?? 0)) {
      unlabeledGroups.set(firstStopId, itin);
    }
  }

  // Build labeled terminals with COORDINATES (not stop_id) for proximity
  // matching, since the API can use a different global_stop_id for the
  // same physical loop location depending on travel direction.
  const labeledTerminals = [];
  for (const itin of bestMap.values()) {
    const stops = itin.stops || [];
    const last = stops[stops.length - 1];
    if (last && last.stop_lat != null && last.stop_lon != null) {
      labeledTerminals.push({
        lat: parseFloat(last.stop_lat),
        lon: parseFloat(last.stop_lon),
        branch_code: itin.branch_code,
      });
    }
  }

  function findNearestLabeledBranch(lat, lon) {
    let best = null;
    let bestDist = Infinity;
    for (const terminal of labeledTerminals) {
      const d = distanceMeters(lat, lon, terminal.lat, terminal.lon);
      if (d < bestDist) {
        bestDist = d;
        best = terminal.branch_code;
      }
    }
    return bestDist <= MATCH_RADIUS_METERS ? best : null;
  }

  let autoCounter = 1;
  for (const [firstStopId, itin] of unlabeledGroups.entries()) {
    const stops = itin.stops || [];
    const first = stops[0];
    const inferredBranch =
      first && first.stop_lat != null && first.stop_lon != null
        ? findNearestLabeledBranch(parseFloat(first.stop_lat), parseFloat(first.stop_lon))
        : null;
    const branchCode = inferredBranch || `auto${autoCounter++}`;
    itin.branch_code = branchCode;
    const key = `${itin.direction_id}::${branchCode}`;
    bestMap.set(key, itin);
  }

  // Clear existing itineraries for this route first, so a re-inferred
  // branch_code that differs from a previous run doesn't leave a stale
  // row behind (route_stops cascade-deletes with it).
  await query(`DELETE FROM itineraries WHERE global_route_id = $1`, [globalRouteId]);

  for (const itin of bestMap.values()) {
    const stops = itin.stops || [];
    for (const stop of stops) {
      await upsertStop(stop);
    }
    const itineraryId = await upsertItinerary(globalRouteId, itin);
    await replaceRouteStops(itineraryId, stops);
  }

  return bestMap.size; // itinerary count actually written
}

// ── Find affected routes directly from the DB ────────────────
// NOTE: this must run BEFORE any route in the list gets reimported, since
// reimporting a route can change its branch_code set (e.g. auto1 -> A),
// which would make it no longer match this query on a second pass.

async function findAffectedRoutes() {
  const result = await query(`
    SELECT DISTINCT global_route_id
    FROM itineraries
    WHERE global_route_id IN (
      SELECT global_route_id FROM itineraries WHERE branch_code = '' GROUP BY global_route_id
    )
    OR global_route_id IN (
      SELECT global_route_id FROM itineraries WHERE branch_code LIKE 'auto%' GROUP BY global_route_id
    )
    ORDER BY global_route_id
  `);
  return result.rows.map((r) => r.global_route_id);
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  const routeIds = await findAffectedRoutes();
  console.log(`Found ${routeIds.length} affected routes. Re-importing...`);

  let done = 0;
  let failed = 0;
  for (const globalRouteId of routeIds) {
    try {
      const itinCount = await importRouteDetailsFixed(globalRouteId);
      done++;
      console.log(
        `[${done}/${routeIds.length}] ${globalRouteId} -> ${itinCount} itineraries stored`,
      );
    } catch (err) {
      failed++;
      console.error(`Failed ${globalRouteId}:`, err.message);
    }
    if (done + failed < routeIds.length) {
      await new Promise((resolve) => setTimeout(resolve, API_DELAY_MS));
    }
  }

  console.log(`Done. ${done} succeeded, ${failed} failed out of ${routeIds.length}.`);
  await pool.end();
}

main().catch((err) => {
  console.error('Re-import failed:', err);
  process.exit(1);
});
