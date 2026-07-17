// Run locally against a saved .mvt file to see exactly what geometry types
// and properties are inside it.
//
// Setup (one time):
//   npm install @mapbox/vector-tile pbf
//
// Usage:
//   node inspect-tile.mjs /tmp/tile.mvt
//
// Geometry type key (per the vector tile spec / @mapbox/vector-tile):
//   1 = Point
//   2 = LineString
//   3 = Polygon   <-- this is the one VectorGrid choked on

import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { VectorTile } = require('@mapbox/vector-tile');
const PbfModule = require('pbf');
const Pbf = PbfModule.default || PbfModule;

const path = process.argv[2];
if (!path) {
  console.error('Usage: node inspect-tile.mjs <path-to-tile.mvt>');
  process.exit(1);
}

const buf = fs.readFileSync(path);
console.log(`Read ${buf.length} bytes from ${path}`);

let tile;
try {
  tile = new VectorTile(new Pbf(buf));
} catch (err) {
  console.error('Failed to parse as a vector tile at all — bytes are likely corrupted/truncated:');
  console.error(err);
  process.exit(1);
}

const layerNames = Object.keys(tile.layers);
if (layerNames.length === 0) {
  console.log('No layers found in this tile (it decoded fine, but is empty).');
}

for (const name of layerNames) {
  const layer = tile.layers[name];
  console.log(`\nLayer "${name}" — ${layer.length} feature(s)`);
  for (let i = 0; i < layer.length; i++) {
    const feat = layer.feature(i);
    console.log(
      `  feature[${i}] type=${feat.type} (${['Unknown', 'Point', 'LineString', 'Polygon'][feat.type]})`,
      'properties=',
      feat.properties,
    );
  }
}
