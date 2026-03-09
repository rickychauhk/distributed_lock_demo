/**
 * Checkout service: coordinates lock, idempotency, and checkout adapter.
 */

const { acquireLock, releaseLock } = require('./redisLock');
const idempotency = require('./idempotency');

async function execute({
  redis,
  adapter,
  lockTTL,
  idempotencyTTL,
  skuId,
  userId,
  idempotencyKey,
  requestId,
  simulateNoRelease = false,
  onMetrics = {},
}) {
  const { incrementSuccess, incrementLocked, incrementFailed, recordLockHoldMs } = onMetrics;

  if (!skuId || !userId) {
    return {
      outcome: 'bad_request',
      statusCode: 400,
      body: { code: 'BAD_REQUEST', message: 'skuId and userId are required' },
      headers: {},
    };
  }

  if (idempotencyKey) {
    const cached = await idempotency.getCached(redis, skuId, userId, idempotencyKey);
    if (cached) {
      if (incrementSuccess) incrementSuccess();
      return {
        outcome: 'idempotent_replay',
        statusCode: 200,
        body: cached,
        headers: { 'x-idempotent-replay': '1' },
      };
    }
    const inFlight = await idempotency.trySetInFlight(redis, skuId, userId, idempotencyKey, requestId);
    if (!inFlight) {
      return {
        outcome: 'idempotent_inflight',
        statusCode: 409,
        body: {
          code: 'IDEMPOTENCY_IN_PROGRESS',
          message: 'Duplicate request in progress. Retry shortly.',
        },
        headers: { 'retry-after': '1' },
      };
    }
  }

  const lockValue = `${userId}-${Date.now()}`;
  const acquired = await acquireLock(redis, skuId, lockValue, lockTTL);

  if (!acquired) {
    if (idempotencyKey) {
      await idempotency.clearInFlight(redis, skuId, userId, idempotencyKey);
    }
    if (incrementLocked) incrementLocked();
    return {
      outcome: 'locked',
      statusCode: 409,
      body: {
        code: 'SKU_LOCKED',
        message: 'This SKU is being checked out by another user. Please retry shortly.',
        retryAfter: lockTTL,
      },
      headers: {},
    };
  }

  const lockAcquiredAt = Date.now();

  try {
    const result = await adapter.checkout(skuId, userId);

    if (!simulateNoRelease) {
      const released = await releaseLock(redis, skuId, lockValue);
      const holdMs = Date.now() - lockAcquiredAt;
      if (recordLockHoldMs) recordLockHoldMs(holdMs);
    }

    if (idempotencyKey) {
      await idempotency.setCached(redis, skuId, userId, idempotencyKey, result, idempotencyTTL);
      await idempotency.clearInFlight(redis, skuId, userId, idempotencyKey);
    }

    if (incrementSuccess) incrementSuccess();
    return {
      outcome: 'success',
      statusCode: 200,
      body: result,
      headers: {},
    };
  } catch (err) {
    if (!simulateNoRelease) {
      await releaseLock(redis, skuId, lockValue);
    }
    if (idempotencyKey) {
      await idempotency.clearInFlight(redis, skuId, userId, idempotencyKey);
    }
    if (incrementFailed) incrementFailed();
    return {
      outcome: 'checkout_failed',
      statusCode: 502,
      body: { code: 'CHECKOUT_FAILED', message: err.message || 'Checkout failed' },
      headers: {},
    };
  }
}

module.exports = { execute };
