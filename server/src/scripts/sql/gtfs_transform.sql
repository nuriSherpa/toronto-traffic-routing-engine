-- ---------- Final schema tables (create if this is the first run) ----------

CREATE TABLE IF NOT EXISTS gtfs_feed_versions (
  feed_version    TEXT PRIMARY KEY,
  feed_start_date DATE NOT NULL,
  feed_end_date   DATE NOT NULL,
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gtfs_calendar (
  service_id TEXT PRIMARY KEY,
  monday BOOLEAN, tuesday BOOLEAN, wednesday BOOLEAN, thursday BOOLEAN,
  friday BOOLEAN, saturday BOOLEAN, sunday BOOLEAN,
  start_date DATE, end_date DATE
);
CREATE TABLE IF NOT EXISTS gtfs_calendar_dates (
  service_id TEXT NOT NULL,
  date DATE NOT NULL,
  exception_type SMALLINT NOT NULL,
  PRIMARY KEY (service_id, date)
);
CREATE TABLE IF NOT EXISTS gtfs_levels (
  level_id    TEXT PRIMARY KEY,
  level_index NUMERIC,
  level_name  TEXT
);

CREATE TABLE IF NOT EXISTS gtfs_trips (
  trip_id       TEXT PRIMARY KEY,
  global_route_id TEXT NOT NULL,
  service_id    TEXT NOT NULL,
  trip_headsign TEXT,
  direction_id  SMALLINT,
  shape_id      TEXT,
  block_id      TEXT,
  branch_code   TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS gtfs_stop_times (
  trip_id        TEXT NOT NULL,
  stop_sequence  INT NOT NULL,
  global_stop_id TEXT NOT NULL,
  arrival_time   TEXT,
  departure_time TEXT,
  PRIMARY KEY (trip_id, stop_sequence)
);
CREATE TABLE IF NOT EXISTS gtfs_pathways (
  pathway_id             TEXT PRIMARY KEY,
  from_stop_id           TEXT NOT NULL,
  to_stop_id             TEXT NOT NULL,
  pathway_mode           SMALLINT,
  is_bidirectional       BOOLEAN,
  length_m               NUMERIC,
  traversal_time_sec     INT,
  stair_count            INT,
  max_slope              NUMERIC,
  min_width              NUMERIC,
  signposted_as          TEXT,
  reversed_signposted_as TEXT
);

ALTER TABLE stops ADD COLUMN IF NOT EXISTS level_id TEXT;

-- Generic nodes (location_type = 3) and some other pathway-only stop rows
-- are allowed by the GTFS spec to omit stop_lat/stop_lon (e.g. TTC's
-- indoor stairway/walkway nodes). That means `location` can legitimately
-- be null for those rows, so the column can no longer be NOT NULL.
ALTER TABLE stops ALTER COLUMN location DROP NOT NULL;

-- ---------- Wipe final tables for a clean rebuild ----------
-- Safe for now: no live data references routes/itineraries yet.
-- IMPORTANT: once GTFS-RT / vehicle_positions is wired up, this
-- TRUNCATE CASCADE must become an upsert strategy instead.

TRUNCATE route_stops, itineraries, stops, routes,
         gtfs_trips, gtfs_stop_times, gtfs_pathways,
         gtfs_calendar, gtfs_calendar_dates, gtfs_levels
  CASCADE;

-- ---------- Feed version bookkeeping ----------

INSERT INTO gtfs_feed_versions (feed_version, feed_start_date, feed_end_date)
SELECT feed_version, to_date(feed_start_date, 'YYYYMMDD'), to_date(feed_end_date, 'YYYYMMDD')
FROM gtfs_feed_info_staging
ON CONFLICT (feed_version) DO UPDATE SET imported_at = now();

-- ---------- Network + levels ----------

INSERT INTO networks (network_id, network_name)
VALUES ('TTC|Toronto', 'TTC')
ON CONFLICT (network_id) DO NOTHING;

INSERT INTO gtfs_levels (level_id, level_index, level_name)
SELECT level_id, level_index, level_name FROM gtfs_levels_staging;

-- ---------- Calendar ----------

INSERT INTO gtfs_calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
SELECT service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday,
       to_date(start_date, 'YYYYMMDD'), to_date(end_date, 'YYYYMMDD')
FROM gtfs_calendar_staging;

INSERT INTO gtfs_calendar_dates (service_id, date, exception_type)
SELECT service_id, to_date(date, 'YYYYMMDD'), exception_type
FROM gtfs_calendar_dates_staging;

-- ---------- Routes ----------

INSERT INTO routes (
  global_route_id, network_id, short_name, long_name, route_type,
  mode_name, color, text_color
)
SELECT
  'TTC:' || route_id,
  'TTC|Toronto',
  route_short_name,
  route_long_name,
  route_type,
  CASE route_type
    WHEN 0 THEN 'Streetcar'
    WHEN 1 THEN 'Subway'
    WHEN 3 THEN 'Bus'
    ELSE 'Other'
  END,
  route_color,
  route_text_color
FROM gtfs_routes_staging;

-- ---------- Stops ----------

INSERT INTO stops (
  global_stop_id, stop_code, stop_name, tts_name, city_name,
  location, location_type, wheelchair_boarding, parent_station,
  parent_station_name, level_id
)
SELECT
  'TTC:' || s.stop_id,
  s.stop_code,
  s.stop_name,
  s.tts_stop_name,
  'Toronto',
  CASE
    WHEN s.stop_lat IS NOT NULL AND s.stop_lon IS NOT NULL
    THEN ST_SetSRID(ST_MakePoint(s.stop_lon, s.stop_lat), 4326)::geography
    ELSE NULL
  END,
  s.location_type,
  s.wheelchair_boarding,
  CASE WHEN s.parent_station IS NOT NULL AND s.parent_station <> ''
       THEN 'TTC:' || s.parent_station ELSE NULL END,
  parent.stop_name,
  s.level_id
FROM gtfs_stops_staging s
LEFT JOIN gtfs_stops_staging parent ON parent.stop_id = s.parent_station;

-- ---------- Branch resolution ----------

CREATE TEMP TABLE trip_branch_pass1 AS
SELECT
  t.trip_id, t.route_id, t.direction_id, t.shape_id, t.trip_headsign,
  (regexp_match(
     t.trip_headsign,
     regexp_replace(r.route_short_name, '([.^$|()\[\]{}*+?\\])', '\\\1', 'g') || '([A-Z])'
   ))[1] AS branch_letter
FROM gtfs_trips_staging t
JOIN gtfs_routes_staging r ON r.route_id = t.route_id;

CREATE TEMP TABLE shape_endpoints AS
SELECT
  shape_id,
  (array_agg(shape_pt_lat ORDER BY shape_pt_sequence ASC))[1] AS start_lat,
  (array_agg(shape_pt_lon ORDER BY shape_pt_sequence ASC))[1] AS start_lon,
  (array_agg(shape_pt_lat ORDER BY shape_pt_sequence DESC))[1] AS end_lat,
  (array_agg(shape_pt_lon ORDER BY shape_pt_sequence DESC))[1] AS end_lon
FROM gtfs_shapes_staging
GROUP BY shape_id;

CREATE TEMP TABLE labeled_shapes AS
SELECT DISTINCT ON (shape_id) shape_id, branch_letter, route_id
FROM trip_branch_pass1
WHERE branch_letter IS NOT NULL;

CREATE TEMP TABLE shape_branch_resolved AS
SELECT
  u.shape_id,
  u.route_id,
  COALESCE(
    (
      SELECT ls.branch_letter
      FROM labeled_shapes ls
      JOIN shape_endpoints le ON le.shape_id = ls.shape_id
      JOIN shape_endpoints ue ON ue.shape_id = u.shape_id
      WHERE ls.route_id = u.route_id
      ORDER BY ST_Distance(
        ST_SetSRID(ST_MakePoint(le.end_lon, le.end_lat), 4326)::geography,
        ST_SetSRID(ST_MakePoint(ue.start_lon, ue.start_lat), 4326)::geography
      ) ASC
      LIMIT 1
    ),
    ''
  ) AS branch_letter
FROM (SELECT DISTINCT shape_id, route_id FROM trip_branch_pass1 WHERE branch_letter IS NULL) u;

CREATE TEMP TABLE shape_branch_final AS
SELECT shape_id, route_id, branch_letter FROM labeled_shapes
UNION ALL
SELECT shape_id, route_id, branch_letter FROM shape_branch_resolved;

-- ---------- gtfs_trips ----------

INSERT INTO gtfs_trips (trip_id, global_route_id, service_id, trip_headsign, direction_id, shape_id, block_id, branch_code)
SELECT
  t.trip_id,
  'TTC:' || t.route_id,
  t.service_id,
  t.trip_headsign,
  t.direction_id,
  t.shape_id,
  t.block_id,
  COALESCE(sbf.branch_letter, '')
FROM gtfs_trips_staging t
LEFT JOIN shape_branch_final sbf ON sbf.shape_id = t.shape_id AND sbf.route_id = t.route_id;

-- ---------- gtfs_stop_times ----------

INSERT INTO gtfs_stop_times (trip_id, stop_sequence, global_stop_id, arrival_time, departure_time)
SELECT trip_id, stop_sequence, 'TTC:' || stop_id, arrival_time, departure_time
FROM gtfs_stop_times_staging;

-- ---------- gtfs_pathways ----------

INSERT INTO gtfs_pathways (
  pathway_id, from_stop_id, to_stop_id, pathway_mode, is_bidirectional,
  length_m, traversal_time_sec, stair_count, max_slope, min_width,
  signposted_as, reversed_signposted_as
)
SELECT
  pathway_id, 'TTC:' || from_stop_id, 'TTC:' || to_stop_id, pathway_mode,
  is_bidirectional = 1, length, traversal_time, stair_count, max_slope, min_width,
  signposted_as, reversed_signposted_as
FROM gtfs_pathways_staging;

-- ---------- itineraries + route_stops ----------

CREATE TEMP TABLE itinerary_groups AS
SELECT
  gt.global_route_id,
  gt.direction_id,
  gt.branch_code,
  gt.shape_id,
  gt.trip_headsign,
  gt.trip_id,
  count(*) OVER (PARTITION BY gt.global_route_id, gt.direction_id, gt.branch_code, gt.shape_id) AS shape_freq
FROM gtfs_trips gt;

CREATE TEMP TABLE representative_trip AS
SELECT DISTINCT ON (global_route_id, direction_id, branch_code)
  global_route_id, direction_id, branch_code, shape_id, trip_headsign, trip_id
FROM itinerary_groups
ORDER BY global_route_id, direction_id, branch_code, shape_freq DESC, trip_id;

INSERT INTO itineraries (global_route_id, direction_id, branch_code, headsign, canonical_itinerary, shape)
SELECT
  rt.global_route_id,
  rt.direction_id,
  rt.branch_code,
  rt.trip_headsign,
  true,
  ST_SetSRID(
    ST_MakeLine(
      ARRAY(
        SELECT ST_MakePoint(shape_pt_lon, shape_pt_lat)
        FROM gtfs_shapes_staging
        WHERE shape_id = rt.shape_id
        ORDER BY shape_pt_sequence
      )
    ), 4326
  )::geography
FROM representative_trip rt;

INSERT INTO route_stops (itinerary_id, stop_sequence, global_stop_id)
SELECT
  i.id,
  st.stop_sequence,
  st.global_stop_id
FROM representative_trip rt
JOIN itineraries i
  ON i.global_route_id = rt.global_route_id
 AND i.direction_id = rt.direction_id
 AND i.branch_code = rt.branch_code
JOIN gtfs_stop_times st ON st.trip_id = rt.trip_id
ORDER BY st.stop_sequence;