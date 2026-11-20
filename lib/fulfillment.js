import { PrintifyClient } from './printify.js';

const adapters = {
  manual: {
    async fulfill(order, config) {
      console.log('Manual fulfill for', order.id);
      return { status: 'manual', note: 'Warehouse will handle' };
    },
  },
  printify: {
    async fulfill(order, config, { fetchImpl } = {}) {
      const client = new PrintifyClient({
        fetchImpl,
        token: process.env[config.token_env || 'PRINTIFY_TOKEN'],
        shopId: process.env[config.shop_id_env || 'PRINTIFY_SHOP_ID'],
      });
      const payload = printifyPayload(order);
      const created = await client.createOrder(payload);
      if (config.send_to_production) {
        await client.sendToProduction(created.id);
      }
      return { status: 'submitted', printify_order_id: created.id };
    },
  },
};

export async function fulfillOrder(order, fulfillerConfig, opts = {}) {
  const adapterName = fulfillerConfig.adapter || 'manual';
  const adapter = adapters[adapterName];
  if (!adapter) throw new Error(`Unknown adapter: ${adapterName}`);
  return adapter.fulfill(order, fulfillerConfig, opts);
}

// Order record -> Printify address. Orders store Stripe's shape: shipping.name + shipping.address
// { line1, line2, city, state, postal_code, country }; phone and email sit on the order.
export function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first_name: 'Customer', last_name: '' };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}
export function printifyPayload(order) {
  const line_items = [];
  for (const item of order.items || []) {
    if (item.fulfiller_adapter && item.fulfiller_adapter !== 'printify') continue;
    if (!item.printify_product_id || !item.printify_variant_id) {
      throw new Error(`Missing printify_product_id or printify_variant_id for ${item.sku}`);
    }
    line_items.push({ product_id: item.printify_product_id, variant_id: Number(item.printify_variant_id), quantity: item.quantity || 1 });
  }
  if (!line_items.length) throw new Error('No Printify items in order');
  const a = order.shipping?.address || {};
  if (!a.line1 || !a.city || !a.postal_code) throw new Error('Shipping address incomplete');
  return {
    external_id: order.id,
    label: order.order_number || order.id,
    line_items,
    shipping_method: 1,
    send_shipping_notification: false, // we email tracking ourselves
    address_to: {
      ...splitName(order.shipping?.name),
      email: order.email || 'fruitypuppyskincream@gmail.com',
      phone: order.phone || '',
      country: a.country || 'US',
      region: a.state || '',
      address1: a.line1 || '',
      address2: a.line2 || '',
      city: a.city || '',
      zip: a.postal_code || '',
    },
  };
}
