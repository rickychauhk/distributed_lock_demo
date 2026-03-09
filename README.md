# Distributed Lock Demo

Use a Redis distributed lock to prevent oversell: for the same SKU, only one request is allowed to enter checkout (mock Shopify). All other concurrent requests are blocked at the API layer with HTTP 409 (no backend call).

## Design decisions

### Why Redis lock (vs DB lock)

| Approach | Pros | Cons |
|----------|------|------|
| **Redis SET NX EX** | Fast, low latency, no DB load, scales across instances, built-in TTL avoids deadlock | Requires Redis, not transactional with DB |
| **DB row lock** (SELECT ... FOR UPDATE) | Single source of truth; transactional | DB bottleneck; higher latency, lock scope tied to DB connection |

Choose Redis because checkout is an API-layer concern: want to block before calling Shopify, not inside a DB transaction. Redis gives sub-millisecond lock/unlock, and TTL ensures the lock is released even if the process crashes.

### Why TTL 10 seconds

- Mock checkout latency is ~200–500ms, 10s is a safe upper bound for real checkout (API call + payment).
- Shorter TTL (e.g. 5s) risks releasing the lock before a slow checkout finishes, longer TTL (e.g. 30s) delays retries if the process crashes.
- Tuning: set `LOCK_TTL` in `.env`; 10s is a reasonable default.

### Owner-safe release

`releaseLock` uses Lua: only delete the key if the stored value matches the current holder’s `lockValue`. This prevents an old request (whose checkout finished late) from deleting a **new** holder’s lock after TTL has expired and another request acquired it.

### Redis vs DB lock (quick compare)

- **Redis**: API-layer, fast, TTL auto-release, separate from DB.
- **DB lock**: Good when the critical section is DB writes; not ideal for “block before external API call”.

---

## Quick start

### 1. Start Redis (choose one)

```bash
# Docker
docker run -d -p 6379:6379 --name redis-demo redis

brew install redis && brew services start redis
# run directly
redis-server
```

### 2. Install dependencies and start API

```bash
cd distributed_lock_demo
npm install
npm start
```

Go to Live log viewer http://localhost:3000/demo after API started.

### 3. Simulate users racing for the same SKU

Open another terminal:

```bash
cd distributed_lock_demo
npm run simulate
```

Expected:

- **1 x 200**: the lock winner enters mock checkout
- **(99) x 409**: `SKU_LOCKED`, blocked by the Redis lock (no backend call)

## Project structure

```
distributed_lock_demo/
├── server.js                  # Express API (thin: routes + logging)
├── lib/
│   ├── redisLock.js           # Redis lock (SET NX EX, owner-safe release)
│   ├── idempotency.js         # Idempotency cache (get/set in-flight)
│   ├── metrics.js             # In-memory metrics (success, locked, avg lock hold)
│   ├── checkoutService.js     # Orchestrates lock + idempotency + adapter
│   ├── mockShopify.js         # Legacy mock (prefer adapters/)
│   └── adapters/
│       ├── mockShopifyAdapter.js   # Mock checkout (demo)
│       └── realShopifyAdapter.js   # Placeholder for real Shopify
├── lambda/
│   └── checkout.js            # Lambda handler (uses checkoutService)
├── scripts/
│   └── simulate-100-users.js
└── README.md
```

## API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/checkout` | Body: `{ "skuId", "userId" }` (lock protected) |
| GET | `/health` | Health check (Redis ping) |
| GET | `/api/metrics` | `checkoutSuccess`, `checkoutLocked`, `checkoutFailed`, `avgLockHoldMs` |
| GET | `/api/logs` | Recent logs |
| GET | `/demo` | Live log viewer |
