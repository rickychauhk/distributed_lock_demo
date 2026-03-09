const { randomUUID } = require('crypto');
const Redis = require('ioredis');
const { execute: checkoutExecute } = require('../lib/checkoutService');
const mockShopifyAdapter = require('../lib/adapters/mockShopifyAdapter');

const LOCK_TTL = Number(process.env.LOCK_TTL) || 10;
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
  const idempotencyKey = (body?.idempotencyKey || '').trim();

  const result = await checkoutExecute({
    redis: getRedis(),
    adapter: mockShopifyAdapter,
    lockTTL: LOCK_TTL,
    idempotencyTTL: IDEMPOTENCY_TTL,
    skuId,
    userId,
    idempotencyKey,
    requestId,
    simulateNoRelease: false,
    onMetrics: {},
  });

  return apiResponse(result.statusCode, result.body, {
    'x-request-id': requestId,
    ...result.headers,
  });
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
