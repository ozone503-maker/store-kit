import { json, requireBearer } from '../lib/http.js';
import { getOrderStore } from '../lib/order-store.js';
import { dispatchDue, hasDue, emailConfig, canSend, canSendThreepl, requeue, CARRIERS, dispatchConfirmation, dispatchThreepl, dispatchShipping } from '../lib/email.js';
import { recordShipment, submitPrintify } from '../lib/orders.js';
import { ordersCsv } from '../lib/ledger.js';

// Operator API for /admin. Every call requires Authorization: Bearer $ADMIN_TOKEN.
// GET  ?payment=&fulfillment=&q=&limit=   -> { orders }
// GET  ?format=csv                        -> ledger CSV (same filters)
// POST {}                                 -> retry every due email (no-op while sending is disabled)
// POST { action:'ship', id, group, carrier, tracking_number, tracking_url? }
// POST { action:'resend', id, kind: confirmation|threepl|shipping }
// POST { action:'printify', id }          -> retry creating the Printify order
function matches(o, { payment, fulfillment, q }) {
  if (payment && o.payment !== payment) return false;
  if (fulfillment && o.fulfillment !== fulfillment) return false;
  if (q) {
    const hay = [o.order_number, o.id, o.email, o.shipping?.name, o.phone, ...(o.items || []).map(i => i.sku)].join(' ').toLowerCase();
    if (!hay.includes(q.toLowerCase())) return false;
  }
  return true;
}

export async function GET(request, deps = {}) {
  const denied = requireBearer(request, 'ADMIN_TOKEN');
  if (denied) return denied;
  const store = deps.store !== undefined ? deps.store : getOrderStore();
  if (!store) return json({ error: 'Order store not configured' }, 503);
  const url = new URL(request.url);
  const csv = url.searchParams.get('format') === 'csv';
  const max = csv ? 5000 : 500;
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || (csv ? String(max) : '100'), 10) || 100, 1), max);
  const f = { payment: url.searchParams.get('payment') || '', fulfillment: url.searchParams.get('fulfillment') || '', q: (url.searchParams.get('q') || '').trim() };
  const ids = await store.listOrderIds(limit);
  const orders = [];
  for (const id of ids) {
    const o = await store.getOrder(id);
    if (o && matches(o, f)) orders.push(o);
  }
  if (csv) {
    const day = new Date().toISOString().slice(0, 10);
    return new Response(ordersCsv(orders), { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="fruity-puppy-orders-${day}.csv"`, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
  }
  const cfg = deps.cfg || emailConfig();
  return json({ orders, email: { customer: canSend(cfg), threepl: canSendThreepl(cfg) } });
}

export async function POST(request, deps = {}) {
  const denied = requireBearer(request, 'ADMIN_TOKEN');
  if (denied) return denied;
  const store = deps.store !== undefined ? deps.store : getOrderStore();
  if (!store) return json({ error: 'Order store not configured' }, 503);
  const cfg = deps.cfg || emailConfig();
  let body = {};
  try { const t = await request.text(); body = t ? JSON.parse(t) : {}; } catch { return json({ error: 'Bad JSON' }, 400); }
  const opts = { cfg, fetchImpl: deps.fetchImpl };

  if (body.action === 'ship') {
    const carrier = String(body.carrier || '').toLowerCase();
    const number = String(body.tracking_number || '').trim();
    if (!CARRIERS[carrier]) return json({ error: 'Pick a carrier' }, 400);
    if (!/^[A-Za-z0-9 -]{4,64}$/.test(number)) return json({ error: 'Tracking number looks wrong' }, 400);
    const order = await store.getOrder(String(body.id || ''));
    if (!order) return json({ error: 'Order not found' }, 404);
    const group = String(body.group || 'warehouse');
    if (!(order.items || []).some(i => i.fulfiller === group)) return json({ error: 'No lines for that fulfiller' }, 400);
    const r = await recordShipment(order, group, { carrier, tracking_number: number, tracking_url: body.tracking_url }, { store, source: 'admin', emailFetch: deps.fetchImpl, emailCfg: cfg });
    return json({ ok: true, duplicate: !!r.duplicate, fulfillment: r.order.fulfillment, shipment: r.shipment });
  }
  if (body.action === 'resend') {
    const order = await store.getOrder(String(body.id || ''));
    if (!order) return json({ error: 'Order not found' }, 404);
    const kind = body.kind;
    const boxes = kind === 'confirmation' ? [order.confirmation_email]
      : kind === 'threepl' ? [order.threepl_email]
      : kind === 'shipping' ? (order.shipments || []).map(s => s.email) : [];
    const live = boxes.filter(Boolean);
    if (!live.length) return json({ error: 'Nothing to resend' }, 400);
    live.forEach(requeue);
    await store.putOrder(order);
    const enabled = kind === 'threepl' ? canSendThreepl(cfg) : canSend(cfg);
    let result = { sending: 'disabled', queued: true };
    if (enabled) {
      if (kind === 'confirmation') result = await dispatchConfirmation(order, store, opts);
      else if (kind === 'threepl') result = await dispatchThreepl(order, store, opts);
      else { result = { shipping: [] }; for (const s of (order.shipments || []).filter(x => x.email)) result.shipping.push(await dispatchShipping(order, s, store, opts)); }
    }
    return json({ ok: true, result });
  }
  if (body.action === 'printify') {
    const order = await store.getOrder(String(body.id || ''));
    if (!order) return json({ error: 'Order not found' }, 404);
    if (order.groups?.printify && order.groups.printify.status !== 'submitted') order.groups.printify.status = 'pending';
    return json({ ok: true, result: await submitPrintify(order, store, deps.fulfill ? { fulfill: deps.fulfill } : {}) });
  }

  // Default: retry every due email. No-op while sending is disabled.
  if (!canSend(cfg) && !canSendThreepl(cfg)) return json({ sending: 'disabled', attempted: 0 });
  const ids = await store.listOrderIds(200);
  const results = [];
  for (const id of ids) {
    const o = await store.getOrder(id);
    if (o && hasDue(o)) {
      const r = await dispatchDue(o, store, opts);
      results.push({ id, ...(r.confirmation || {}), ...(r.threepl ? { threepl: r.threepl.status || r.threepl.reason } : {}), ...(r.shipping ? { shipping: r.shipping.map(x => x.status || x.reason) } : {}) });
    }
  }
  return json({ sending: 'enabled', attempted: results.length, results });
}
