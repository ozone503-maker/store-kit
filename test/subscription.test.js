import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { GET as buy } from '../api/buy.js';
import { POST as checkout, MIXED_CART_ERROR } from '../api/checkout.js';
import { POST as webhook } from '../api/stripe-webhook.js';
import { GET as catalog } from '../api/catalog.js';
import { GET as product } from '../api/product.js';
import { memoryStore } from '../lib/order-store.js';
import { renderThreepl } from '../lib/email.js';

// The Fridge Club: $49.99/month subscription for one Fruity Puppy Original jar.
const WH = 'whsec_club_local';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_local_only';
  process.env.STRIPE_WEBHOOK_SECRET = WH;
  for (const k of ['ORDER_EMAILS_ENABLED', 'THREEPL_EMAILS_ENABLED', 'RESEND_API_KEY', 'PRINTIFY_TOKEN']) delete process.env[k];
});
const get = (path, headers = {}) => new Request('https://fruity-puppy-store.vercel.app' + path, { headers: { 'user-agent': UA, ...headers } });
const post = (url, body) => new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const stripeMock = cap => async (url, init) => { cap.push(new URLSearchParams(init.body)); return new Response(JSON.stringify({ id: 'cs_test_club', url: 'https://checkout.stripe.com/c/pay/cs_test_club' })); };
function signed(event) {
  const raw = JSON.stringify(event); const t = Math.floor(Date.now() / 1000);
  return new Request('https://x/api/stripe-webhook', { method: 'POST', body: raw, headers: { 'stripe-signature': `t=${t},v1=${createHmac('sha256', WH).update(`${t}.${raw}`).digest('hex')}` } });
}
const evt = (id, type, obj) => ({ id, type, data: { object: obj } });

test('catalog: The Fridge Club is $49.99 a month, flagged as a subscription; the Original stays $59.99', async () => {
  const d = await (await catalog(new Request('https://x/api/catalog'))).json();
  const club = d.products.find(p => p.id === 'fridge-club');
  assert.equal(club.variants[0].sku, 'FP-CLUB-MONTHLY');
  assert.equal(club.variants[0].price_cents, 4999);
  assert.equal(club.variants[0].available, true);
  assert.deepEqual(club.subscription, { interval: 'month', interval_count: 1, cancel_email: 'orders@fruitypuppy.com' });
  assert.equal(d.products.find(p => p.id === 'fruity-puppy-original').variants[0].price_cents, 5999);
  assert.ok(!/guarantee|money.back|heal|cure|treat/i.test(club.description));
});

test('direct buy: club SKU makes a subscription-mode session with a $49.99 monthly price, shipping + phone collected', async () => {
  const cap = [];
  const r = await buy(get('/api/buy?sku=FP-CLUB-MONTHLY'), { fetchImpl: stripeMock(cap) });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), 'https://checkout.stripe.com/c/pay/cs_test_club');
  const p = cap[0];
  assert.equal(p.get('mode'), 'subscription');
  assert.equal(p.get('line_items[0][price_data][unit_amount]'), '4999');
  assert.equal(p.get('line_items[0][price_data][currency]'), 'usd');
  assert.equal(p.get('line_items[0][price_data][recurring][interval]'), 'month');
  assert.equal(p.get('line_items[0][price_data][recurring][interval_count]'), '1');
  assert.equal(p.get('line_items[0][price_data][product_data][metadata][sku]'), 'FP-CLUB-MONTHLY');
  assert.equal(p.get('line_items[0][quantity]'), '1');
  assert.equal(p.get('shipping_address_collection[allowed_countries][0]'), 'US');
  assert.equal(p.get('phone_number_collection[enabled]'), 'true');
  assert.equal(p.get('subscription_data[metadata][skus]'), 'FP-CLUB-MONTHLY:1');
  assert.match(p.get('line_items[0][price_data][product_data][description]'), /Dec 1/);
  // The Original is unchanged: one-time payment, no recurring price.
  const one = [];
  await buy(get('/api/buy?sku=FP-2OZ'), { fetchImpl: stripeMock(one) });
  assert.equal(one[0].get('mode'), 'payment');
  assert.equal(one[0].get('line_items[0][price_data][recurring][interval]'), null);
  assert.equal(one[0].get('subscription_data[metadata][skus]'), null);
});

test('cart: club alone checks out as a subscription; mixed with one-time items it is rejected before Stripe', async () => {
  const cap = [];
  const ok = await checkout(post('https://x/api/checkout', { items: [{ sku: 'FP-CLUB-MONTHLY', quantity: 1 }] }), { fetchImpl: stripeMock(cap) });
  assert.equal(ok.status, 200);
  assert.equal(cap[0].get('mode'), 'subscription');
  const cap2 = [];
  const bad = await checkout(post('https://x/api/checkout', { items: [{ sku: 'FP-2OZ', quantity: 1 }, { sku: 'FP-CLUB-MONTHLY', quantity: 1 }] }), { fetchImpl: stripeMock(cap2) });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, MIXED_CART_ERROR);
  assert.equal(cap2.length, 0);
});

test('product page: club renders with monthly price, join link and email cancel path', async () => {
  const r = await product(new Request('https://x/api/product?id=fridge-club'));
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('The Fridge Club'));
  assert.ok(html.includes('$49.99 a month'));
  assert.ok(html.includes('data-buy-sku="FP-CLUB-MONTHLY"'));
  assert.ok(html.includes('mailto:orders@fruitypuppy.com'));
});

const SID = 'cs_test_Club000000000000001';
const signupSession = { id: SID, object: 'checkout.session', mode: 'subscription', payment_status: 'paid', livemode: false, amount_subtotal: 4999, amount_total: 4999, currency: 'usd', created: 1795700000,
  payment_intent: null, subscription: 'sub_club1', invoice: 'in_first', metadata: { brand: '' },
  total_details: { amount_shipping: 0, amount_tax: 0, amount_discount: 0 },
  customer_details: { email: 'lei@example.com', phone: '+18085550111', name: 'Lei Kai' },
  collected_information: { shipping_details: { name: 'Lei Kai', address: { line1: '2 Mango Ln', city: 'Hilo', state: 'HI', postal_code: '96720', country: 'US' } } } };
const CLUB_LINE = { description: 'The Fridge Club - Monthly, one 2 oz jar', quantity: 1, amount_subtotal: 4999, amount_total: 4999, price: { unit_amount: 4999, recurring: { interval: 'month' }, product: { metadata: { sku: 'FP-CLUB-MONTHLY' } }, metadata: {} } };
function stripeApi({ newApi = false } = {}) {
  const calls = [];
  const f = async url => {
    calls.push(url);
    if (url.includes('/line_items')) return new Response(JSON.stringify({ data: [CLUB_LINE] }));
    if (url.includes('/invoices/in_first')) return new Response(JSON.stringify(newApi ? { id: 'in_first' } : { id: 'in_first', payment_intent: 'pi_first', charge: 'ch_first' }));
    if (url.includes('/invoice_payments')) {
      const inv = new URL(url).searchParams.get('invoice');
      return new Response(JSON.stringify({ data: [{ status: 'paid', payment: { type: 'payment_intent', payment_intent: inv === 'in_first' ? 'pi_first' : 'pi_renew' } }] }));
    }
    if (url.includes('/payment_intents/')) {
      const id = url.split('/payment_intents/')[1].split('?')[0];
      return new Response(JSON.stringify({ id, latest_charge: { id: id.replace('pi_', 'ch_'), balance_transaction: { fee: 175, net: 4824 } } }));
    }
    return new Response('{}', { status: 404 });
  };
  return { f, calls };
}
const renewal = (id, extra = {}) => ({ id, object: 'invoice', billing_reason: 'subscription_cycle', subscription: 'sub_club1', livemode: false, currency: 'usd',
  subtotal: 4999, total: 4999, amount_paid: 4999, customer_email: 'lei@example.com', customer_phone: null, customer_shipping: null,
  status_transitions: { paid_at: 1798300000 }, subscription_details: { metadata: { brand: '', skus: 'FP-CLUB-MONTHLY:1' } },
  lines: { data: [{ description: '1 × The Fridge Club', quantity: 1, amount: 4999 }] }, ...extra });

for (const newApi of [false, true]) {
  test(`webhook (${newApi ? '2025+ invoice payments' : 'classic invoice'} API): signup books the first order; each renewal books a new warehouse order`, async () => {
    const store = memoryStore(); const api = stripeApi({ newApi });
    let r = await webhook(signed(evt('ev_s1', 'checkout.session.completed', signupSession)), { store, fetchImpl: api.f });
    assert.equal(r.status, 200);
    const first = await store.getOrder(SID);
    assert.equal(first.order_number, 'FP-1001');
    assert.equal(first.kind, 'subscription_signup');
    assert.equal(first.subscription_id, 'sub_club1');
    assert.equal(first.payment, 'paid'); assert.equal(first.fulfillment, 'queued');
    assert.equal(first.payment_intent, 'pi_first'); assert.equal(first.stripe_fee_cents, 175);
    assert.equal(first.items[0].sku, 'FP-CLUB-MONTHLY'); assert.equal(first.items[0].threepl, true);
    assert.match(first.items[0].threepl_note, /FP-2OZ.*Dec 1/);
    assert.equal(first.threepl_email.status, 'pending');
    assert.match(first.notes, /Fridge Club signup \(sub_club1\)/);

    // The signup invoice is already covered by checkout.session.completed.
    r = await webhook(signed(evt('ev_i0', 'invoice.paid', renewal('in_first', { billing_reason: 'subscription_create' }))), { store, fetchImpl: api.f });
    assert.equal(r.status, 200);
    assert.equal(await store.getOrder('in_first'), null);

    r = await webhook(signed(evt('ev_i1', 'invoice.paid', renewal('in_renew1', newApi ? {} : { payment_intent: 'pi_renew' }))), { store, fetchImpl: api.f });
    assert.equal(r.status, 200);
    const o = await store.getOrder('in_renew1');
    assert.equal(o.order_number, 'FP-1002');
    assert.equal(o.kind, 'subscription_renewal');
    assert.equal(o.renewal_of, SID);
    assert.equal(o.payment, 'paid'); assert.equal(o.fulfillment, 'queued');
    assert.equal(o.amount_total_cents, 4999);
    assert.equal(o.email, 'lei@example.com'); assert.equal(o.phone, '+18085550111');
    assert.equal(o.shipping.address.line1, '2 Mango Ln');
    assert.equal(o.items[0].sku, 'FP-CLUB-MONTHLY'); assert.equal(o.items[0].threepl, true);
    assert.match(o.items[0].threepl_note, /renewal.*FP-2OZ/);
    assert.equal(o.payment_intent, 'pi_renew'); assert.equal(o.stripe_fee_cents, 175);
    assert.equal(o.threepl_email.status, 'pending');
    assert.match(o.notes, /Fridge Club renewal of FP-1001/);
    const t = renderThreepl(o, { shipSecret: 's', publicBase: 'https://www.fruitypuppy.com/store' }).text;
    assert.ok(t.includes('FP-CLUB-MONTHLY') && t.includes('2 Mango Ln'));

    // Replays and a duplicate invoice event never book twice.
    const dup = await webhook(signed(evt('ev_i1', 'invoice.paid', renewal('in_renew1'))), { store, fetchImpl: api.f });
    assert.equal((await dup.json()).duplicate, true);
    await webhook(signed(evt('ev_i1b', 'invoice.paid', renewal('in_renew1'))), { store, fetchImpl: api.f });
    assert.equal((await store.listOrderIds()).length, 2);

    // A new address on the customer is used for the next renewal; a refund finds the renewal order.
    await webhook(signed(evt('ev_i2', 'invoice.paid', renewal('in_renew2', { payment_intent: 'pi_r2', customer_shipping: { name: 'Lei Kai', address: { line1: '9 New Rd', city: 'Kona', state: 'HI', postal_code: '96740', country: 'US' } } }))), { store, fetchImpl: api.f });
    const o2 = await store.getOrder('in_renew2');
    assert.equal(o2.order_number, 'FP-1003'); assert.equal(o2.shipping.address.line1, '9 New Rd');
    await webhook(signed(evt('ev_rf', 'charge.refunded', { id: 'ch_r2', payment_intent: 'pi_r2', amount: 4999, amount_refunded: 4999, refunded: true, refunds: { data: [] } })), { store });
    assert.equal((await store.getOrder('in_renew2')).payment, 'refunded');
  });
}

test('renewal fails closed without an order store and ignores non-subscription invoices', async () => {
  const r = await webhook(signed(evt('ev_x', 'invoice.paid', renewal('in_x'))), { store: null });
  assert.equal(r.status, 503);
  const store = memoryStore();
  const r2 = await webhook(signed(evt('ev_y', 'invoice.paid', { id: 'in_y', billing_reason: 'manual', subscription: null })), { store, fetchImpl: stripeApi().f });
  assert.equal(r2.status, 200);
  assert.equal(await store.getOrder('in_y'), null);
});
