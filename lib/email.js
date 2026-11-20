// Order emails, all sent through the Resend HTTP API and all OFF by default.
//   Customer emails (confirmation, shipping): ORDER_EMAILS_ENABLED=true + RESEND_API_KEY + ORDER_EMAIL_FROM
//   3PL warehouse emails: THREEPL_EMAILS_ENABLED=true + RESEND_API_KEY + ORDER_EMAIL_FROM + THREEPL_EMAIL + SHIP_LINK_SECRET
// Each email has an outbox record on the order ({ status: pending|sent|failed, attempts, ... }) and a
// Resend Idempotency-Key, so webhook retries never double-send. Failures stay 'failed' for admin retry.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (cents, cur = 'usd') => cents == null ? '' : new Intl.NumberFormat('en-US', { style: 'currency', currency: String(cur || 'usd').toUpperCase() }).format(cents / 100);
const DEFAULT_REPLY_TO = 'fruitypuppyskincream@gmail.com';
export const MAX_ATTEMPTS = 5;

export function emailConfig(env = process.env) {
  return {
    enabled: env.ORDER_EMAILS_ENABLED === 'true',
    threeplEnabled: env.THREEPL_EMAILS_ENABLED === 'true',
    apiKey: env.RESEND_API_KEY || '',
    from: env.ORDER_EMAIL_FROM || '',
    replyTo: env.ORDER_EMAIL_REPLY_TO || DEFAULT_REPLY_TO,
    threeplTo: env.THREEPL_EMAIL || '',
    shipSecret: env.SHIP_LINK_SECRET || '',
    publicBase: (env.STORE_PUBLIC_BASE || 'https://www.fruitypuppy.com/store').replace(/\/$/, ''),
  };
}
export function canSend(cfg) { return !!(cfg.enabled && cfg.apiKey && cfg.from); }
export function canSendThreepl(cfg) { return !!(cfg.threeplEnabled && cfg.apiKey && cfg.from && cfg.threeplTo && cfg.shipSecret); }

// ---------- signed one-time ship links for the 3PL ----------
export function shipToken(orderId, secret) {
  return createHmac('sha256', secret).update(`ship:${orderId}`).digest('base64url').slice(0, 32);
}
export function verifyShipToken(orderId, token, secret) {
  if (!secret || !token || !orderId) return false;
  const a = Buffer.from(String(token)); const b = Buffer.from(shipToken(orderId, secret));
  return a.length === b.length && timingSafeEqual(a, b);
}
export function shipLink(order, cfg) {
  return `${cfg.publicBase}/ship/${encodeURIComponent(order.id)}?t=${shipToken(order.id, cfg.shipSecret)}`;
}

// ---------- carriers ----------
export const CARRIERS = { usps: 'USPS', ups: 'UPS', fedex: 'FedEx', other: 'Other' };
export function trackingUrl(carrier, number, given) {
  const n = encodeURIComponent(String(number || '').trim());
  const c = String(carrier || '').toLowerCase();
  if (c.includes('usps')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`;
  if (c.includes('ups')) return `https://www.ups.com/track?tracknum=${n}`;
  if (c.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
  if (given && /^https:\/\//i.test(given)) return given;
  return null;
}

// ---------- rendering helpers ----------
const num = order => order.order_number || order.id.slice(0, 18);
function addressLines(order) {
  const s = order.shipping || {}; const a = s.address || {};
  return [s.name, a.line1, a.line2, [a.city, a.state, a.postal_code].filter(Boolean).join(', ').replace(/, (\d)/, ' $1'), a.country].filter(Boolean);
}
const lineNote = i => i.note ? ` (${i.note})` : '';
function totalsLines(order) {
  const cur = order.currency || 'usd';
  const rows = [];
  if (order.amount_subtotal_cents != null) rows.push(['Subtotal', money(order.amount_subtotal_cents, cur)]);
  if (order.amount_discount_cents) rows.push(['Discount', '-' + money(order.amount_discount_cents, cur)]);
  if (order.amount_shipping_cents != null) rows.push(['Shipping', money(order.amount_shipping_cents, cur)]);
  if (order.amount_tax_cents) rows.push(['Tax', money(order.amount_tax_cents, cur)]);
  rows.push(['Total paid', money(order.amount_total_cents, cur)]);
  return rows;
}

export function renderConfirmation(order, storeName = 'Fruity Puppy') {
  const cur = order.currency || 'usd';
  const items = order.items || [];
  const addr = addressLines(order);
  const totals = totalsLines(order);
  const text = [
    `Thanks for your order from ${storeName}.`,
    `Order ${num(order)}`,
    '',
    ...items.map(i => `${i.quantity} x ${i.title}${lineNote(i)}  ${money(i.amount_total_cents, cur)}`),
    '',
    ...totals.map(([k, v]) => `${k}: ${v}`),
    ...(addr.length ? ['', 'Shipping to:', ...addr] : []),
    '',
    'We will email you again with tracking when it ships.',
  ].join('\n');
  const rows = items.map(i => `<tr><td>${esc(i.title)}${i.note ? `<br><small>${esc(i.note)}</small>` : ''}</td><td align="center">${esc(i.quantity)}</td><td align="right">${esc(money(i.amount_total_cents, cur))}</td></tr>`).join('');
  const html = `<div style="font-family:Georgia,serif;color:#251a1d;max-width:560px">
<p>Thanks for your order from ${esc(storeName)}.</p>
<p><strong>Order ${esc(num(order))}</strong></p>
<table cellpadding="4" style="border-collapse:collapse;width:100%">${rows}</table>
<table cellpadding="2" style="margin-top:8px">${totals.map(([k, v]) => `<tr><td>${esc(k)}</td><td align="right">${k === 'Total paid' ? `<strong>${esc(v)}</strong>` : esc(v)}</td></tr>`).join('')}</table>
${addr.length ? `<p>Shipping to:<br>${addr.map(esc).join('<br>')}</p>` : ''}
<p>We will email you again with tracking when it ships.</p></div>`;
  return { subject: `Your ${storeName} order ${num(order)} is confirmed`, text, html };
}

export function renderShipping(order, shipment, storeName = 'Fruity Puppy') {
  const items = (order.items || []).filter(i => i.fulfiller === shipment.group);
  const carrier = CARRIERS[shipment.carrier] || shipment.carrier || 'the carrier';
  const url = shipment.tracking_url;
  const all = items.length === (order.items || []).length;
  const text = [
    `Good news: ${all ? 'your' : 'part of your'} ${storeName} order ${num(order)} is on its way.`,
    '',
    ...items.map(i => `${i.quantity} x ${i.title}`),
    '',
    `Carrier: ${carrier}`,
    `Tracking number: ${shipment.tracking_number}`,
    ...(url ? [`Track it: ${url}`] : []),
  ].join('\n');
  const html = `<div style="font-family:Georgia,serif;color:#251a1d;max-width:560px">
<p>Good news: ${all ? 'your' : 'part of your'} ${esc(storeName)} order <strong>${esc(num(order))}</strong> is on its way.</p>
<ul>${items.map(i => `<li>${esc(i.quantity)} x ${esc(i.title)}</li>`).join('')}</ul>
<p>Carrier: ${esc(carrier)}<br>Tracking number: ${esc(shipment.tracking_number)}</p>
${url ? `<p><a href="${esc(url)}">Track your package</a></p>` : ''}</div>`;
  return { subject: `Your ${storeName} order ${num(order)} has shipped`, text, html };
}

const AZ = d => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Phoenix', dateStyle: 'medium', timeStyle: 'short' }).format(d) + ' Arizona time';
export function threeplLines(order) { return (order.items || []).filter(i => i.threepl); }
export function renderThreepl(order, cfg, storeName = 'Fruity Puppy') {
  const lines = threeplLines(order);
  const s = order.shipping || {}; const a = s.address || {};
  const link = shipLink(order, cfg);
  const date = AZ(new Date(order.created_at_ms || Date.now()));
  const text = [
    `New ${storeName} order to pack and ship: ${num(order)}`,
    `Order date: ${date}`,
    '',
    'SHIP TO',
    ...addressLines(order),
    `Phone: ${order.phone || '-'}`,
    `Email: ${order.email || '-'}`,
    '',
    'ITEMS (SKU | item | qty | note)',
    ...lines.map(i => `${i.sku} | ${i.title} | ${i.quantity} | ${i.threepl_note || '-'}`),
    '',
    `Order notes: ${order.notes || '-'}`,
    '',
    `When it ships, enter the carrier and tracking number here (one time): ${link}`,
  ].join('\n');
  const td = 'style="border:1px solid #ccc;padding:4px 8px"';
  const html = `<div style="font-family:Arial,sans-serif;max-width:640px">
<h2 style="margin:0 0 4px">New order to ship: ${esc(num(order))}</h2>
<p style="margin:0 0 12px">Order date: ${esc(date)}</p>
<h3 style="margin:12px 0 4px">Ship to</h3>
<p style="margin:0">${[s.name, a.line1, a.line2, [a.city, a.state, a.postal_code].filter(Boolean).join(' '), a.country].filter(Boolean).map(esc).join('<br>')}</p>
<p style="margin:4px 0">Phone: ${esc(order.phone || '-')}<br>Email: ${esc(order.email || '-')}</p>
<h3 style="margin:12px 0 4px">Items</h3>
<table style="border-collapse:collapse"><tr><th ${td}>SKU</th><th ${td}>Item</th><th ${td}>Qty</th><th ${td}>Note</th></tr>
${lines.map(i => `<tr><td ${td}>${esc(i.sku)}</td><td ${td}>${esc(i.title)}</td><td ${td} align="center">${esc(i.quantity)}</td><td ${td}>${esc(i.threepl_note || '-')}</td></tr>`).join('')}</table>
<p>Order notes: ${esc(order.notes || '-')}</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#c45c4a;color:#fff;padding:10px 16px;text-decoration:none;border-radius:4px">Enter tracking number</a></p>
<p style="font-size:12px;color:#666">This link works once and only for this order.</p></div>`;
  return { subject: `${storeName} order ${num(order)} – please ship (${lines.reduce((n, i) => n + (i.quantity || 0), 0)} item${lines.length === 1 && lines[0].quantity === 1 ? '' : 's'})`, text, html };
}

// ---------- outbox ----------
export function queueConfirmation(order) {
  if (order.payment !== 'paid' || !order.email || order.confirmation_email) return false;
  order.confirmation_email = { status: 'pending', attempts: 0, queued_at: new Date().toISOString() };
  return true;
}
export function queueThreepl(order) {
  if (order.payment !== 'paid' || order.threepl_email || !threeplLines(order).length) return false;
  order.threepl_email = { status: 'pending', attempts: 0, queued_at: new Date().toISOString() };
  return true;
}
export function queueShipping(order, shipment) {
  if (!order.email || shipment.email) return false;
  shipment.email = { status: 'pending', attempts: 0, queued_at: new Date().toISOString() };
  return true;
}
// Admin "resend": a fresh idempotency key so the provider sends again.
export function requeue(box) {
  if (!box) return false;
  Object.assign(box, { status: 'pending', attempts: 0, resends: (box.resends || 0) + 1, queued_at: new Date().toISOString() });
  return true;
}

async function deliver(box, { to, msg, cfg, fetchImpl, key }) {
  box.attempts = (box.attempts || 0) + 1;
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': box.resends ? `${key}/resend-${box.resends}` : key },
      body: JSON.stringify({ from: cfg.from, to, subject: msg.subject, text: msg.text, html: msg.html, ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`provider ${res.status}`);
    Object.assign(box, { status: 'sent', sent_at: new Date().toISOString(), provider_id: body.id || null, last_error: null, to_count: to.length });
  } catch (err) {
    Object.assign(box, { status: 'failed', last_error: String(err.message).slice(0, 120) });
  }
  return box.status;
}
const due = box => box && (box.status === 'pending' || (box.status === 'failed' && box.attempts < MAX_ATTEMPTS));

export async function dispatchConfirmation(order, store, { cfg = emailConfig(), fetchImpl = fetch, storeName } = {}) {
  const box = order.confirmation_email;
  if (!box || box.status === 'sent' || order.payment !== 'paid') return { skipped: true };
  if (!canSend(cfg)) return { skipped: true, reason: 'sending_disabled' };
  await deliver(box, { to: [order.email], msg: renderConfirmation(order, storeName), cfg, fetchImpl, key: `order-confirmation/${order.id}` });
  await store.putOrder(order);
  return { status: box.status };
}
export async function dispatchThreepl(order, store, { cfg = emailConfig(), fetchImpl = fetch, storeName } = {}) {
  const box = order.threepl_email;
  if (!box || box.status === 'sent' || order.payment !== 'paid') return { skipped: true };
  if (!canSendThreepl(cfg)) return { skipped: true, reason: 'sending_disabled' };
  await deliver(box, { to: [cfg.threeplTo], msg: renderThreepl(order, cfg, storeName), cfg, fetchImpl, key: `order-3pl/${order.id}` });
  await store.putOrder(order);
  return { status: box.status };
}
export async function dispatchShipping(order, shipment, store, { cfg = emailConfig(), fetchImpl = fetch, storeName } = {}) {
  const box = shipment.email;
  if (!box || box.status === 'sent') return { skipped: true };
  if (!canSend(cfg)) return { skipped: true, reason: 'sending_disabled' };
  await deliver(box, { to: [order.email], msg: renderShipping(order, shipment, storeName), cfg, fetchImpl, key: `order-shipped/${order.id}/${shipment.group}/${shipment.tracking_number}` });
  await store.putOrder(order);
  return { status: box.status };
}
// Sends whatever is due on one order. Used by the webhook (fresh order) and the admin retry.
export async function dispatchDue(order, store, opts = {}) {
  const out = {};
  if (due(order.confirmation_email)) out.confirmation = await dispatchConfirmation(order, store, opts);
  if (due(order.threepl_email)) out.threepl = await dispatchThreepl(order, store, opts);
  for (const s of order.shipments || []) if (due(s.email)) (out.shipping ||= []).push(await dispatchShipping(order, s, store, opts));
  return out;
}
export function hasDue(order) {
  return due(order.confirmation_email) || due(order.threepl_email) || (order.shipments || []).some(s => due(s.email));
}
