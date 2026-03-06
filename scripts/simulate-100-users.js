const BASE = process.env.API_BASE || 'http://localhost:3000';
const SKU = process.env.DEMO_SKU || 'SKU-001';
const CONCURRENT = Number(process.env.CONCURRENT) || 100;

async function oneRequest(userIndex) {
  const userId = `user-${String(userIndex).padStart(3, '0')}`;
  const start = Date.now();
  try {
    const res = await fetch(`${BASE}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skuId: SKU, userId }),
    });
    const body = await res.json().catch(() => ({}));
    return {
      userId,
      status: res.status,
      code: body.code,
      duration: Date.now() - start,
      body,
    };
  } catch (err) {
    return {
      userId,
      status: 0,
      code: 'ERROR',
      duration: Date.now() - start,
      error: err.message,
    };
  }
}

async function main() {
  console.log(`\nSimulating ${CONCURRENT} users racing for SKU: ${SKU}`);
  console.log(`API: ${BASE}/api/checkout\n`);

  const start = Date.now();
  const promises = Array.from({ length: CONCURRENT }, (_, i) => oneRequest(i + 1));
  const results = await Promise.all(promises);
  const elapsed = Date.now() - start;

  const success = results.filter((r) => r.status === 200);
  const locked = results.filter((r) => r.status === 409);
  const errors = results.filter((r) => r.status !== 200 && r.status !== 409);

  console.log('--- Results ---');
  console.log(`Total time: ${elapsed}ms`);
  console.log(`200 OK (lock winner enters mock checkout): ${success.length}`);
  console.log(`409 SKU_LOCKED (blocked at API): ${locked.length}`);
  if (errors.length) console.log(`Other/errors: ${errors.length}`);

  if (success.length > 0) {
    console.log('\nWinner:', success[0].userId, success[0].body);
  }

  if (errors.length) {
    console.log('\nSample errors:');
    errors.slice(0, 5).forEach((e) => {
      const msg = e.error || e.body?.message || e.code || 'UNKNOWN';
      console.log(`- ${e.userId}: status=${e.status} ${msg}`);
    });
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
