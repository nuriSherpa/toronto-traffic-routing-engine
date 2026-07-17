// server/src/scripts/update-missing-shapes.js
import 'dotenv/config';
import { pool, query } from '../db/pool.js';
import { transitGet } from '../lib/transitClient.js';

async function main() {
  try {
    console.log('Fetching shape for TTC:112569…');
    const data = await transitGet('/v4/public/route_details', {
      global_route_id: 'TTC:112569',
      stop_detailed: true,
    });

    const itineraries = data.itineraries || [];
    if (itineraries.length === 0) {
      console.log('No itineraries returned.');
      return;
    }

    // Pick the longest itinerary per direction/branch
    const bestMap = new Map();
    for (const it of itineraries) {
      const key = `${it.direction_id}::${it.branch_code ?? ''}`;
      const stopCount = it.stops?.length ?? 0;
      const existing = bestMap.get(key);
      if (!existing || stopCount > (existing.stops?.length ?? 0)) {
        bestMap.set(key, it);
      }
    }

    for (const [key, it] of bestMap) {
      const shapeValue = it.shape ?? null;
      console.log(
        `  -> dir=${it.direction_id} branch='${it.branch_code ?? ''}' shape=${shapeValue ? 'present' : 'NULL'}`,
      );

      if (shapeValue) {
        await query(
          `UPDATE itineraries
           SET shape = CASE WHEN $1::text IS NULL OR $1 = ''
                           THEN NULL
                           ELSE ST_SetSRID(ST_LineFromEncodedPolyline($1), 4326)::geography
                         END
           WHERE global_route_id = 'TTC:5'
             AND direction_id = $2
             AND branch_code = $3`,
          [shapeValue, it.direction_id, it.branch_code ?? ''],
        );
        console.log('     ✅ Updated TTC:5');
      }
    }
    console.log('Done.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
