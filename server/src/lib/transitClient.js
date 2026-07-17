const BASE_URL = "https://external.transitapp.com";

// 5 requests/minute is the hard limit. We space calls out to 1 every 13s
// (~4.6/min) to leave a safety margin instead of bursting right up to the edge.
const MIN_INTERVAL_MS = 13_000;

let lastRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle() {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (elapsed < MIN_INTERVAL_MS) {
    await sleep(MIN_INTERVAL_MS - elapsed);
  }
  lastRequestAt = Date.now();
}

/**
 * Calls a Transit App v4 public endpoint, honoring the rate limit.
 * @param {string} path - e.g. "/v4/public/routes_for_networks"
 * @param {Record<string, string|number|boolean>} params
 */
export async function transitGet(path, params = {}) {
  const apiKey = process.env.TRANSIT_API_KEY;
  if (!apiKey) {
    throw new Error("TRANSIT_API_KEY is not set in the environment");
  }

  await throttle();

  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url, {
    headers: { apiKey },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Transit API ${path} failed: ${res.status} ${res.statusText} ${body}`
    );
  }

  return res.json();
}
