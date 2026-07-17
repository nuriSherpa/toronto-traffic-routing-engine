// server/src/services/tilesService.js
// Vector tile generation + Redis caching, sitting between the tile controller
// and the model that talks to PostGIS.
import { cached } from '../db/redis.js';
import * as TilesModel from '../models/tilesModel.js';

// Tiles are expensive to generate, and transit shapes rarely change.
// Cache for 24 hours.  You can increase this to match your GTFS import schedule.
const TILE_TTL_SECONDS = 24 * 60 * 60; // 24h

/**
 * Get a single vector tile (MVT binary buffer, gzipped).
 * @param {number} z - Zoom level
 * @param {number} x - Tile column
 * @param {number} y - Tile row
 * @returns {Promise<Buffer>}
 */
export async function getTile(z, x, y) {
  const cacheKey = `tile:${z}:${x}:${y}`;
  return cached(cacheKey, TILE_TTL_SECONDS, () => TilesModel.getTile(z, x, y));
}
