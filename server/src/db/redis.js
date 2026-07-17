import Redis from "ioredis";

export const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

redis.on("error", (err) => {
  console.error("Redis connection error", err);
});

redis.on("connect", () => {
  console.log("Connected to Redis");
});

/**
 * Simple cache-aside helper.
 * fn() is only called (and its result cached) on a cache miss.
 */
export async function cached(key, ttlSeconds, fn) {
  const existing = await redis.get(key);
  if (existing !== null) {
    return JSON.parse(existing);
  }
  const value = await fn();
  await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  return value;
}
