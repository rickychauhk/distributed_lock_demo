/**
 * Mock Shopify checkout adapter (demo). No real API call.
 */

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function checkout(skuId, userId) {
  const ms = 200 + Math.floor(Math.random() * 300);
  await delay(ms);
  return {
    orderId: `order-${Date.now()}-${userId.slice(-4)}`,
    skuId,
    userId,
    message: 'Mock checkout success (no real Shopify call)',
  };
}

module.exports = { checkout };
