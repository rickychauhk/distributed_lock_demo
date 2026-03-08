# Distributed Lock Demo

Use a **Redis distributed lock** to prevent oversell: for the same SKU, only one request is allowed to enter checkout (mock Shopify). All other concurrent requests are blocked at the API layer with HTTP 409 (no backend call).
## Quick start
## (choose one)
### 1. Start Redis 

```bash
# Docker
docker run -d -p 6379:6379 --name redis-demo redis

# Or local (macOS)
brew install redis && brew services start redis
# Or run directly
redis-server
```

### 2. Install dependencies and start API

```bash
cd distributed_lock_demo
npm install
npm start
http://localhost:3000/demo
```
### Go to  http://localhost:3000/demo after API started 

### 3. Simulate users racing for the same SKU

Open another terminal:

```bash
cd distributed_lock_demo
npm run simulate
```

Expected:

- **1 x 200**: the lock winner enters mock checkout
- **(99)x 409**: `SKU_LOCKED`, blocked by the Redis lock (no backend call)