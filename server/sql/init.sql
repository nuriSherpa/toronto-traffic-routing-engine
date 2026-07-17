-- =========================================================
-- Enable extensions
-- =========================================================
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";   -- optional, for generating UUIDs

-- =========================================================
-- STATIC DATA (sourced from GTFS static feed, refreshed ~every 6 weeks)
-- =========================================================

CREATE TABLE IF NOT EXISTS networks (
  network_id     TEXT PRIMARY KEY,          -- "TTC|Toronto"
  network_name   TEXT NOT NULL               -- "TTC"
);

CREATE TABLE IF NOT EXISTS routes (
  global_route_id TEXT PRIMARY KEY,          -- "TTC:1"
  network_id      TEXT NOT NULL REFERENCES networks(network_id),
  short_name      TEXT,                      -- "1", "504"
  long_name       TEXT,                      -- "Yonge-University"
  route_type      INT NOT NULL,              -- 0=tram,1=subway,3=bus
  mode_name       TEXT,                      -- "Subway", "Bus", "Streetcar"
  color           TEXT,
  text_color      TEXT,
  sorting_key     TEXT,
  tts_short_name  TEXT,
  tts_long_name   TEXT,
  route_timezone  TEXT
);
CREATE INDEX IF NOT EXISTS idx_routes_network ON routes (network_id);
CREATE INDEX IF NOT EXISTS idx_routes_type    ON routes (route_type);

-- gtfs_levels defined before stops, since stops.level_id references it
CREATE TABLE IF NOT EXISTS gtfs_levels (
  level_id    TEXT PRIMARY KEY,
  level_index NUMERIC,
  level_name  TEXT
);

CREATE TABLE IF NOT EXISTS stops (
  global_stop_id       TEXT PRIMARY KEY,       -- "TTC:94380"
  stop_code            TEXT,                   -- pole number
  stop_name            TEXT NOT NULL,           -- human name
  tts_name             TEXT,                   -- text-to-speech
  city_name            TEXT,
  location             GEOGRAPHY(Point, 4326),   -- nullable: generic pathway
                                                   -- nodes (location_type=3) may
                                                   -- omit stop_lat/stop_lon per spec
  location_type        SMALLINT,              -- 0=platform,1=station,2=entrance
  wheelchair_boarding  SMALLINT,              -- 0=unknown,1=accessible,2=not
  route_type           INT,                   -- mode served (optional, for filtering)
  parent_station       TEXT,                  -- global_stop_id of parent station
  parent_station_name  TEXT,                  -- convenience denormalised name
  level_id             TEXT REFERENCES gtfs_levels(level_id)  -- indoor nav: which floor
);
CREATE INDEX IF NOT EXISTS idx_stops_location   ON stops USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_stops_parent     ON stops (parent_station);
CREATE INDEX IF NOT EXISTS idx_stops_route_type ON stops (route_type);
CREATE INDEX IF NOT EXISTS idx_stops_level      ON stops (level_id);

CREATE TABLE IF NOT EXISTS itineraries (
  id                  BIGSERIAL PRIMARY KEY,
  global_route_id     TEXT NOT NULL REFERENCES routes(global_route_id),
  direction_id        INT NOT NULL,
  branch_code         TEXT NOT NULL DEFAULT '',
  headsign            TEXT,
  direction_headsign  TEXT,
  canonical_itinerary BOOLEAN NOT NULL DEFAULT false,
  shape               GEOGRAPHY(LineString, 4326),   -- map polyline
  UNIQUE (global_route_id, direction_id, branch_code)
);
CREATE INDEX IF NOT EXISTS idx_itineraries_route ON itineraries (global_route_id, direction_id);
CREATE INDEX IF NOT EXISTS idx_itineraries_shape ON itineraries USING GIST (shape);

CREATE TABLE IF NOT EXISTS route_stops (
  itinerary_id   BIGINT NOT NULL REFERENCES itineraries(id) ON DELETE CASCADE,
  stop_sequence  INT NOT NULL,
  global_stop_id TEXT NOT NULL REFERENCES stops(global_stop_id),
  PRIMARY KEY (itinerary_id, stop_sequence)
);
CREATE INDEX IF NOT EXISTS idx_route_stops_stop ON route_stops (global_stop_id);

-- =========================================================
-- GTFS SCHEDULE DATA (scheduling + indoor navigation support)
-- Feed refreshed roughly every 6 weeks; re-running the import
-- pipeline rebuilds all of this (and routes/stops/itineraries
-- above) from scratch. Safe while no live data references these
-- tables yet — once GTFS-RT / vehicle_positions is wired up,
-- switch the pipeline to upsert instead of truncate+rebuild.
-- =========================================================

CREATE TABLE IF NOT EXISTS gtfs_feed_versions (
  feed_version    TEXT PRIMARY KEY,      -- e.g. "S1000533"
  feed_start_date DATE NOT NULL,
  feed_end_date   DATE NOT NULL,
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gtfs_calendar (
  service_id TEXT PRIMARY KEY,
  monday     BOOLEAN,
  tuesday    BOOLEAN,
  wednesday  BOOLEAN,
  thursday   BOOLEAN,
  friday     BOOLEAN,
  saturday   BOOLEAN,
  sunday     BOOLEAN,
  start_date DATE,
  end_date   DATE
);

CREATE TABLE IF NOT EXISTS gtfs_calendar_dates (
  service_id      TEXT NOT NULL,
  date            DATE NOT NULL,
  exception_type  SMALLINT NOT NULL,   -- 1=added, 2=removed
  PRIMARY KEY (service_id, date)
);

CREATE TABLE IF NOT EXISTS gtfs_trips (
  trip_id          TEXT PRIMARY KEY,
  global_route_id  TEXT NOT NULL REFERENCES routes(global_route_id),
  service_id       TEXT NOT NULL,
  trip_headsign    TEXT,
  direction_id     SMALLINT,
  shape_id         TEXT,
  block_id         TEXT,
  branch_code      TEXT NOT NULL DEFAULT ''   -- resolved: 'A'/'B'/etc, via headsign
                                                -- regex + shape-endpoint proximity match
);
CREATE INDEX IF NOT EXISTS idx_gtfs_trips_route   ON gtfs_trips (global_route_id, direction_id, branch_code);
CREATE INDEX IF NOT EXISTS idx_gtfs_trips_service ON gtfs_trips (service_id);
CREATE INDEX IF NOT EXISTS idx_gtfs_trips_shape   ON gtfs_trips (shape_id);

CREATE TABLE IF NOT EXISTS gtfs_stop_times (
  trip_id        TEXT NOT NULL REFERENCES gtfs_trips(trip_id) ON DELETE CASCADE,
  stop_sequence  INT NOT NULL,
  global_stop_id TEXT NOT NULL REFERENCES stops(global_stop_id),
  arrival_time   TEXT,   -- kept as text: GTFS allows "25:10:00" for past-midnight trips
  departure_time TEXT,
  PRIMARY KEY (trip_id, stop_sequence)
);
CREATE INDEX IF NOT EXISTS idx_gtfs_stop_times_stop ON gtfs_stop_times (global_stop_id);

CREATE TABLE IF NOT EXISTS gtfs_pathways (
  pathway_id             TEXT PRIMARY KEY,
  from_stop_id           TEXT NOT NULL REFERENCES stops(global_stop_id),
  to_stop_id             TEXT NOT NULL REFERENCES stops(global_stop_id),
  pathway_mode           SMALLINT,   -- 1=walkway,2=stairs,3=moving sidewalk,4=escalator,5=elevator
  is_bidirectional       BOOLEAN,
  length_m               NUMERIC,
  traversal_time_sec     INT,
  stair_count            INT,
  max_slope              NUMERIC,
  min_width              NUMERIC,
  signposted_as          TEXT,
  reversed_signposted_as TEXT
);
CREATE INDEX IF NOT EXISTS idx_pathways_from ON gtfs_pathways (from_stop_id);
CREATE INDEX IF NOT EXISTS idx_pathways_to   ON gtfs_pathways (to_stop_id);

-- =========================================================
-- DYNAMIC DATA (append continuously, from live GTFS-RT feed)
-- =========================================================

-- Main real‑time vehicle positions (from GTFS‑RT)
CREATE TABLE IF NOT EXISTS vehicle_positions (
  id               BIGSERIAL,
  vehicle_id       TEXT NOT NULL,
  trip_id          TEXT,
  global_route_id  TEXT REFERENCES routes(global_route_id),
  direction_id     INT,
  location         GEOGRAPHY(Point, 4326) NOT NULL,
  speed_ms         DOUBLE PRECISION,          -- m/s
  bearing          DOUBLE PRECISION,          -- degrees
  occupancy_status TEXT,                      -- "MANY_SEATS_AVAILABLE" etc.
  next_stop_id     TEXT,                      -- global_stop_id of upcoming stop
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (recorded_at);

-- Create initial partitions (adjust as needed)
CREATE TABLE vehicle_positions_2026_07
  PARTITION OF vehicle_positions
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE vehicle_positions_2026_08
  PARTITION OF vehicle_positions
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- Indexes on each partition (you can also create on parent, they propagate)
CREATE INDEX IF NOT EXISTS idx_vp_vehicle_time ON vehicle_positions (vehicle_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_vp_route_time   ON vehicle_positions (global_route_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_vp_location     ON vehicle_positions USING GIST (location);

-- Optional: TimescaleDB hypertable approach (if you prefer it)
-- SELECT create_hypertable('vehicle_positions', 'recorded_at');

-- Departure predictions (from Transit API /stop_departures, optional)
CREATE TABLE IF NOT EXISTS departure_snapshots (
  id                     BIGSERIAL PRIMARY KEY,
  global_stop_id         TEXT NOT NULL REFERENCES stops(global_stop_id),
  global_route_id        TEXT REFERENCES routes(global_route_id),
  trip_id                TEXT,
  vehicle_id             TEXT,
  direction_id           INT,
  scheduled_departure    TIMESTAMPTZ,
  predicted_departure    TIMESTAMPTZ,
  delay_seconds          INT,
  schedule_relationship  TEXT,                  -- "SCHEDULED","CANCELLED","ADDED"
  occupancy_status       TEXT,
  vehicle_lat            DOUBLE PRECISION,
  vehicle_lon            DOUBLE PRECISION,
  vehicle_speed_ms       DOUBLE PRECISION,
  next_stop_id           TEXT,
  recorded_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dep_stop_time    ON departure_snapshots (global_stop_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_dep_route_time   ON departure_snapshots (global_route_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_dep_vehicle_time ON departure_snapshots (vehicle_id, recorded_at);

-- Derived dwell events (stop arrival/departure, computed from vehicle_positions or GTFS‑RT)
CREATE TABLE IF NOT EXISTS dwell_events (
  id              BIGSERIAL PRIMARY KEY,
  trip_id         TEXT NOT NULL,
  vehicle_id      TEXT,
  global_route_id TEXT,
  direction_id    INT,
  global_stop_id  TEXT NOT NULL,
  arrival_time    TIMESTAMPTZ,
  departure_time  TIMESTAMPTZ,
  dwell_seconds   INT,
  occupancy_status TEXT,
  recorded_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dwell_trip_stop ON dwell_events (trip_id, global_stop_id);

-- Bunching events (pre‑computed or real‑time)
CREATE TABLE IF NOT EXISTS bunching_events (
  id                    BIGSERIAL PRIMARY KEY,
  global_route_id       TEXT REFERENCES routes(global_route_id),
  direction_id          INT,
  vehicle_a             TEXT NOT NULL,
  vehicle_b             TEXT NOT NULL,
  gap_seconds           NUMERIC NOT NULL,
  expected_gap_seconds  NUMERIC,
  location              GEOGRAPHY(Point, 4326),
  detected_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bunching_route_time ON bunching_events (global_route_id, detected_at);

-- =========================================================
-- FUTURE ROAD NETWORK (for traffic‑aware routing)
-- =========================================================

CREATE TABLE IF NOT EXISTS road_nodes (
  id   BIGSERIAL PRIMARY KEY,
  geom GEOGRAPHY(Point, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_road_nodes_geom ON road_nodes USING GIST (geom);

CREATE TABLE IF NOT EXISTS road_edges (
  id          BIGSERIAL PRIMARY KEY,
  source_node BIGINT NOT NULL REFERENCES road_nodes(id),
  target_node BIGINT NOT NULL REFERENCES road_nodes(id),
  geom        GEOGRAPHY(LineString, 4326),
  length_m    DOUBLE PRECISION,
  properties  JSONB,          -- max_speed, lanes, one_way, live_traffic_speed…
  UNIQUE (source_node, target_node)
);
CREATE INDEX IF NOT EXISTS idx_road_edges_geom   ON road_edges USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_road_edges_source ON road_edges (source_node);
CREATE INDEX IF NOT EXISTS idx_road_edges_target ON road_edges (target_node);