/**
 * Real Shopify checkout adapter (placeholder).
 * Swap in when integrating with actual Shopify API.
 *
 * Interface: checkout(skuId, userId) => Promise<{ orderId, skuId, userId, ... }>
 */

async function checkout(skuId, userId) {
  throw new Error('RealShopifyAdapter not implemented. Use MockShopifyAdapter for demo.');
}

module.exports = { checkout };
