/**
 * AWS Lambda handler: checkout with Redis lock (same logic as server.js).
 * Set Handler to: lambda/checkout.handler
 * Env: REDIS_URL (e.g. redis://your-elasticache.amazonaws.com:6379), LOCK_TTL, IDEMPOTENCY_TTL
 */

const { randomUUID } = require('crypto');
const Redis = require('ioredis');
const { acquireLock, releaseLock } = require('../lib/redisLock');
const { mockCheckout } = require('../lib/mockShopify');

const LOCK_TTL = Number(process.env.LOCK_TTL) || 30;
const IDEMPOTENCY_TTL = Number(process.env.IDEMPOTENCY_TTL) || 300;

let redis;

function getRedis() {
  if (!redis) {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    redis = new Redis(url, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        return Math.min(times * 100, 3000);
      },
    });
    redis.on('error', (err) => console.error('Redis error:', err.message));
  }
  return redis;
}

function idempotencyCacheKey({ skuId, userId, idempotencyKey }) {
  return `checkout:idemp:${skuId}:${userId}:${idempotencyKey}`;
}

function idempotencyInFlightKey({ skuId, userId, idempotencyKey }) {
  return `checkout:idemp:inflight:${skuId}:${userId}:${idempotencyKey}`;
}

function apiResponse(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

async function handleCheckout(body, requestId) {
  const { skuId, userId } = body || {};
  if (!skuId || !userId) {
    return apiResponse(400, {
      code: 'BAD_REQUEST',
      message: 'skuId and userId are required',
    }, { 'x-request-id': requestId });
  }

  const client = getRedis();
  const lockValue = `${userId}-${Date.now()}`;
  const idempotencyKey = (body.idempotencyKey || '').trim();

  if (idempotencyKey) {
    const cacheKey = idempotencyCacheKey({ skuId, userId, idempotencyKey });
    const cached = await client.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      return apiResponse(200, parsed, {
        'x-request-id': requestId,
        'x-idempotent-replay': '1',
      });
    }
    const inFlightKey = idempotencyInFlightKey({ skuId, userId, idempotencyKey });
    const inFlight = await client.set(inFlightKey, requestId, 'EX', 60, 'NX');
    if (inFlight !== 'OK') {
      return apiResponse(409, {
        code: 'IDEMPOTENCY_IN_PROGRESS',
        message: 'Duplicate request in progress. Retry shortly.',
      }, { 'x-request-id': requestId, 'retry-after': '1' });
    }
  }

  const acquired = await acquireLock(client, skuId, lockValue, LOCK_TTL);
  if (!acquired) {
    if (idempotencyKey) {
      await client.del(idempotencyInFlightKey({ skuId, userId, idempotencyKey }));
    }
    return apiResponse(409, {
      code: 'SKU_LOCKED',
      message: 'This SKU is being checked out by another user. Please retry shortly.',
      retryAfter: LOCK_TTL,
    }, { 'x-request-id': requestId });
  }

  try {
    const result = await mockCheckout(skuId, userId);
    await releaseLock(client, skuId, lockValue);

    if (idempotencyKey) {
      const cacheKey = idempotencyCacheKey({ skuId, userId, idempotencyKey });
      await client.set(cacheKey, JSON.stringify(result), 'EX', IDEMPOTENCY_TTL);
      await client.del(idempotencyInFlightKey({ skuId, userId, idempotencyKey }));
    }

    return apiResponse(200, result, { 'x-request-id': requestId });
  } catch (err) {
    await releaseLock(client, skuId, lockValue);
    if (idempotencyKey) {
      await client.del(idempotencyInFlightKey({ skuId, userId, idempotencyKey }));
    }
    console.error('Checkout error:', err);
    return apiResponse(502, {
      code: 'CHECKOUT_FAILED',
      message: err.message || 'Checkout failed',
    }, { 'x-request-id': requestId });
  }
}

exports.handler = async (event) => {
  const requestId = event.requestContext?.requestId || randomUUID();
  const headers = event.headers || {};
  let body = null;
  if (event.body) {
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch (_) {
      return apiResponse(400, { code: 'BAD_REQUEST', message: 'Invalid JSON body' }, { 'x-request-id': requestId });
    }
  }
  if (headers['Idempotency-Key']) {
    body = body || {};
    body.idempotencyKey = headers['Idempotency-Key'];
  }

  return handleCheckout(body, requestId);
};
