import { getOrderStore } from '../lib/order-store.js';
import { verifyShipToken, emailConfig, esc, CARRIERS } from '../lib/email.js';
import { recordShipment } from '../lib/orders.js';

// One-time 3PL ship link: /store/ship/<order id>?t=<HMAC(SHIP_LINK_SECRET)>.
// GET shows a tiny form (carrier + tracking number); POST marks the warehouse lines shipped and
// triggers the customer's shipping email (if customer emails are enabled). Once used, it is closed.
const HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
const page = (title, body, status = 200) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>body{font-family:system-ui,Arial,sans-serif;max-width:520px;margin:40px auto;padding:0 16px;color:#251a1d;background:#fff8ef}h1{font-size:22px}label{display:block;margin:14px 0 4px;font-weight:600}select,input{width:100%;padding:10px;font-size:16px;border:1px solid #c9b8ae;border-radius:6px;box-sizing:border-box}button{margin-top:18px;background:#c45c4a;color:#fff;border:0;padding:12px 18px;font-size:16px;border-radius:6px;cursor:pointer}table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid #e8d9d0;padding:4px 8px;text-align:left}.muted{color:#6d5a5e;font-size:14px}.err{color:#a3271b}</style></head><body>${body}</body></html>`, { status, headers: HEADERS });

function itemsTable(lines) {
  return `<table><tr><th>SKU</th><th>Item</th><th>Qty</th><th>Note</th></tr>${lines.map(i => `<tr><td>${esc(i.sku)}</td><td>${esc(i.title)}</td><td>${esc(i.quantity)}</td><td>${esc(i.threepl_note || '')}</td></tr>`).join('')}</table>`;
}
function form(order, token, error = '') {
  const lines = (order.items || []).filter(i => i.fulfiller === 'warehouse');
  return page(`Ship ${order.order_number}`, `<h1>Mark order ${esc(order.order_number)} shipped</h1>
${itemsTable(lines)}
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post">
<input type="hidden" name="t" value="${esc(token)}">
<label for="carrier">Carrier</label>
<select id="carrier" name="carrier" required><option value="">Choose…</option>${Object.entries(CARRIERS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
<label for="tn">Tracking number</label>
<input id="tn" name="tracking_number" required minlength="4" maxlength="64" pattern="[A-Za-z0-9 \\-]{4,64}" autocomplete="off">
<label for="tu">Tracking link (only for Other)</label>
<input id="tu" name="tracking_url" type="url" placeholder="https://">
<button type="submit">Mark shipped and notify the customer</button>
</form><p class="muted">This link works once, for this order only.</p>`);
}

async function load(request, deps) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
  const secret = process.env.SHIP_LINK_SECRET;
  const store = deps.store !== undefined ? deps.store : getOrderStore();
  if (!secret || !store) return { res: page('Unavailable', '<h1>Shipping links are not set up yet.</h1>', 503) };
  return { id, secret, store, url };
}
const closed = (order) => {
  const s = (order.shipments || []).find(x => x.group === 'warehouse');
  return page('Already shipped', `<h1>Order ${esc(order.order_number)} is already marked shipped.</h1><p>${s ? `${esc(CARRIERS[s.carrier] || s.carrier)} ${esc(s.tracking_number)}` : ''}</p><p class="muted">Need a correction? Reply to the order email.</p>`);
};

export async function GET(request, deps = {}) {
  const ctx = await load(request, deps); if (ctx.res) return ctx.res;
  const t = ctx.url.searchParams.get('t') || '';
  if (!verifyShipToken(ctx.id, t, ctx.secret)) return page('Link not valid', '<h1>This link is not valid.</h1>', 403);
  const order = await ctx.store.getOrder(ctx.id);
  if (!order || !(order.items || []).some(i => i.fulfiller === 'warehouse')) return page('Not found', '<h1>Order not found.</h1>', 404);
  if (order.groups?.warehouse?.status === 'shipped') return closed(order);
  return form(order, t);
}

export async function POST(request, deps = {}) {
  const ctx = await load(request, deps); if (ctx.res) return ctx.res;
  const f = new URLSearchParams(await request.text());
  const t = f.get('t') || ctx.url.searchParams.get('t') || '';
  if (!verifyShipToken(ctx.id, t, ctx.secret)) return page('Link not valid', '<h1>This link is not valid.</h1>', 403);
  const order = await ctx.store.getOrder(ctx.id);
  if (!order || !(order.items || []).some(i => i.fulfiller === 'warehouse')) return page('Not found', '<h1>Order not found.</h1>', 404);
  if (order.groups?.warehouse?.status === 'shipped') return closed(order);
  const carrier = String(f.get('carrier') || '').toLowerCase();
  const number = String(f.get('tracking_number') || '').trim();
  const turl = String(f.get('tracking_url') || '').trim();
  if (!CARRIERS[carrier]) return form(order, t, 'Please choose a carrier.');
  if (!/^[A-Za-z0-9 -]{4,64}$/.test(number)) return form(order, t, 'That tracking number does not look right.');
  if (turl && !/^https:\/\/\S{4,300}$/i.test(turl)) return form(order, t, 'The tracking link must start with https://');
  await recordShipment(order, 'warehouse', { carrier, tracking_number: number, tracking_url: turl || null }, { store: ctx.store, source: '3pl_link', emailFetch: deps.emailFetch, emailCfg: deps.emailCfg || emailConfig() });
  return page('Thank you', `<h1>Thank you. Order ${esc(order.order_number)} is marked shipped.</h1><p>${esc(CARRIERS[carrier])} ${esc(number)}</p><p class="muted">The customer gets the tracking link by email.</p>`);
}
