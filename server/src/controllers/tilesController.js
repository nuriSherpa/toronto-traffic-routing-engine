import * as TilesService from '../services/tilesService.js';

export async function getTile(req, res) {
  try {
    const z = parseInt(req.params.z, 10);
    const x = parseInt(req.params.x, 10);
    const y = parseInt(req.params.y, 10);

    if ([z, x, y].some((n) => Number.isNaN(n))) {
      return res
        .status(400)
        .json({ success: false, error: { message: 'Invalid tile coordinates' } });
    }

    const tile = await TilesService.getTile(z, x, y);

    if (!tile || tile.length === 0) {
      // Empty tile for this z/x/y - 204 so Leaflet.VectorGrid just skips it
      return res.status(204).end();
    }

    res.set('Content-Type', 'application/x-protobuf');
    // IMPORTANT: tilesModel/tilesService do NOT gzip the buffer, so do not
    // set Content-Encoding: gzip here - doing so breaks decoding client-side
    // and silently kills every route line + click handler on the map.
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(tile);
  } catch (err) {
    console.error('getTile error:', err);
    res.status(500).json({ success: false, error: { message: 'Failed to generate tile' } });
  }
}
