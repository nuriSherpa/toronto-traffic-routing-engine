import { pool } from '../db/pool.js';

export async function getTile(z, x, y) {
  const bbox = tileToBBOX(z, x, y);
  const [west, south, east, north] = bbox;

  // Looser simplification tolerance (in degrees) at low zoom, where many
  // long routes overlap on screen -- this is the main lag source, not the
  // number of routes. Tighten as you approach maxNativeZoom so shapes stay
  // crisp once the user is zoomed into a neighborhood.
  const tolerance = z <= 10 ? 0.001 : z <= 13 ? 0.0003 : 0.00005;

  const query = `
    WITH bounds AS (
      SELECT ST_MakeEnvelope($1, $2, $3, $4, 4326) AS geom
    ),
    mvtgeom AS (
      SELECT
        ST_AsMVTGeom(
          ST_Transform(
            ST_SimplifyPreserveTopology(it.shape::geometry, $5),
            3857
          ),
          ST_Transform(bounds.geom, 3857),
          4096,
          256,
          true
        ) AS geom,
        r.global_route_id AS route_id,
        r.short_name AS route_short_name,
        r.route_type,
        COALESCE(r.color, '888888') AS color
      FROM itineraries it
      JOIN routes r ON r.global_route_id = it.global_route_id
      JOIN bounds ON true
      WHERE it.shape::geometry && bounds.geom
        AND ST_Length(it.shape::geometry) > 0
        -- Guard against bad data: VectorGrid only renders Point/LineString.
        -- A stray Polygon/MultiPolygon shape would otherwise throw
        -- "Unimplemented type: 3" client-side and kill the whole tile layer.
        AND GeometryType(it.shape::geometry) IN ('LINESTRING', 'MULTILINESTRING')
    )
    SELECT ST_AsMVT(mvtgeom.*, 'transit_routes', 4096, 'geom') AS mvt
    FROM mvtgeom
    WHERE mvtgeom.geom IS NOT NULL;
  `;

  const { rows } = await pool.query(query, [west, south, east, north, tolerance]);
  const rawMVT = rows[0]?.mvt;
  if (!rawMVT) return Buffer.alloc(0);

  return rawMVT; // NOT gzipped - controller must not set Content-Encoding: gzip
}

function tileToBBOX(z, x, y) {
  const n = Math.PI - (2.0 * Math.PI * y) / Math.pow(2.0, z);
  const west = (x / Math.pow(2.0, z)) * 360.0 - 180;
  const east = ((x + 1) / Math.pow(2.0, z)) * 360.0 - 180;
  const south = (180.0 / Math.PI) * Math.atan(Math.sinh(n));
  const n2 = Math.PI - (2.0 * Math.PI * (y + 1)) / Math.pow(2.0, z);
  const north = (180.0 / Math.PI) * Math.atan(Math.sinh(n2));
  return [west, south, east, north];
}
