import { getOrderStore } from './order-store.js';
import { loadStore } from './store.js';
import { stripeGet } from './stripe.js';
import { fulfillOrder } from './fulfillment.js';
import { upsertSubscriber, CONSENT } from './subscribers.js';
import { queueConfirmation, queueThreepl, queueShipping, dispatchDue, dispatchShipping, trackingUrl } from './email.js';

// Payment state and fulfillment state are tracked separately.
// payment: pending | paid | failed | expired | refunded (full refund; partial refunds keep 'paid')
// fulfillment: not_ready | queued | handoff_pending | partially_shipped | shipped | cancelled
// Lines are grouped by fulfiller (order.groups.<fulfiller>): warehouse (3PL, hand-packed) and printify.
// Every order is a ledger row: number, subtotal, discount, shipping, tax, total, Stripe fee, net, refunds.

const THREEPL_BRAND = 'default'; // only Fruity Puppy warehouse lines go to the Arizona 3PL

function findVariant(catalog, sku) {
  for (const p of catalog.products) {
    const v = p.variants.find(x => x.sku === sku);
    if (v) return { product: p, variant: v };
  }
  return null;
}
const prefixFor = brand => (!brand || brand === 'default') ? 'FP' : brand.slice(0, 2).toUpperCase();
export const formatOrderNumber = (seq, brand) => `${prefixFor(brand)}-${1000 + Number(seq)}`;

// Marketing opt-in at checkout: Stripe's promotions checkbox, or our fp_emails dropdown (default "no").
export function promoConsent(session) {
  const field = (session.custom_fields || []).find(f => f?.key === 'fp_emails');
  const dropdown = field ? (field.dropdown?.value || 'no') : null;
  const promotions = session.consent?.promotions ?? null;
  const method = session.consent_collection?.promotions ? 'stripe_promotions' : field ? 'custom_field' : 'none';
  return { promotions, dropdown, method, opted_in: promotions === 'opt_in' || dropdown === 'yes' };
}
function customNotes(session) {
  return (session.custom_fields || []).filter(f => f?.key !== 'fp_emails').map(f => f?.text?.value || f?.dropdown?.value || '').filter(Boolean).join(' | ') || null;
}

// Builds order lines from Stripe's own record of the session (server-trusted),
// matched back to the catalog by SKU stored in metadata at checkout.
export async function buildOrderFromSession(session, { stripeKey, fetchImpl } = {}) {
  const brand = session.metadata?.brand || undefined;
  const { config, catalog } = loadStore(brand);
  const brandKey = brand || 'default';
  const li = await stripeGet(
    `/checkout/sessions/${encodeURIComponent(session.id)}/line_items?limit=100&expand[]=data.price.product`,
    stripeKey, fetchImpl,
  );
  const items = li.data.map(line => {
    const sku = line.price?.metadata?.sku || line.price?.product?.metadata?.sku || null;
    const match = sku ? findVariant(catalog, sku) : null;
    const fulfiller = match?.product.fulfiller || config.default_fulfiller || 'warehouse';
    const adapter = config.fulfillers?.[fulfiller]?.adapter || 'manual';
    return {
      sku,
      title: line.description,
      quantity: line.quantity,
      unit_amount_cents: line.price?.unit_amount ?? null,
      amount_subtotal_cents: line.amount_subtotal ?? null,
      amount_discount_cents: line.amount_discount ?? 0,
      amount_tax_cents: line.amount_tax ?? 0,
      amount_total_cents: line.amount_total,
      note: match?.product.checkout_note || null,
      fulfiller,
      fulfiller_adapter: adapter,
      threepl: brandKey === THREEPL_BRAND && fulfiller === 'warehouse' && adapter === 'manual',
      threepl_note: match?.product.threepl_note || null,
      printify_product_id: match?.variant.printify_product_id || null,
      printify_variant_id: match?.variant.printify_variant_id || null,
      unmatched: !match,
    };
  });
  const details = session.customer_details || {};
  const ship = session.shipping_details || session.collected_information?.shipping_details || {};
  const td = session.total_details || {};
  const groups = {};
  for (const i of items) groups[i.fulfiller] ||= { status: 'pending', adapter: i.fulfiller_adapter };
  return {
    id: session.id,
    brand: brandKey,
    livemode: !!session.livemode,
    created_at_ms: (session.created || Math.floor(Date.now() / 1000)) * 1000,
    currency: session.currency,
    amount_subtotal_cents: session.amount_subtotal ?? null,
    amount_discount_cents: td.amount_discount ?? 0,
    amount_shipping_cents: td.amount_shipping ?? null,
    amount_tax_cents: td.amount_tax ?? 0,
    amount_total_cents: session.amount_total,
    amount_refunded_cents: 0,
    stripe_fee_cents: null,
    net_cents: null,
    payment_intent: session.payment_intent || null,
    email: details.email || null,
    phone: details.phone || null,
    notes: customNotes(session),
    shipping: { name: ship.name || details.name || null, address: ship.address || details.address || null },
    items,
    groups,
    shipments: [],
    payment: 'pending',
    fulfillment: 'not_ready',
    history: [],
  };
}

const PAYMENT_FOR_EVENT = {
  'checkout.session.completed': s => (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') ? 'paid' : 'pending',
  'checkout.session.async_payment_succeeded': () => 'paid',
  'checkout.session.async_payment_failed': () => 'failed',
  'checkout.session.expired': () => 'expired',
};
export const HANDLED_EVENTS = [...Object.keys(PAYMENT_FOR_EVENT), 'charge.refunded'];

export function computeFulfillment(order) {
  if (order.payment === 'paid' || order.payment === 'refunded') {
    if (order.payment === 'refunded' && order.fulfillment === 'not_ready') return 'cancelled';
    const gs = Object.values(order.groups || {});
    if (!gs.length) return order.fulfillment === 'not_ready' ? 'queued' : order.fulfillment;
    const shipped = gs.filter(g => g.status === 'shipped').length;
    if (shipped === gs.length) return 'shipped';
    if (shipped) return 'partially_shipped';
    return gs.some(g => g.adapter === 'printify') ? 'handoff_pending' : 'queued';
  }
  if (order.payment === 'failed' || order.payment === 'expired') return order.fulfillment === 'not_ready' ? 'cancelled' : order.fulfillment;
  return order.fulfillment;
}

// Stripe fee and net from the balance transaction. Best effort: never fails the webhook.
async function captureFees(order, { stripeKey, fetchImpl }) {
  if (!order.payment_intent || order.stripe_fee_cents != null) return;
  try {
    const pi = await stripeGet(`/payment_intents/${encodeURIComponent(order.payment_intent)}?expand[]=latest_charge.balance_transaction`, stripeKey, fetchImpl);
    const ch = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
    const bt = ch?.balance_transaction && typeof ch.balance_transaction === 'object' ? ch.balance_transaction : null;
    if (ch?.id) order.charge_id = ch.id;
    if (bt && Number.isFinite(bt.fee)) { order.stripe_fee_cents = bt.fee; order.net_cents = bt.net; }
  } catch { /* fee stays null; visible in admin/CSV as blank */ }
}

// Creates the Printify order for the Printify lines only (mixed carts keep warehouse lines for the 3PL).
// Never sends to production unless the fulfiller config says so (it is false). Never fails the webhook.
export async function submitPrintify(order, store, { fulfill = fulfillOrder } = {}) {
  const g = order.groups?.printify;
  if (!g || order.payment !== 'paid' || g.printify_order_id || g.status === 'shipped') return { skipped: true };
  const { config } = loadStore(order.brand === 'default' ? undefined : order.brand);
  const fcfg = config.fulfillers?.printify || { adapter: 'printify' };
  if (!process.env[fcfg.token_env || 'PRINTIFY_TOKEN'] || !process.env[fcfg.shop_id_env || 'PRINTIFY_SHOP_ID']) {
    g.status = 'not_configured';
  } else {
    try {
      const r = await fulfill({ ...order, items: order.items.filter(i => i.fulfiller === 'printify') }, fcfg);
      Object.assign(g, { status: 'submitted', printify_order_id: r.printify_order_id, sent_to_production: !!fcfg.send_to_production, submitted_at: new Date().toISOString(), last_error: null });
      if (r.printify_order_id) await store.setAlias(`pfy:${r.printify_order_id}`, order.id);
    } catch (err) {
      Object.assign(g, { status: 'failed', attempts: (g.attempts || 0) + 1, last_error: String(err.message).slice(0, 200) });
    }
  }
  order.history.push({ event: 'printify', status: g.status, at: new Date().toISOString() });
  await store.putOrder(order);
  return { status: g.status };
}

async function applyRefund(event, store) {
  const ch = event.data.object || {};
  const id = (ch.payment_intent && await store.getAlias(`pi:${ch.payment_intent}`)) || (ch.id && await store.getAlias(`ch:${ch.id}`));
  const order = id ? await store.getOrder(id) : null;
  if (!order) return { ignored: true, reason: 'refund_without_order' };
  order.amount_refunded_cents = ch.amount_refunded ?? order.amount_refunded_cents;
  order.refunds = (ch.refunds?.data || []).map(r => ({ id: r.id, amount_cents: r.amount, status: r.status, reason: r.reason || null, created_at_ms: (r.created || 0) * 1000 }));
  if (ch.refunded || (ch.amount && ch.amount_refunded >= ch.amount)) order.payment = 'refunded';
  order.fulfillment = computeFulfillment(order);
  order.history.push({ event: event.type, event_id: event.id, amount_refunded_cents: order.amount_refunded_cents, at: new Date().toISOString() });
  await store.putOrder(order);
  return { order_id: order.id, payment: order.payment, refunded_cents: order.amount_refunded_cents };
}

// Idempotent: replays of an event id are ignored; out-of-order events never downgrade paid.
export async function applyCheckoutEvent(event, { store = getOrderStore(), stripeKey = process.env.STRIPE_SECRET_KEY, fetchImpl, emailFetch, emailCfg, fulfill } = {}) {
  if (!store) { const e = new Error('Order store not configured'); e.status = 503; throw e; }
  const isRefund = event.type === 'charge.refunded';
  const map = PAYMENT_FOR_EVENT[event.type];
  if (!map && !isRefund) return { ignored: true };
  if (!(await store.claimEvent(event.id))) return { duplicate: true };
  let order;
  try {
    if (isRefund) return await applyRefund(event, store);
    const session = event.data.object;
    order = await store.getOrder(session.id);
    if (!order) {
      if (event.type === 'checkout.session.expired') {
        await store.releaseEvent(event.id);
        return { ignored: true, reason: 'expired_without_order' };
      }
      order = await buildOrderFromSession(session, { stripeKey, fetchImpl });
      order.order_number = formatOrderNumber(await store.nextOrderSeq(), order.brand);
      if (order.payment_intent) await store.setAlias(`pi:${order.payment_intent}`, order.id);
    }
    const was = order.payment;
    const target = map(session);
    if (!((was === 'paid' || was === 'refunded') && target !== 'paid')) order.payment = was === 'refunded' ? was : target;
    if (order.payment === 'paid' && was !== 'paid') {
      await captureFees(order, { stripeKey, fetchImpl });
      if (order.charge_id) await store.setAlias(`ch:${order.charge_id}`, order.id).catch(() => {});
    }
    order.fulfillment = computeFulfillment(order);
    if (event.type === 'checkout.session.completed') order.consent = promoConsent(session);
    order.history.push({ event: event.type, event_id: event.id, at: new Date().toISOString() });
    queueConfirmation(order);
    queueThreepl(order);
    await store.putOrder(order);
  } catch (err) {
    await store.releaseEvent(event.id).catch(() => {});
    throw err;
  }
  // Buyers who ticked Stripe's promotional-emails box join the list (Fruity Puppy only). Best effort.
  if (event.type === 'checkout.session.completed' && order.consent?.opted_in && order.email && order.brand === 'default') {
    const skus = [...new Set(order.items.map(i => i.sku).filter(Boolean))].join('+') || 'unknown';
    await upsertSubscriber(store, { email: order.email.trim().toLowerCase(), source: `checkout:${skus}`, consent: order.consent.promotions === 'opt_in' ? CONSENT.checkout : CONSENT.checkout_field }).catch(() => {});
  }
  // Order is durably recorded first; email and Printify problems never fail the webhook.
  await dispatchDue(order, store, { fetchImpl: emailFetch, ...(emailCfg ? { cfg: emailCfg } : {}) }).catch(() => {});
  await submitPrintify(order, store, fulfill ? { fulfill } : {}).catch(() => {});
  return { order_id: order.id, order_number: order.order_number, payment: order.payment, fulfillment: order.fulfillment };
}

// Marks one fulfiller group shipped (3PL link, admin, or Printify webhook) and emails the customer.
export async function recordShipment(orderOrId, group, tracking, { store = getOrderStore(), source = 'admin', emailFetch, emailCfg } = {}) {
  if (!store) { const e = new Error('Order store not configured'); e.status = 503; throw e; }
  const order = typeof orderOrId === 'string' ? await store.getOrder(orderOrId) : orderOrId;
  if (!order) return null;
  order.groups ||= {};
  order.shipments ||= [];
  const g = order.groups[group] ||= { status: 'pending' };
  const number = String(tracking.tracking_number || '').trim();
  const dup = order.shipments.find(s => s.group === group && s.tracking_number === number);
  if (dup) return { order, shipment: dup, duplicate: true };
  const carrier = String(tracking.carrier || 'other').toLowerCase();
  const shipment = {
    group,
    carrier,
    tracking_number: number,
    tracking_url: trackingUrl(carrier, number, tracking.tracking_url),
    source,
    at: new Date().toISOString(),
  };
  order.shipments.push(shipment);
  Object.assign(g, { status: 'shipped', shipped_at: shipment.at });
  order.tracking = { carrier: shipment.carrier, tracking_number: number, tracking_url: shipment.tracking_url, fulfiller: group, at: shipment.at };
  order.fulfillment = computeFulfillment(order);
  order.history.push({ event: 'shipped', group, source, at: shipment.at });
  queueShipping(order, shipment);
  await store.putOrder(order);
  await dispatchShipping(order, shipment, store, { fetchImpl: emailFetch, ...(emailCfg ? { cfg: emailCfg } : {}) }).catch(() => {});
  return { order, shipment };
}

// Back-compat wrapper used by older callers.
export async function recordTracking(orderId, fulfiller, tracking, opts = {}) {
  const r = await recordShipment(orderId, fulfiller, tracking, { ...opts, source: fulfiller });
  return r ? r.order.tracking : null;
}
