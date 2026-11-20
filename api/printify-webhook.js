import { createHmac, timingSafeEqual } from 'node:crypto';
import { recordShipment } from '../lib/orders.js';
import { getOrderStore } from '../lib/order-store.js';
import { json } from '../lib/http.js';

// Printify shipment updates (topic order:shipment:created). Requires PRINTIFY_WEBHOOK_SECRET (the secret
// set when the webhook is registered); Printify signs with X-Pfy-Signature: sha256=<hex HMAC of body>.
// Matches the order by external_id (our order id) or by the Printify order id recorded at submission,
// marks the Printify lines shipped and emails the customer the tracking link (if emails are enabled).
export function verifyPrintify(raw, header, secret) {
  if (!secret || !header) return false;
  const given = Buffer.from(header.replace(/^sha256=/, ''));
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function POST(request, deps = {}) {
  const secret = process.env.PRINTIFY_WEBHOOK_SECRET;
  if (!secret) return json({ error: 'Not configured' }, 503);
  const raw = await request.text();
  if (!verifyPrintify(raw, request.headers.get('x-pfy-signature'), secret)) return json({ error: 'Invalid signature' }, 401);

  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: 'Bad JSON' }, 400); }
  const data = body.resource?.data || body.resource || body;
  const shipment = (data.shipments || [])[0] || {};
  const carrierObj = data.carrier && typeof data.carrier === 'object' ? data.carrier : {};
  const tracking = carrierObj.tracking_number || shipment.tracking_number || shipment.number || data.tracking_number;
  const store = deps.store !== undefined ? deps.store : getOrderStore();
  if (!store) return json({ error: 'Temporary failure' }, 503);

  try {
    let orderId = data.external_id || data.order_external_id || null;
    const pfyId = body.resource?.id || data.order_id || data.id;
    if (!orderId && pfyId) orderId = await store.getAlias(`pfy:${pfyId}`);
    if (!orderId || !tracking) return json({ ok: true, ignored: true });
    const saved = await recordShipment(orderId, 'printify', {
      carrier: carrierObj.code || (typeof data.carrier === 'string' ? data.carrier : '') || shipment.carrier || 'other',
      tracking_number: tracking,
      tracking_url: carrierObj.tracking_url || shipment.tracking_url || shipment.url || data.tracking_url || null,
    }, { store, source: 'printify', emailFetch: deps.emailFetch, emailCfg: deps.emailCfg });
    return json({ ok: true, matched: !!saved });
  } catch (err) {
    return json({ error: 'Temporary failure' }, err.status || 500);
  }
}
