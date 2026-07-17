import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { transitGet } from '../lib/transitClient.js';

const LINE_1_ROUTE_ID = 'TTC:112634';
const OUTPUT_PATH = new URL('./debug-output/line1-itineraries.json', import.meta.url);

async function main() {
  console.log(`Fetching route_details for ${LINE_1_ROUTE_ID}...`);
  const data = await transitGet('/v4/public/route_details', {
    global_route_id: LINE_1_ROUTE_ID,
    stop_detailed: true,
  });

  const itineraries = data.itineraries || [];
  console.log(`API returned ${itineraries.length} itinerary object(s) total.`);

  // A lightweight summary, easy to scan without wading through full stop lists.
  const summary = itineraries.map((itinerary, index) => ({
    index,
    direction_id: itinerary.direction_id,
    headsign: itinerary.headsign,
    direction_headsign: itinerary.direction_headsign,
    branch_code: itinerary.branch_code,
    canonical_itinerary: itinerary.canonical_itinerary,
    is_active: itinerary.is_active,
    num_stops: itinerary.stops?.length ?? 0,
    first_stop: itinerary.stops?.[0]?.stop_name ?? null,
    last_stop: itinerary.stops?.[itinerary.stops.length - 1]?.stop_name ?? null,
    has_shape: Boolean(itinerary.shape),
  }));

  console.table(summary);

  await writeFile(OUTPUT_PATH, JSON.stringify({ summary, full_itineraries: itineraries }, null, 2));
  console.log(`\nFull data written to server/src/scripts/debug-output/line1-itineraries.json`);
}

main().catch((err) => {
  console.error('Debug fetch failed:', err);
  process.exit(1);
});
