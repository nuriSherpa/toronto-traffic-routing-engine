import Redis from 'ioredis';

export const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

redis.on('error', (err) => {
  console.error('Redis connection error', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

/**
 * Simple cache-aside helper.
 * fn() is only called (and its result cached) on a cache miss.
 *
 * IMPORTANT: JSON.stringify(buffer) turns a real Buffer into
 * {"type":"Buffer","data":[...]}, and JSON.parse() on the way back gives you
 * a plain object, NOT a Buffer instance. That silently breaks anything
 * binary (like MVT vector tiles) that gets cached this way - Express can no
 * longer tell it's binary data and re-serializes it as JSON text when
 * sending the response. We special-case Buffers here so they round-trip
 * correctly as base64 instead.
 */
export async function cached(key, ttlSeconds, fn) {
  const existing = await redis.get(key);
  if (existing !== null) {
    return deserialize(existing);
  }
  const value = await fn();
  await redis.set(key, serialize(value), 'EX', ttlSeconds);
  return value;
}

function serialize(value) {
  if (Buffer.isBuffer(value)) {
    return JSON.stringify({ __buffer: true, base64: value.toString('base64') });
  }
  return JSON.stringify(value);
}

function deserialize(raw) {
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === 'object' && parsed.__buffer) {
    return Buffer.from(parsed.base64, 'base64');
  }
  return parsed;
}
