-- 1. Add a projected (Web Mercator) geometry column for MVT generation
ALTER TABLE roads ADD COLUMN IF NOT EXISTS geom_3857 geometry(MultiLineString, 3857);
UPDATE roads SET geom_3857 = ST_Transform(geom, 3857) WHERE geom_3857 IS NULL;
CREATE INDEX IF NOT EXISTS roads_geom_3857_idx ON roads USING GIST (geom_3857);

-- 2. Zoom-aware simplifying MVT function
CREATE OR REPLACE FUNCTION roads_mvt(z integer, x integer, y integer)
RETURNS bytea AS $$
DECLARE
  tile bytea;
  tolerance double precision;
  envelope geometry;
BEGIN
  envelope := ST_TileEnvelope(z, x, y);

  tolerance := CASE
    WHEN z <= 8  THEN 300
    WHEN z <= 11 THEN 40
    WHEN z <= 14 THEN 8
    ELSE 0
  END;

  SELECT ST_AsMVT(tile_data, 'roads', 4096, 'mvtgeom') INTO tile
  FROM (
    SELECT
      centreline_id, linear_name_full, linear_name_label,
      feature_code, feature_code_desc,
      oneway_dir_code, oneway_dir_code_desc, jurisdiction,
      ST_AsMVTGeom(
        CASE WHEN tolerance > 0
          THEN ST_SimplifyPreserveTopology(geom_3857, tolerance)
          ELSE geom_3857
        END,
        envelope, 4096, 64, true
      ) AS mvtgeom
    FROM roads
    WHERE geom_3857 && envelope
  ) AS tile_data;

  RETURN tile;
END;
$$ LANGUAGE plpgsql STABLE PARALLEL SAFE;