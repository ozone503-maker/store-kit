import { json } from '../lib/http.js';
import { getOrderStore } from '../lib/order-store.js';

// Public, minimal: given the unguessable Checkout Session id from the redirect, returns the
// payment/fulfillment state plus the order number, item titles/quantities and total for the
// thank-you page. No email, name, address, phone or payment identifiers.
export async function GET(request, deps = {}) {
  const id = new URL(request.url).searchParams.get('session_id') || '';
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(id)) return json({ status: 'unknown' }, 400);
  const store = deps.store !== undefined ? deps.store : getOrderStore();
  if (!store) return json({ status: 'unknown' });
  try {
    const order = await store.getOrder(id);
    if (!order) return json({ status: 'processing' });
    return json({
      status: order.payment,
      fulfillment: order.fulfillment,
      order_number: order.order_number || null,
      currency: order.currency || 'usd',
      total_cents: order.amount_total_cents ?? null,
      items: (order.items || []).map(i => ({ title: i.title, quantity: i.quantity, amount_total_cents: i.amount_total_cents, note: i.note || null })),
    });
  } catch {
    return json({ status: 'unknown' });
  }
}
