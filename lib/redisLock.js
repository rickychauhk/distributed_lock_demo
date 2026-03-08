const LOCK_PREFIX = 'checkout:lock:';
const DEFAULT_TTL = 10;

async function acquireLock(redis, skuId, lockValue, ttl = DEFAULT_TTL) {
  const key = LOCK_PREFIX + skuId;
  const result = await redis.set(key, lockValue, 'EX', ttl, 'NX');
  return result === 'OK';
}


async function releaseLock(redis, skuId, lockValue) {
  const key = LOCK_PREFIX + skuId;
  const lua = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  const result = await redis.eval(lua, 1, key, lockValue);
  return Number(result) === 1;
}

module.exports = { acquireLock, releaseLock, LOCK_PREFIX };
