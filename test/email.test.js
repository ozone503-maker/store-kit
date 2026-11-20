import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { POST as webhook } from '../api/stripe-webhook.js';
import { POST as adminSend } from '../api/admin-orders.js';
import { memoryStore } from '../lib/order-store.js';
import { renderConfirmation, dispatchConfirmation, queueConfirmation } from '../lib/email.js';

process.env.STRIPE_SECRET_KEY = 'sk_test_local'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_local'; process.env.ADMIN_TOKEN = 'adm';
const SID = 'cs_test_EmailCase1234567890';
const lines = async () => new Response(JSON.stringify({ data: [{ description: 'Moon Tea <b>', quantity: 2, amount_total: 5998, price: { product: { metadata: { sku: 'MT-TEA' } }, metadata: {} } }] }));
function signed(ev) { const raw = JSON.stringify(ev); const t = Math.floor(Date.now() / 1000); return new Request('https://x', { method: 'POST', body: raw, headers: { 'stripe-signature': `t=${t},v1=${createHmac('sha256', 'whsec_local').update(`${t}.${raw}`).digest('hex')}` } }); }
const ev = (id, type, ps = 'paid') => ({ id, type, data: { object: { id: SID, payment_status: ps, amount_total: 5998, currency: 'usd', total_details: { amount_shipping: 0 }, metadata: {}, customer_details: { email: 'buyer@example.com' } } } });

test('disabled by default: paid order queued, nothing sent', async () => {
  delete process.env.ORDER_EMAILS_ENABLED;
  const store = memoryStore(); const sent = [];
  await webhook(signed(ev('e1', 'checkout.session.completed')), { store, fetchImpl: lines, emailFetch: async (...a) => { sent.push(a); return new Response('{}'); } });
  const o = await store.getOrder(SID);
  assert.equal(o.confirmation_email.status, 'pending'); assert.equal(sent.length, 0);
  assert.deepEqual(await (await adminSend(new Request('https://x', { method: 'POST', headers: { authorization: 'Bearer adm' } }), { store })).json(), { sending: 'disabled', attempted: 0 });
});
test('unpaid order is not queued', async () => {
  const store = memoryStore();
  await webhook(signed(ev('u1', 'checkout.session.completed', 'unpaid')), { store, fetchImpl: lines });
  assert.equal((await store.getOrder(SID)).confirmation_email, undefined);
});
test('enabled: sends once with idempotency key, accurate totals, escaped html; failure then retry', async () => {
  const cfg = { enabled: true, apiKey: 're_test', from: 'orders@example.com', replyTo: '' };
  const store = memoryStore(); const calls = []; let fail = true;
  const f = async (url, init) => { calls.push(init); return fail ? new Response('{}', { status: 500 }) : new Response('{"id":"em_1"}'); };
  const order = { id: SID, payment: 'paid', email: 'buyer@example.com', currency: 'usd', amount_total_cents: 5998, amount_shipping_cents: 0, items: [{ title: 'Moon Tea <b>', quantity: 2, amount_total_cents: 5998 }] };
  assert.ok(queueConfirmation(order)); assert.ok(!queueConfirmation(order));
  await store.putOrder(order);
  assert.equal((await dispatchConfirmation(order, store, { cfg, fetchImpl: f })).status, 'failed');
  fail = false;
  const r = await adminSend(new Request('https://x', { method: 'POST', headers: { authorization: 'Bearer adm' } }), { store, cfg, fetchImpl: f });
  assert.equal((await r.json()).results[0].status, 'sent');
  assert.equal(calls[1].headers['Idempotency-Key'], `order-confirmation/${SID}`);
  const body = JSON.parse(calls[1].body);
  assert.deepEqual(body.to, ['buyer@example.com']); assert.match(body.text, /\$59\.98/); assert.ok(body.html.includes('&lt;b&gt;'));
  await dispatchConfirmation(await store.getOrder(SID), store, { cfg, fetchImpl: f });
  assert.equal(calls.length, 2);
});
test('render shows order number, preorder note, totals and ship-to address but no payment ids', () => {
  const m = renderConfirmation({ id: SID, order_number: 'FP-1001', currency: 'usd', amount_subtotal_cents: 5999, amount_shipping_cents: 0, amount_tax_cents: 0, amount_total_cents: 5999,
    items: [{ title: 'Fruity Puppy Original - 2 oz', quantity: 1, amount_total_cents: 5999, note: 'Preorder, ships Dec 1' }],
    shipping: { name: 'Ana Kai', address: { line1: '1 Palm St', city: 'Hilo', state: 'HI', postal_code: '96720', country: 'US' } }, payment_intent: 'pi_x' });
  assert.match(m.subject, /FP-1001/);
  for (const s of ['Order FP-1001', 'Preorder, ships Dec 1', 'Subtotal: $59.99', 'Total paid: $59.99', 'Ana Kai', '1 Palm St', 'Hilo, HI 96720']) assert.ok(m.text.includes(s), s);
  assert.ok(m.html.includes('1 Palm St') && !m.html.includes('pi_x') && !m.text.includes('pi_x'));
});
