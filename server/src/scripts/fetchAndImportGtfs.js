// server/src/scripts/fetchAndImportGtfs.js
// Fetches the latest TTC GTFS static feed from Toronto Open Data (CKAN API),
// extracts it, streams the CSVs into staging tables, and runs the transform
// into the final schema. Safe to re-run every ~6 weeks when TTC refreshes
// the feed — just run this one script, no manual download needed.
import 'dotenv/config';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import AdmZip from 'adm-zip';
import copyFromModule from 'pg-copy-streams';
import { pool } from '../db/pool.js';

const { from: copyFrom } = copyFromModule;

const CKAN_PACKAGE_ID = 'b811ead4-6eaf-4adb-8408-d389fb5a069c';
const CKAN_PACKAGE_URL = `https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=${CKAN_PACKAGE_ID}`;

const WORK_DIR = path.join(os.tmpdir(), 'gtfs-import');
const ZIP_PATH = path.join(WORK_DIR, 'gtfs.zip');
const EXTRACT_DIR = path.join(WORK_DIR, 'extracted');

// Maps each staging table to its GTFS filename and the exact column list
// (order matters: must match the CSV header order for a plain COPY).
const STAGING_TABLES = [
  { table: 'gtfs_agency_staging', file: 'agency.txt' },
  { table: 'gtfs_feed_info_staging', file: 'feed_info.txt' },
  { table: 'gtfs_routes_staging', file: 'routes.txt' },
  { table: 'gtfs_trips_staging', file: 'trips.txt' },
  { table: 'gtfs_stop_times_staging', file: 'stop_times.txt' },
  { table: 'gtfs_shapes_staging', file: 'shapes.txt' },
  { table: 'gtfs_stops_staging', file: 'stops.txt' },
  { table: 'gtfs_calendar_staging', file: 'calendar.txt' },
  { table: 'gtfs_calendar_dates_staging', file: 'calendar_dates.txt' },
  { table: 'gtfs_levels_staging', file: 'levels.txt' },
  { table: 'gtfs_pathways_staging', file: 'pathways.txt' },
];

// ── Step 1: find the current ZIP resource URL via CKAN ────────

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        const chunks = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch (err) {
            reject(err);
          }
        });
        response.on('error', reject);
      })
      .on('error', reject);
  });
}

async function findGtfsZipUrl() {
  console.log('Looking up current GTFS package metadata from CKAN...');
  const json = await httpGetJson(CKAN_PACKAGE_URL);
  if (!json.success) {
    throw new Error('CKAN package_show request failed: ' + JSON.stringify(json.error));
  }
  const resources = json.result?.resources || [];
  const zipResource = resources.find((r) => (r.format || '').toUpperCase() === 'ZIP');
  if (!zipResource) {
    console.log(
      'Resources found:',
      resources.map((r) => `${r.name} (${r.format})`),
    );
    throw new Error('No ZIP resource found in CKAN package.');
  }
  console.log(`Found GTFS ZIP: ${zipResource.name} -> ${zipResource.url}`);
  return zipResource.url;
}

// ── Step 2: download the ZIP ───────────────────────────────────

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          // follow redirect
          downloadFile(response.headers.location, destPath).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', reject);
  });
}

// ── Step 3: extract ─────────────────────────────────────────────

function extractZip(zipPath, destDir) {
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(destDir, true);
}

// ── Step 4: stream each CSV into its staging table ─────────────

// Drops empty/whitespace-only lines from a byte stream before they reach
// COPY. GTFS exporters (including TTC's) sometimes emit trailing blank
// lines at EOF, and occasionally a stray blank line mid-file; COPY treats
// any such line as a data row with 0 columns and aborts the whole load.
function skipBlankLines() {
  let carry = '';
  return new Transform({
    transform(chunk, _enc, callback) {
      carry += chunk.toString('utf8');
      const lines = carry.split('\n');
      // last element may be a partial line — hold it back for next chunk
      carry = lines.pop();
      const kept = lines.filter((line) => line.trim() !== '');
      callback(null, kept.length ? kept.join('\n') + '\n' : '');
    },
    flush(callback) {
      if (carry.trim() !== '') {
        callback(null, carry + '\n');
      } else {
        callback();
      }
    },
  });
}

async function truncateStagingTables(client) {
  const tableNames = STAGING_TABLES.map((t) => t.table).join(', ');
  await client.query(`TRUNCATE ${tableNames}`);
}

async function loadCsvIntoTable(client, table, filePath) {
  if (!fs.existsSync(filePath)) {
    console.log(`  (skipping ${table}: file not found — ${path.basename(filePath)})`);
    return;
  }
  await new Promise((resolve, reject) => {
    const copyStream = client.query(
      copyFrom(`COPY ${table} FROM STDIN WITH (FORMAT csv, HEADER true)`),
    );
    const fileStream = fs.createReadStream(filePath);
    const filterStream = skipBlankLines();

    fileStream.on('error', reject);
    filterStream.on('error', reject);
    copyStream.on('error', reject);
    copyStream.on('finish', resolve);

    fileStream.pipe(filterStream).pipe(copyStream);
  });
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(WORK_DIR, { recursive: true });

  const zipUrl = await findGtfsZipUrl();

  console.log('Downloading GTFS ZIP...');
  await downloadFile(zipUrl, ZIP_PATH);
  console.log(`Downloaded to ${ZIP_PATH} (${fs.statSync(ZIP_PATH).size} bytes)`);

  console.log('Extracting...');
  fs.rmSync(EXTRACT_DIR, { recursive: true, force: true });
  extractZip(ZIP_PATH, EXTRACT_DIR);
  console.log(`Extracted to ${EXTRACT_DIR}`);
  console.log('Files:', fs.readdirSync(EXTRACT_DIR));

  const client = await pool.connect();
  try {
    // Create staging tables if this is the first run
    await client.query(`
      CREATE TABLE IF NOT EXISTS gtfs_agency_staging (
        agency_id TEXT, agency_name TEXT, agency_url TEXT, agency_timezone TEXT,
        agency_lang TEXT, agency_phone TEXT, agency_fare_url TEXT, agency_email TEXT,
        cemv_support SMALLINT
      );
      CREATE TABLE IF NOT EXISTS gtfs_feed_info_staging (
        feed_publisher_name TEXT, feed_publisher_url TEXT, feed_lang TEXT,
        feed_start_date TEXT, feed_end_date TEXT, feed_version TEXT
      );
      CREATE TABLE IF NOT EXISTS gtfs_routes_staging (
        route_id TEXT, agency_id TEXT, route_short_name TEXT, route_long_name TEXT,
        route_desc TEXT, route_type INT, route_url TEXT, route_color TEXT, route_text_color TEXT
      );
      CREATE TABLE IF NOT EXISTS gtfs_trips_staging (
        trip_id TEXT, route_id TEXT, service_id TEXT, trip_headsign TEXT,
        trip_short_name TEXT, direction_id SMALLINT, block_id TEXT, shape_id TEXT,
        wheelchair_accessible SMALLINT
      );
      CREATE TABLE IF NOT EXISTS gtfs_stop_times_staging (
        trip_id TEXT, arrival_time TEXT, departure_time TEXT, stop_id TEXT,
        stop_sequence INT, stop_headsign TEXT, pickup_type SMALLINT,
        drop_off_type SMALLINT, shape_dist_traveled NUMERIC, timepoint SMALLINT
      );
      CREATE TABLE IF NOT EXISTS gtfs_shapes_staging (
        shape_id TEXT, shape_pt_lat DOUBLE PRECISION, shape_pt_lon DOUBLE PRECISION,
        shape_pt_sequence INT, shape_dist_traveled NUMERIC
      );
      CREATE TABLE IF NOT EXISTS gtfs_stops_staging (
        stop_id TEXT, stop_code TEXT, stop_name TEXT, stop_desc TEXT,
        stop_lat DOUBLE PRECISION, stop_lon DOUBLE PRECISION, zone_id TEXT,
        stop_url TEXT, location_type SMALLINT, parent_station TEXT,
        stop_timezone TEXT, wheelchair_boarding SMALLINT, level_id TEXT, tts_stop_name TEXT
      );
      CREATE TABLE IF NOT EXISTS gtfs_calendar_staging (
        service_id TEXT, monday BOOLEAN, tuesday BOOLEAN, wednesday BOOLEAN,
        thursday BOOLEAN, friday BOOLEAN, saturday BOOLEAN, sunday BOOLEAN,
        start_date TEXT, end_date TEXT
      );
      CREATE TABLE IF NOT EXISTS gtfs_calendar_dates_staging (
        service_id TEXT, date TEXT, exception_type SMALLINT
      );
      CREATE TABLE IF NOT EXISTS gtfs_levels_staging (
        level_id TEXT, level_index NUMERIC, level_name TEXT
      );
      CREATE TABLE IF NOT EXISTS gtfs_pathways_staging (
        pathway_id TEXT, from_stop_id TEXT, to_stop_id TEXT, pathway_mode SMALLINT,
        is_bidirectional SMALLINT, length NUMERIC, traversal_time INT,
        stair_count INT, max_slope NUMERIC, min_width NUMERIC,
        signposted_as TEXT, reversed_signposted_as TEXT
      );
    `);

    console.log('Truncating staging tables...');
    await truncateStagingTables(client);

    console.log('Loading CSVs into staging tables via COPY...');
    for (const { table, file } of STAGING_TABLES) {
      const filePath = path.join(EXTRACT_DIR, file);
      console.log(`  -> ${table} (${file})`);
      await loadCsvIntoTable(client, table, filePath);
    }

    console.log('Running transform into final schema...');
    const transformSql = fs.readFileSync(
      new URL('./sql/gtfs_transform.sql', import.meta.url),
      'utf-8',
    );
    await client.query('BEGIN');
    try {
      await client.query(transformSql);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    console.log('Transform complete. Summary:');
    const summary = await client.query(`
      SELECT 'feed_versions' AS tbl, count(*) FROM gtfs_feed_versions
      UNION ALL SELECT 'routes', count(*) FROM routes
      UNION ALL SELECT 'stops', count(*) FROM stops
      UNION ALL SELECT 'itineraries', count(*) FROM itineraries
      UNION ALL SELECT 'route_stops', count(*) FROM route_stops
      UNION ALL SELECT 'gtfs_trips', count(*) FROM gtfs_trips
      UNION ALL SELECT 'gtfs_stop_times', count(*) FROM gtfs_stop_times
      UNION ALL SELECT 'gtfs_pathways', count(*) FROM gtfs_pathways
      UNION ALL SELECT 'gtfs_calendar', count(*) FROM gtfs_calendar
      UNION ALL SELECT 'gtfs_levels', count(*) FROM gtfs_levels
    `);
    console.table(summary.rows);
  } finally {
    client.release();
  }

  console.log('Cleaning up temp files...');
  fs.rmSync(WORK_DIR, { recursive: true, force: true });

  console.log('Done.');
  await pool.end();
}

main().catch((err) => {
  console.error('GTFS import failed:', err);
  process.exit(1);
});
