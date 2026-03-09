/**
 * Idempotency for checkout: cache result and block duplicate in-flight requests.
 */

function cacheKey(skuId, userId, idempotencyKey) {
  return `checkout:idemp:${skuId}:${userId}:${idempotencyKey}`;
}

function inFlightKey(skuId, userId, idempotencyKey) {
  return `checkout:idemp:inflight:${skuId}:${userId}:${idempotencyKey}`;
}

async function getCached(redis, skuId, userId, idempotencyKey) {
  const key = cacheKey(skuId, userId, idempotencyKey);
  const raw = await redis.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function setCached(redis, skuId, userId, idempotencyKey, result, ttlSec) {
  const key = cacheKey(skuId, userId, idempotencyKey);
  await redis.set(key, JSON.stringify(result), 'EX', ttlSec);
}

async function trySetInFlight(redis, skuId, userId, idempotencyKey, requestId, ttlSec = 60) {
  const key = inFlightKey(skuId, userId, idempotencyKey);
  const ok = await redis.set(key, requestId, 'EX', ttlSec, 'NX');
  return ok === 'OK';
}

async function clearInFlight(redis, skuId, userId, idempotencyKey) {
  const key = inFlightKey(skuId, userId, idempotencyKey);
  await redis.del(key);
}

module.exports = {
  cacheKey,
  inFlightKey,
  getCached,
  setCached,
  trySetInFlight,
  clearInFlight,
};
