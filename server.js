require('dotenv').config();
const express = require('express');
const Redis = require('ioredis');
const { randomUUID } = require('crypto');
const { LOCK_PREFIX } = require('./lib/redisLock');
const { execute: checkoutExecute } = require('./lib/checkoutService');
const mockShopifyAdapter = require('./lib/adapters/mockShopifyAdapter');
const metrics = require('./lib/metrics');

const app = express();

app.set('trust proxy', process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true');
app.use(express.json({ limit: '64kb' }));

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  next();
});

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const PORT = Number(process.env.PORT) || 3000;
const LOCK_TTL = Number(process.env.LOCK_TTL) || 10;
const IDEMPOTENCY_TTL = Number(process.env.IDEMPOTENCY_TTL) || 300;

const LOG_MAX = 500;
const logBuffer = [];
let requestSeq = 0;

function clearLogs() {
  logBuffer.length = 0;
  requestSeq = 0;
}

function ts() {
  const d = new Date();
  return d.toTimeString().slice(0, 12);
}

function pushLog(level, message, detail = null) {
  const entry = {
    time: ts(),
    level,
    message,
    ...(detail != null && { detail }),
  };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
  const tag =
    level === 'lock_ok'
      ? 'LOCK_OK'
      : level === 'lock_fail'
        ? 'LOCK_FAIL'
        : level === 'release'
          ? 'RELEASE'
          : level === 'shopify'
            ? 'MOCK_SHOPIFY'
            : level === 'warn'
              ? 'WARN'
              : 'INFO';
  console.log(`[${entry.time}] [${tag}] ${message}`, detail != null ? detail : '');
}

const redis = new Redis(REDIS_URL);

// Subscribe to key expiry so we can log when a lock is released by TTL (not by releaseLock).
// Requires Redis notify-keyspace-events Ex; we try to set it below (fails on some managed Redis).
const redisSub = new Redis(REDIS_URL);
redisSub.on('error', (err) => console.error('Redis sub error:', err.message));
redisSub.on('connect', () => {
  (async () => {
    try {
      await redisSub.config('SET', 'notify-keyspace-events', 'Ex');
    } catch (_) {}
    const db = redisSub.options.db || 0;
    await redisSub.subscribe(`__keyevent@${db}__:expired`);
  })().catch((err) => console.error('Redis sub setup:', err.message));
});
redisSub.on('message', (channel, key) => {
  if (key.startsWith(LOCK_PREFIX)) {
    const skuId = key.slice(LOCK_PREFIX.length);
    pushLog('release', 'Lock released by TTL expiry', { key, skuId, reason: 'TTL expired' });
  }
});

app.use((req, res, next) => {
  const requestId = (req.get('x-request-id') || '').trim() || randomUUID();
  req.requestId = requestId;
  res.set('x-request-id', requestId);
  next();
});

app.get('/', (req, res) => {
  res.type('application/json').json({
    name: 'Distributed Lock Demo API',
    description: 'Prevent oversell with a Redis distributed lock',
    endpoints: {
      'POST /api/checkout': 'Body: { "skuId", "userId" } (lock protected)',
      'GET /health': 'Health check (includes Redis ping)',
      'GET /api/metrics': 'Checkout success/locked/failed counts, avg lock hold ms',
      'GET /api/logs': 'Recent logs (lock acquire/release + mock checkout)',
      'DELETE /api/logs': 'Clear all logs (demo utility)',
      'GET /demo': 'Live log viewer + fire concurrent requests',
    },
    docs: 'See README.md',
  });
});

redis.on('error', (err) => {
  console.error('Redis error:', err.message);
  pushLog('warn', 'Redis error: ' + err.message, { error: err.message });
});
redis.on('connect', () => {
  console.log('Redis connected:', REDIS_URL);
  pushLog('info', 'Redis connected', { url: REDIS_URL });
});

app.post('/api/checkout', async (req, res) => {
  const requestId = req.requestId;
  const { skuId, userId } = req.body || {};
  const idempotencyKey = (req.get('idempotency-key') || req.body?.idempotencyKey || '').trim();
  const retryCount = parseInt(req.get('x-retry-count'), 10) || 0;
  const simulateNoRelease = req.get('x-simulate-no-release') === '1' || req.body?.simulateNoRelease === true;

  requestSeq += 1;
  const seq = requestSeq;
  const retryLabel = retryCount > 0 ? ` (retry attempt ${retryCount})` : '';
  const lockValue = `${userId}-${Date.now()}`;

  pushLog('info', `[#${seq}] Request received: userId=${userId} attempting Redis lock${retryLabel}`, {
    seq,
    requestId,
    skuId,
    userId,
    lockKey: `checkout:lock:${skuId}`,
    lockValue,
    ...(retryCount ? { retryAttempt: retryCount } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });

  const result = await checkoutExecute({
    redis,
    adapter: mockShopifyAdapter,
    lockTTL: LOCK_TTL,
    idempotencyTTL: IDEMPOTENCY_TTL,
    skuId,
    userId,
    idempotencyKey,
    requestId,
    simulateNoRelease,
    onMetrics: {
      incrementSuccess: () => metrics.incrementSuccess(),
      incrementLocked: () => metrics.incrementLocked(),
      incrementFailed: () => metrics.incrementFailed(),
      recordLockHoldMs: (ms) => metrics.recordLockHoldMs(ms),
    },
  });

  Object.entries(result.headers || {}).forEach(([k, v]) => res.set(k, v));
  res.set('x-request-id', requestId);

  switch (result.outcome) {
    case 'bad_request':
      pushLog('warn', 'Missing skuId or userId', { requestId, body: req.body });
      return res.status(result.statusCode).json(result.body);
    case 'idempotent_replay':
      pushLog('info', `[#${seq}] Idempotency replay`, { seq, requestId, skuId, userId, idempotencyKey, orderId: result.body?.orderId });
      return res.status(result.statusCode).json(result.body);
    case 'idempotent_inflight':
      pushLog('lock_fail', `[#${seq}] Idempotency in-flight: blocked duplicate request`, {
        seq,
        requestId,
        skuId,
        userId,
        idempotencyKey,
        hint: 'Another request with the same idempotency key is in progress',
      });
      return res.status(result.statusCode).json(result.body);
    case 'locked': {
      const retryHint = retryCount > 0 ? '; client will retry after retryAfter' : '; client can retry after retryAfter';
      pushLog('lock_fail', `[#${seq}] Lock denied: userId=${userId} blocked (oversell prevented)${retryHint}`, {
        seq,
        requestId,
        skuId,
        userId,
        result: 'SKU_LOCKED',
        retryAfter: LOCK_TTL,
        ...(retryCount ? { retryAttempt: retryCount } : {}),
        hint: 'Lock held by another request; skip backend call',
      });
      return res.status(result.statusCode).json(result.body);
    }
    case 'success': {
      pushLog('lock_ok', `[#${seq}] Lock acquired: userId=${userId} entering mock checkout (only winner hits backend)`, {
        seq,
        requestId,
        skuId,
        userId,
        mockShopifyUserId: userId,
        ttl: LOCK_TTL,
      });
      if (simulateNoRelease) {
        pushLog('info', `[#${seq}] Demo: will not release lock so you can see "Lock released by TTL expiry" in ${LOCK_TTL}s`, { seq, skuId, userId });
      }
      pushLog('info', `[#${seq}] Mock checkout start`, { seq, requestId, skuId, userId });
      pushLog('shopify', `[#${seq}] Mock checkout success: mockShopifyUserId=${result.body.userId} orderId=${result.body.orderId}`, {
        seq,
        requestId,
        skuId,
        mockShopifyUserId: result.body.userId,
        orderId: result.body.orderId,
        note: 'Only one request can checkout; others are blocked with 409',
      });
      if (simulateNoRelease) {
        pushLog('release', `[#${seq}] Lock not released (demo). Wait ${LOCK_TTL}s to see "Lock released by TTL expiry"`, { seq, skuId, userId, ttl: LOCK_TTL });
      } else {
        pushLog('release', `[#${seq}] Lock release ok: checkout:lock:${skuId}`, { seq, requestId, skuId, userId });
      }
      if (idempotencyKey) {
        pushLog('info', `[#${seq}] Idempotency stored`, {
          seq,
          requestId,
          skuId,
          userId,
          idempotencyKey,
          ttlSeconds: IDEMPOTENCY_TTL,
          orderId: result.body.orderId,
        });
      }
      return res.status(result.statusCode).json(result.body);
    }
    case 'checkout_failed':
      console.error('Checkout error:', result.body.message);
      pushLog('release', `[#${seq}] Checkout failed; lock released`, { seq, requestId, skuId, userId, error: result.body.message });
      return res.status(result.statusCode).json(result.body);
    default:
      return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Unknown outcome' });
  }
});

app.get('/health', async (req, res) => {
  try {
    await redis.ping();
    res.json({ ok: true, redis: 'connected' });
  } catch (e) {
    res.status(503).json({ ok: false, redis: e.message });
  }
});

app.get('/api/metrics', (req, res) => {
  res.type('application/json').json(metrics.get());
});

app.get('/api/logs', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({ logs: logBuffer.slice(-limit) });
});

app.delete('/api/logs', (req, res) => {
  clearLogs();
  res.json({ ok: true, message: 'Logs cleared' });
});

app.get('/demo', (req, res) => {
  res.type('text/html').send(getDemoHtml());
});

function getDemoHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Redis Lock Demo - Live Logs</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: ui-monospace, monospace; background: #1a1a2e; color: #eaeaea; margin: 0; padding: 1rem; }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; color: #a0e7ff; }
    .sub { color: #888; font-size: 0.85rem; margin-bottom: 1rem; }
    .controls { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem; }
    button { padding: 0.5rem 1rem; border: 1px solid #444; background: #2d2d44; color: #eaeaea; border-radius: 6px; cursor: pointer; font-size: 0.9rem; }
    button:hover { background: #3d3d54; }
    button.primary { background: #0d7377; border-color: #0d7377; }
    button.primary:hover { background: #0e8488; }
    #log { background: #0f0f1a; border: 1px solid #333; border-radius: 8px; padding: 0.75rem; height: 60vh; overflow-y: auto; font-size: 0.8rem; line-height: 1.5; white-space: pre-wrap; word-break: break-all; }
    .log-line { margin: 0.15rem 0; padding: 0.1rem 0; border-bottom: 1px solid #222; }
    .log-line.lock_ok { color: #7bed9f; }
    .log-line.lock_fail { color: #ff6b81; }
    .log-line.release { color: #70a1ff; }
    .log-line.shopify { color: #ffd93d; font-weight: 600; }
    .log-line.warn { color: #ffa502; }
    .log-line .time { color: #666; margin-right: 0.5rem; }
    .status { margin-top: 0.5rem; font-size: 0.8rem; color: #888; }
  </style>
</head>
<body>
  <h1>Oversell Prevention Demo - Live Logs</h1>
  <p class="sub">Every mock user request attempts a Redis lock. Only <strong>one userId</strong> acquires the lock and enters mock checkout; all others are blocked with HTTP 409. The log shows the winning <strong>mockShopifyUserId</strong> and <strong>orderId</strong>.</p>
  <div class="controls">
    <button class="primary" onclick="sendOne()">Send 1 checkout request</button>
    <button onclick="sendOneNoRelease()">Send 1 (no release) see &quot;Lock released by TTL expiry&quot; after TTL</button>
    <button onclick="sendConcurrent(5)">Send 5 concurrent (only 1 wins the lock)</button>
    <button onclick="sendConcurrentWithRetry(5)">Send 5 with retry (blocked users retry every 2s)</button>
    <button onclick="clearLog()">Clear log view</button>
  </div>
  <div id="log"></div>
  <div class="status" id="status"></div>
  <script>
    const logEl = document.getElementById('log');
    const statusEl = document.getElementById('status');
    let refreshIntervalId = null;
    let pollController = null;

    function render(logs) {
      logEl.innerHTML = logs.slice(-150).map(l => {
        const cls = l.level || 'info';
        return '<div class="log-line ' + cls + '"><span class="time">[' + l.time + ']</span> ' + (l.detail ? l.message + ' ' + JSON.stringify(l.detail) : l.message) + '</div>';
      }).join('');
      logEl.scrollTop = logEl.scrollHeight;
    }

    function fetchLogs() {
      if (pollController) pollController.abort();
      pollController = new AbortController();
      fetch('/api/logs?limit=200', { signal: pollController.signal }).then(r => r.json()).then(d => {
        render(d.logs);
        statusEl.textContent = 'Logs: ' + d.logs.length + ' entries (refresh every 2s)';
      }).catch(e => {
        if (e && e.name === 'AbortError') return;
        statusEl.textContent = 'Failed to fetch logs: ' + e.message;
      });
    }

    function startRefresh() {
      if (refreshIntervalId) return;
      refreshIntervalId = setInterval(fetchLogs, 2000);
      fetchLogs();
    }

    function stopRefresh() {
      if (refreshIntervalId) {
        clearInterval(refreshIntervalId);
        refreshIntervalId = null;
      }
      if (pollController) {
        pollController.abort();
        pollController = null;
      }
    }

    async function deleteServerLogs() {
      try { await fetch('/api/logs', { method: 'DELETE' }); } catch (_) {}
    }

    async function clearLog() {
      stopRefresh();
      await deleteServerLogs();
      logEl.innerHTML = '';
      statusEl.textContent = 'Cleared. Press "Send 1" or "Send 5 concurrent" to resume.';
    }

    async function resetAndResume() {
      await deleteServerLogs();
      logEl.innerHTML = '';
      startRefresh();
    }

    startRefresh();

    async function sendOne() {
      await resetAndResume();
      statusEl.textContent = 'Sending...';
      try {
        const r = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skuId: 'SKU-001', userId: 'demo-' + crypto.randomUUID() }) });
        const j = await r.json();
        statusEl.textContent = r.ok ? 'OK: ' + (j.orderId || '') : 'BLOCKED: ' + (j.code || r.status) + ' ' + (j.message || '');
      } catch (e) { statusEl.textContent = 'Request failed: ' + e.message; }
    }

    async function sendOneNoRelease() {
      await resetAndResume();
      statusEl.textContent = 'Sending (no release) — wait for TTL to see expiry log...';
      try {
        const r = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Simulate-No-Release': '1' }, body: JSON.stringify({ skuId: 'SKU-001', userId: 'demo-' + crypto.randomUUID() }) });
        const j = await r.json();
        statusEl.textContent = r.ok ? 'OK (lock not released). After TTL you will see "Lock released by TTL expiry"' : 'BLOCKED: ' + (j.code || r.status);
      } catch (e) { statusEl.textContent = 'Request failed: ' + e.message; }
    }

    async function sendConcurrent(n) {
      await resetAndResume();
      statusEl.textContent = 'Sending ' + n + ' concurrently...';
      const ids = Array.from({ length: n }, () => 'user-' + crypto.randomUUID());
      const results = await Promise.all(ids.map(async (userId) => {
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 30)));
        const r = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skuId: 'SKU-001', userId }) });
        const j = await r.json().catch(() => ({}));
        return { status: r.status, ...j, userId };
      }));
      const ok = results.filter(x => x.status === 200).length;
      const blocked = results.filter(x => x.code === 'SKU_LOCKED').length;
      statusEl.textContent = 'OK: ' + ok + ' | BLOCKED(409): ' + blocked + ' (see logs above)';
    }

    async function sendConcurrentWithRetry(n) {
      await resetAndResume();
      const RETRY_INTERVAL_MS = 2000;
      const MAX_RETRIES = 5;
      const ids = Array.from({ length: n }, () => 'user-' + crypto.randomUUID());
      statusEl.textContent = 'Sending ' + n + ' with retry (blocked users retry every ' + (RETRY_INTERVAL_MS / 1000) + 's)...';

      async function oneUserWithRetry(userId) {
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          const headers = { 'Content-Type': 'application/json' };
          if (attempt > 0) headers['X-Retry-Count'] = String(attempt);
          const r = await fetch('/api/checkout', { method: 'POST', headers, body: JSON.stringify({ skuId: 'SKU-001', userId }) });
          const j = await r.json().catch(() => ({}));
          if (r.status === 200) return { userId, status: 200, attempts: attempt + 1, orderId: j.orderId };
          if (j.code !== 'SKU_LOCKED') return { userId, status: r.status, attempts: attempt + 1 };
          if (attempt < MAX_RETRIES) await new Promise(x => setTimeout(x, RETRY_INTERVAL_MS));
        }
        return { userId, status: 409, attempts: MAX_RETRIES + 1 };
      }

      const results = await Promise.all(ids.map((id) => oneUserWithRetry(id)));
      const ok = results.filter((r) => r.status === 200);
      const blocked = results.filter((r) => r.status === 409);
      statusEl.textContent = 'OK: ' + ok.length + ' (retries: ' + ok.map((r) => r.attempts).join(',') + ') | BLOCKED after max retries: ' + blocked.length;
    }
  </script>
</body>
</html>`;
}

const server = app.listen(PORT, () => {
  pushLog('info', `API started on http://localhost:${PORT}`, { port: PORT });
  console.log(`API: http://localhost:${PORT}`);
  console.log('  POST /api/checkout  { "skuId", "userId" }');
  console.log('  GET  /health   GET  /api/metrics   GET  /api/logs   GET  /demo');
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} in use. Stop the other process or run: PORT=3001 npm start`);
    process.exit(1);
  }
  throw err;
});
