import 'dotenv/config';
import { transitGet } from '../lib/transitClient.js';

const GLOBAL_ROUTE_ID = 'TTC:824'; // route 68 Warden

async function main() {
  const data = await transitGet('/v4/public/route_details', {
    global_route_id: GLOBAL_ROUTE_ID,
    stop_detailed: true,
  });

  const itineraries = data.itineraries || [];
  console.log(`Raw itinerary count from API: ${itineraries.length}`);
  console.log('---');

  // Print ALL keys present on the first itinerary object, so we see fields
  // beyond direction_id/branch_code/headsign/stops/shape
  console.log('Keys on itinerary object:', Object.keys(itineraries[0]));
  console.log('---');

  itineraries.forEach((itin, i) => {
    console.log(
      `[${i}] direction_id=${itin.direction_id} branch_code=${JSON.stringify(itin.branch_code)} ` +
        `headsign="${itin.headsign}" direction_headsign="${itin.direction_headsign}" ` +
        `stops=${itin.stops?.length ?? 0} shape_len=${itin.shape?.length ?? 0} ` +
        `trip_id=${itin.trip_id} pattern_id=${itin.pattern_id} canonical=${itin.canonical_itinerary}`,
    );
  });

  console.log('---');
  console.log('Southbound (direction_id=0) first/last stop for each record:');
  itineraries
    .filter((itin) => itin.direction_id === 0)
    .forEach((itin, i) => {
      const stops = itin.stops || [];
      console.log(
        `  [0-${i}] stops=${stops.length} first="${stops[0]?.stop_name}" last="${stops[stops.length - 1]?.stop_name}"`,
      );
    });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
