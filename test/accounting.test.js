import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { POST as webhook } from '../api/stripe-webhook.js';
import { POST as checkout } from '../api/checkout.js';
import { GET as adminGet, POST as adminPost } from '../api/admin-orders.js';
import { GET as shipGet, POST as shipPost } from '../api/ship.js';
import { POST as printifyHook } from '../api/printify-webhook.js';
import { memoryStore } from '../lib/order-store.js';
import { emailConfig, canSend, canSendThreepl, shipToken, renderThreepl, renderShipping, trackingUrl } from '../lib/email.js';
import { printifyPayload, splitName } from '../lib/fulfillment.js';
import { ordersCsv } from '../lib/ledger.js';

const WH = 'whsec_acct_local';
const SID = 'cs_test_Acct0000000000000001';
const SID2 = 'cs_test_Acct0000000000000002';
beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_local_only';
  process.env.STRIPE_WEBHOOK_SECRET = WH;
  process.env.ADMIN_TOKEN = 'adm-acct';
  process.env.SHIP_LINK_SECRET = 'ship-local-secret';
  process.env.PRINTIFY_WEBHOOK_SECRET = 'pfy-acct';
  for (const k of ['ORDER_EMAILS_ENABLED', 'THREEPL_EMAILS_ENABLED', 'RESEND_API_KEY', 'ORDER_EMAIL_FROM', 'THREEPL_EMAIL', 'PRINTIFY_TOKEN', 'PRINTIFY_SHOP_ID']) delete process.env[k];
});
const ON = { enabled: true, threeplEnabled: true, apiKey: 're_test', from: 'orders@example.com', replyTo: 'fruitypuppyskincream@gmail.com', threeplTo: '3pl@example.com', shipSecret: 'ship-local-secret', publicBase: 'https://www.fruitypuppy.com/store' };
const OFF = { ...ON, enabled: false, threeplEnabled: false };

function signed(event) {
  const raw = JSON.stringify(event); const t = Math.floor(Date.now() / 1000);
  return new Request('https://x/api/stripe-webhook', { method: 'POST', body: raw, headers: { 'stripe-signature': `t=${t},v1=${createHmac('sha256', WH).update(`${t}.${raw}`).digest('hex')}` } });
}
const LINES = {
  jar: { description: 'Fruity Puppy Original - 2 oz', quantity: 1, amount_subtotal: 5999, amount_total: 5999, price: { unit_amount: 5999, product: { metadata: { sku: 'FP-2OZ' } }, metadata: {} } },
  juice: { description: 'Thorny Toad Face Juice', quantity: 2, amount_subtotal: 5998, amount_total: 5998, price: { unit_amount: 2999, product: { metadata: { sku: 'TT-JUICE' } }, metadata: {} } },
  tee: { description: 'FPO Tee', quantity: 1, amount_subtotal: 2800, amount_total: 2800, price: { unit_amount: 2800, product: { metadata: { sku: 'FPO-TEE-18100' } }, metadata: {} } },
};
function stripe(lines, { fee = 230 } = {}) {
  return async url => {
    if (url.includes('/line_items')) return new Response(JSON.stringify({ data: lines }));
    if (url.includes('/payment_intents/')) return new Response(JSON.stringify({ id: 'pi_1', latest_charge: { id: 'ch_1', balance_transaction: { fee, net: 5999 - fee } } }));
    return new Response('{}', { status: 404 });
  };
}
const session = (id, extra = {}) => ({ id, object: 'checkout.session', payment_status: 'paid', livemode: false, amount_subtotal: 5999, amount_total: 5999, currency: 'usd', created: 1795700000, payment_intent: id === SID ? 'pi_1' : 'pi_2', metadata: { brand: '' },
  total_details: { amount_shipping: 0, amount_tax: 0, amount_discount: 0 },
  customer_details: { email: 'ana@example.com', phone: '+18085550100', name: 'Ana Kai' },
  collected_information: { shipping_details: { name: 'Ana Maria Kai', address: { line1: '1 Palm St', line2: 'Apt 2', city: 'Hilo', state: 'HI', postal_code: '96720', country: 'US' } } }, ...extra });
const evt = (id, type, obj) => ({ id, type, data: { object: obj } });
function mailbox() { const sent = []; const f = async (url, init) => { sent.push({ url, ...init, json: JSON.parse(init.body) }); return new Response('{"id":"em_x"}'); }; return { sent, f }; }
const admin = (q = '', init = {}) => new Request('https://x/api/admin-orders' + q, { ...init, headers: { authorization: 'Bearer adm-acct', ...(init.headers || {}) } });

test('checkout collects phone numbers; prices and shipping untouched', async () => {
  const cap = [];
  await checkout(new Request('https://x/api/checkout', { method: 'POST', body: JSON.stringify({ items: [{ sku: 'FP-2OZ' }] }) }), { fetchImpl: async (u, i) => { cap.push(i); return new Response('{"id":"cs_test_x","url":"https://checkout.stripe.com/x"}'); } });
  const p = new URLSearchParams(cap[0].body);
  assert.equal(p.get('phone_number_collection[enabled]'), 'true');
  assert.equal(p.get('line_items[0][price_data][unit_amount]'), '5999');
  assert.equal(p.get('automatic_tax[enabled]'), 'false');
  assert.equal(p.get('shipping_options[0][shipping_rate_data][fixed_amount][amount]'), null);
});

test('ledger: sequential order numbers, totals, phone, fee and net; nothing emailed by default', async () => {
  const store = memoryStore(); const mb = mailbox();
  await webhook(signed(evt('e1', 'checkout.session.completed', session(SID))), { store, fetchImpl: stripe([LINES.jar]), emailFetch: mb.f });
  await webhook(signed(evt('e2', 'checkout.session.completed', session(SID2, { amount_total: 5998, amount_subtotal: 5998 }))), { store, fetchImpl: stripe([LINES.juice]), emailFetch: mb.f });
  const a = await store.getOrder(SID); const b = await store.getOrder(SID2);
  assert.equal(a.order_number, 'FP-1001'); assert.equal(b.order_number, 'FP-1002');
  assert.equal(a.amount_subtotal_cents, 5999); assert.equal(a.amount_tax_cents, 0); assert.equal(a.amount_discount_cents, 0); assert.equal(a.amount_shipping_cents, 0);
  assert.equal(a.stripe_fee_cents, 230); assert.equal(a.net_cents, 5769); assert.equal(a.charge_id, 'ch_1');
  assert.equal(a.phone, '+18085550100'); assert.equal(a.shipping.name, 'Ana Maria Kai');
  assert.equal(a.items[0].note, 'Preorder, ships Dec 1'); assert.equal(a.items[0].threepl, true); assert.equal(a.items[0].threepl_note, 'Ship with Dec 1 batch');
  assert.equal(a.fulfillment, 'queued');
  assert.equal(a.confirmation_email.status, 'pending'); assert.equal(a.threepl_email.status, 'pending');
  assert.equal(mb.sent.length, 0);
  assert.equal(canSend(emailConfig({})), false); assert.equal(canSendThreepl(emailConfig({ RESEND_API_KEY: 'x', ORDER_EMAIL_FROM: 'a@b', THREEPL_EMAIL: 'c@d', SHIP_LINK_SECRET: 's' })), false);
  assert.equal(emailConfig({}).replyTo, 'fruitypuppyskincream@gmail.com');
});

test('fee lookup failure never fails the webhook', async () => {
  const store = memoryStore();
  const f = async url => url.includes('/line_items') ? new Response(JSON.stringify({ data: [LINES.jar] })) : new Response('{}', { status: 500 });
  const r = await webhook(signed(evt('f1', 'checkout.session.completed', session(SID))), { store, fetchImpl: f });
  assert.equal(r.status, 200);
  const o = await store.getOrder(SID); assert.equal(o.payment, 'paid'); assert.equal(o.stripe_fee_cents, null);
});

test('charge.refunded updates the ledger (partial then full) and is idempotent', async () => {
  const store = memoryStore();
  await webhook(signed(evt('r0', 'checkout.session.completed', session(SID))), { store, fetchImpl: stripe([LINES.jar]) });
  await webhook(signed(evt('r1', 'charge.refunded', { id: 'ch_1', object: 'charge', payment_intent: 'pi_1', amount: 5999, amount_refunded: 1000, refunded: false, refunds: { data: [{ id: 're_1', amount: 1000, status: 'succeeded', created: 1795710000 }] } })), { store });
  let o = await store.getOrder(SID);
  assert.equal(o.amount_refunded_cents, 1000); assert.equal(o.payment, 'paid'); assert.equal(o.refunds.length, 1);
  await webhook(signed(evt('r2', 'charge.refunded', { id: 'ch_1', object: 'charge', payment_intent: 'pi_1', amount: 5999, amount_refunded: 5999, refunded: true, refunds: { data: [] } })), { store });
  const dup = await webhook(signed(evt('r2', 'charge.refunded', { id: 'ch_1', payment_intent: 'pi_1', amount: 5999, amount_refunded: 5999, refunded: true })), { store });
  assert.equal((await dup.json()).duplicate, true);
  o = await store.getOrder(SID);
  assert.equal(o.amount_refunded_cents, 5999); assert.equal(o.payment, 'refunded');
  // a later checkout event cannot flip a refunded order back to paid
  await webhook(signed(evt('r3', 'checkout.session.async_payment_succeeded', session(SID))), { store, fetchImpl: stripe([LINES.jar]) });
  assert.equal((await store.getOrder(SID)).payment, 'refunded');
  const csv = ordersCsv([o]);
  assert.match(csv, /"59\.99","2\.30","57\.69","59\.99","-2\.30"/);
});

test('3PL email: warehouse lines only, full ship-to, preorder note, signed link; sent once when enabled', async () => {
  const store = memoryStore(); const mb = mailbox();
  await webhook(signed(evt('m1', 'checkout.session.completed', session(SID, { amount_total: 8799 }))), { store, fetchImpl: stripe([LINES.jar, LINES.tee]), emailFetch: mb.f, emailCfg: ON });
  const o = await store.getOrder(SID);
  const tpl = mb.sent.find(m => m.json.to[0] === '3pl@example.com');
  const thanks = mb.sent.find(m => m.json.to[0] === 'ana@example.com');
  assert.ok(tpl && thanks); assert.equal(mb.sent.length, 2);
  assert.equal(tpl.headers['Idempotency-Key'], `order-3pl/${SID}`);
  assert.equal(thanks.json.reply_to, 'fruitypuppyskincream@gmail.com');
  const t = tpl.json.text;
  for (const s of ['FP-1001', 'FP-2OZ | Fruity Puppy Original - 2 oz | 1 | Ship with Dec 1 batch', 'Ana Maria Kai', '1 Palm St', 'Apt 2', 'Hilo, HI 96720', 'Phone: +18085550100', 'Email: ana@example.com', 'Arizona time', `/store/ship/${SID}?t=${shipToken(SID, 'ship-local-secret')}`]) assert.ok(t.includes(s), s);
  assert.ok(!t.includes('FPO-TEE')); // Printify lines never go to the 3PL
  assert.equal(o.threepl_email.status, 'sent'); assert.equal(o.confirmation_email.status, 'sent');
  await webhook(signed(evt('m2', 'checkout.session.async_payment_succeeded', session(SID))), { store, fetchImpl: stripe([LINES.jar, LINES.tee]), emailFetch: mb.f, emailCfg: ON });
  assert.equal(mb.sent.length, 2);
});

test('orders with only Printify lines do not email the 3PL', async () => {
  const store = memoryStore(); const mb = mailbox();
  await webhook(signed(evt('p1', 'checkout.session.completed', session(SID))), { store, fetchImpl: stripe([LINES.tee]), emailFetch: mb.f, emailCfg: ON });
  const o = await store.getOrder(SID);
  assert.equal(o.threepl_email, undefined); assert.equal(o.fulfillment, 'handoff_pending'); assert.equal(o.groups.printify.status, 'not_configured');
  assert.deepEqual(mb.sent.map(m => m.json.to[0]), ['ana@example.com']);
});

test('ship link: bad token refused; form; POST marks warehouse shipped once and emails tracking', async () => {
  const store = memoryStore(); const mb = mailbox();
  await webhook(signed(evt('s1', 'checkout.session.completed', session(SID))), { store, fetchImpl: stripe([LINES.jar]) });
  const tok = shipToken(SID, 'ship-local-secret');
  const u = q => `https://x/api/ship?id=${SID}&t=${q}`;
  assert.equal((await shipGet(new Request(u('nope')), { store })).status, 403);
  assert.equal((await shipGet(new Request(`https://x/api/ship?id=${SID2}&t=${tok}`), { store })).status, 403);
  const g = await shipGet(new Request(u(tok)), { store });
  assert.equal(g.status, 200); assert.equal(g.headers.get('x-robots-tag'), 'noindex, nofollow'); assert.equal(g.headers.get('referrer-policy'), 'no-referrer');
  const html = await g.text(); assert.ok(html.includes('FP-1001') && html.includes('<select') && !html.includes('ana@example.com'));
  const bad = await shipPost(new Request(u(tok), { method: 'POST', body: 'carrier=usps&tracking_number=%3Cx%3E' }), { store, emailCfg: ON, emailFetch: mb.f });
  assert.match(await bad.text(), /does not look right/);
  const ok = await shipPost(new Request(u(tok), { method: 'POST', body: `t=${tok}&carrier=usps&tracking_number=9400111899223344556677` }), { store, emailCfg: ON, emailFetch: mb.f });
  assert.match(await ok.text(), /marked shipped/);
  const o = await store.getOrder(SID);
  assert.equal(o.fulfillment, 'shipped'); assert.equal(o.shipments[0].source, '3pl_link');
  assert.equal(o.shipments[0].tracking_url, 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223344556677');
  assert.equal(mb.sent.length, 1); assert.match(mb.sent[0].json.subject, /FP-1001 has shipped/); assert.ok(mb.sent[0].json.html.includes('Track your package'));
  const again = await shipPost(new Request(u(tok), { method: 'POST', body: `carrier=ups&tracking_number=1Z999` }), { store, emailCfg: ON, emailFetch: mb.f });
  assert.match(await again.text(), /already marked shipped/);
  assert.equal((await store.getOrder(SID)).shipments.length, 1); assert.equal(mb.sent.length, 1);
  delete process.env.SHIP_LINK_SECRET;
  assert.equal((await shipGet(new Request(u(tok)), { store })).status, 503);
});

test('admin: list filters, mark shipped, resend, CSV export; all locked behind the token', async () => {
  const store = memoryStore(); const mb = mailbox();
  await webhook(signed(evt('a1', 'checkout.session.completed', session(SID))), { store, fetchImpl: stripe([LINES.jar]) });
  await webhook(signed(evt('a2', 'checkout.session.completed', session(SID2, { amount_total: 2800 }))), { store, fetchImpl: stripe([LINES.tee]) });
  assert.equal((await adminGet(new Request('https://x/api/admin-orders?format=csv'), { store })).status, 401);
  let d = await (await adminGet(admin('?fulfillment=queued'), { store, cfg: OFF })).json();
  assert.deepEqual(d.orders.map(o => o.order_number), ['FP-1001']); assert.deepEqual(d.email, { customer: false, threepl: false });
  d = await (await adminGet(admin('?q=fp-1002'), { store, cfg: OFF })).json();
  assert.equal(d.orders.length, 1);
  const bad = await adminPost(admin('', { method: 'POST', body: JSON.stringify({ action: 'ship', id: SID, group: 'warehouse', carrier: 'dhl', tracking_number: '123456' }) }), { store, cfg: ON, fetchImpl: mb.f });
  assert.equal(bad.status, 400);
  const r = await adminPost(admin('', { method: 'POST', body: JSON.stringify({ action: 'ship', id: SID, group: 'warehouse', carrier: 'ups', tracking_number: '1Z999AA10123456784' }) }), { store, cfg: ON, fetchImpl: mb.f });
  const body = await r.json();
  assert.equal(body.fulfillment, 'shipped'); assert.equal(body.shipment.tracking_url, 'https://www.ups.com/track?tracknum=1Z999AA10123456784');
  assert.equal(mb.sent.length, 1);
  const rs = await adminPost(admin('', { method: 'POST', body: JSON.stringify({ action: 'resend', id: SID, kind: 'shipping' }) }), { store, cfg: ON, fetchImpl: mb.f });
  assert.equal(rs.status, 200); assert.equal(mb.sent.length, 2); assert.match(mb.sent[1].headers['Idempotency-Key'], /resend-1$/);
  const off = await (await adminPost(admin('', { method: 'POST', body: JSON.stringify({ action: 'resend', id: SID, kind: 'confirmation' }) }), { store, cfg: OFF, fetchImpl: mb.f })).json();
  assert.equal(off.result.sending, 'disabled'); assert.equal(mb.sent.length, 2);
  const csvRes = await adminGet(admin('?format=csv'), { store });
  assert.match(csvRes.headers.get('content-type'), /text\/csv/);
  const csv = await csvRes.text();
  const [head, ...rows] = csv.trim().split('\r\n');
  assert.ok(head.startsWith('order_number,date_hst,date_utc,brand'));
  for (const c of ['subtotal', 'discount', 'shipping', 'tax', 'total', 'stripe_fee', 'net', 'refunded', 'net_after_refunds', 'tracking_numbers', 'phone']) assert.ok(head.split(',').includes(c), c);
  assert.equal(rows.length, 2);
  assert.ok(csv.includes('"FP-1001"') && csv.includes('"1Z999AA10123456784"') && csv.includes('"FP-2OZx1"'));
});

test('CSV neutralizes spreadsheet formulas in customer text', () => {
  const csv = ordersCsv([{ id: 'cs_test_x', items: [], shipping: { name: '=HYPERLINK("x")' }, notes: '+cmd' }]);
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`) && csv.includes(`"'+cmd"`));
});

test('Printify: address/name mapping from the Stripe shape; mixed cart submits only Printify lines', async () => {
  const order = { id: SID, order_number: 'FP-1001', email: 'ana@example.com', phone: '+1808', shipping: { name: 'Ana Maria Kai', address: { line1: '1 Palm St', line2: 'Apt 2', city: 'Hilo', state: 'HI', postal_code: '96720', country: 'US' } },
    items: [{ sku: 'FP-2OZ', fulfiller_adapter: 'manual', quantity: 1 }, { sku: 'FPO-TEE-18100', fulfiller_adapter: 'printify', printify_product_id: 'p1', printify_variant_id: '18100', quantity: 2 }] };
  const p = printifyPayload(order);
  assert.deepEqual(p.line_items, [{ product_id: 'p1', variant_id: 18100, quantity: 2 }]);
  assert.deepEqual(p.address_to, { first_name: 'Ana', last_name: 'Maria Kai', email: 'ana@example.com', phone: '+1808', country: 'US', region: 'HI', address1: '1 Palm St', address2: 'Apt 2', city: 'Hilo', zip: '96720' });
  assert.equal(p.send_shipping_notification, false); assert.equal(p.label, 'FP-1001');
  assert.deepEqual(splitName(''), { first_name: 'Customer', last_name: '' });
  assert.throws(() => printifyPayload({ ...order, shipping: { name: 'x', address: {} } }), /address incomplete/);

  process.env.PRINTIFY_TOKEN = 'pt'; process.env.PRINTIFY_SHOP_ID = '1';
  const store = memoryStore(); const calls = [];
  const fulfill = async (o, cfg) => { calls.push({ o, cfg }); return { status: 'submitted', printify_order_id: 'pfy_9' }; };
  await webhook(signed(evt('pf1', 'checkout.session.completed', session(SID))), { store, fetchImpl: stripe([LINES.jar, LINES.tee]), fulfill });
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].o.items.map(i => i.sku), ['FPO-TEE-18100']); assert.equal(calls[0].cfg.send_to_production, false);
  let o = await store.getOrder(SID);
  assert.equal(o.groups.printify.status, 'submitted'); assert.equal(o.groups.printify.printify_order_id, 'pfy_9'); assert.equal(o.fulfillment, 'handoff_pending');
  await webhook(signed(evt('pf2', 'checkout.session.async_payment_succeeded', session(SID))), { store, fetchImpl: stripe([LINES.jar, LINES.tee]), fulfill });
  assert.equal(calls.length, 1); // never submitted twice

  // Printify shipment webhook (real payload shape: resource.id + data.carrier) matches by Printify order id
  const mb = mailbox();
  const raw = JSON.stringify({ type: 'order:shipment:created', resource: { id: 'pfy_9', type: 'order', data: { carrier: { code: 'usps', tracking_number: '9400999', tracking_url: 'https://t.example/9400999' }, skus: ['x'] } } });
  const sig = 'sha256=' + createHmac('sha256', 'pfy-acct').update(raw).digest('hex');
  const r = await printifyHook(new Request('https://x', { method: 'POST', body: raw, headers: { 'x-pfy-signature': sig } }), { store, emailCfg: ON, emailFetch: mb.f });
  assert.equal((await r.json()).matched, true);
  o = await store.getOrder(SID);
  assert.equal(o.groups.printify.status, 'shipped'); assert.equal(o.fulfillment, 'partially_shipped');
  assert.equal(mb.sent.length, 1); assert.ok(mb.sent[0].json.text.includes('part of your') && mb.sent[0].json.text.includes('FPO Tee') && !mb.sent[0].json.text.includes('Original'));
  // replay does not double-record or double-email
  await printifyHook(new Request('https://x', { method: 'POST', body: raw, headers: { 'x-pfy-signature': sig } }), { store, emailCfg: ON, emailFetch: mb.f });
  assert.equal((await store.getOrder(SID)).shipments.length, 1); assert.equal(mb.sent.length, 1);
});

test('Printify failure is recorded and retried from admin, never fails the webhook', async () => {
  process.env.PRINTIFY_TOKEN = 'pt'; process.env.PRINTIFY_SHOP_ID = '1';
  const store = memoryStore(); let fail = true;
  const fulfill = async () => { if (fail) throw new Error('Printify 500'); return { printify_order_id: 'pfy_2' }; };
  const r = await webhook(signed(evt('pq1', 'checkout.session.completed', session(SID))), { store, fetchImpl: stripe([LINES.tee]), fulfill });
  assert.equal(r.status, 200);
  assert.equal((await store.getOrder(SID)).groups.printify.status, 'failed');
  fail = false;
  const a = await (await adminPost(admin('', { method: 'POST', body: JSON.stringify({ action: 'printify', id: SID }) }), { store, fulfill })).json();
  assert.equal(a.result.status, 'submitted');
});

test('tracking links per carrier and shipping email escapes', () => {
  assert.equal(trackingUrl('fedex', '1234'), 'https://www.fedex.com/fedextrack/?trknbr=1234');
  assert.equal(trackingUrl('other', '1234', 'javascript:alert(1)'), null);
  assert.equal(trackingUrl('other', '1234', 'https://ok.example/1234'), 'https://ok.example/1234');
  const m = renderShipping({ id: SID, order_number: 'FP-1', items: [{ title: '<b>', quantity: 1, fulfiller: 'warehouse' }] }, { group: 'warehouse', carrier: 'usps', tracking_number: '1', tracking_url: 'https://x' });
  assert.ok(m.html.includes('&lt;b&gt;'));
  const t = renderThreepl({ id: SID, order_number: 'FP-1', items: [{ sku: 'FP-2OZ', title: '<i>', quantity: 1, threepl: true }], shipping: { name: '<x>' } }, ON);
  assert.ok(t.html.includes('&lt;x&gt;') && !t.html.includes('<x>'));
});
