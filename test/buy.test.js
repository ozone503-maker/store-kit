import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { GET as buy } from '../api/buy.js';
import { POST as checkout } from '../api/checkout.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
beforeEach(() => { process.env.STRIPE_SECRET_KEY = 'sk_test_local_only'; });
const get = (path, headers = {}) => new Request('https://fruity-puppy-store.vercel.app' + path, { headers: { 'user-agent': UA, ...headers } });
function stripeMock(cap) {
  return async (url, init) => { cap.push(new URLSearchParams(init.body)); return new Response(JSON.stringify({ id: 'cs_test_x', url: 'https://checkout.stripe.com/c/pay/cs_test_x' }), { status: 200 }); };
}

test('direct buy: Original makes a 1-unit session labeled preorder and 303s to Stripe', async () => {
  const cap = [];
  const r = await buy(get('/api/buy?sku=FP-2OZ'), { fetchImpl: stripeMock(cap) });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), 'https://checkout.stripe.com/c/pay/cs_test_x');
  assert.equal(cap.length, 1);
  const p = cap[0];
  assert.equal(p.get('line_items[0][quantity]'), '1');
  assert.equal(p.get('line_items[0][price_data][unit_amount]'), '5999');
  assert.equal(p.get('line_items[0][price_data][product_data][description]'), 'Preorder, ships Dec 1');
  assert.equal(p.get('success_url'), 'https://www.fruitypuppy.com/store/confirmation?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(p.get('cancel_url'), 'https://www.fruitypuppy.com/store/cart');
});

test('direct buy params match the cart checkout exactly for the same item (sample keeps $5 shipping)', async () => {
  for (const sku of ['FP-SAMPLE', 'FP-2OZ', 'TT-JUICE']) {
    const a = [], b = [];
    await buy(get('/api/buy?sku=' + sku), { fetchImpl: stripeMock(a) });
    await checkout(new Request('https://x/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ sku, quantity: 1 }], success_url: 'https://www.fruitypuppy.com/store/confirmation' }) }), { fetchImpl: stripeMock(b) });
    assert.equal(a[0].toString(), b[0].toString(), sku);
  }
  const s = [];
  await buy(get('/api/buy?sku=FP-SAMPLE'), { fetchImpl: stripeMock(s) });
  assert.equal(s[0].get('line_items[0][price_data][unit_amount]'), '0');
  assert.equal(s[0].get('shipping_options[0][shipping_rate_data][fixed_amount][amount]'), '500');
  assert.equal(s[0].get('line_items[0][price_data][product_data][description]'), null);
});

test('direct buy never reaches Stripe for unavailable, coming-soon or unknown SKUs', async () => {
  for (const [sku, to] of [['FPX-2OZ', '/store/product/fpx'], ['MT-TEA', '/store/product/moon-tea'], ['FP-TEE-WHITE', '/store/product/fp-tee'], ['NOPE', '/store/'], ['', '/store/']]) {
    const cap = [];
    const r = await buy(get('/api/buy?sku=' + encodeURIComponent(sku)), { fetchImpl: stripeMock(cap) });
    assert.equal(r.status, 303, sku);
    assert.equal(r.headers.get('location'), 'https://www.fruitypuppy.com' + to, sku);
    assert.equal(cap.length, 0, sku);
  }
});

test('direct buy: crawlers and link previewers get the product page, no session', async () => {
  for (const ua of ['Twitterbot/1.0', 'facebookexternalhit/1.1', 'Slackbot-LinkExpanding 1.0', 'Googlebot/2.1', 'curl/8.5.0', '']) {
    const cap = [];
    const r = await buy(get('/api/buy?sku=FP-2OZ', { 'user-agent': ua }), { fetchImpl: stripeMock(cap) });
    assert.equal(r.status, 303); assert.equal(r.headers.get('location'), 'https://www.fruitypuppy.com/store/product/fruity-puppy-original');
    assert.equal(cap.length, 0, ua);
  }
});

test('direct buy: Stripe failure or missing key falls back to the product page', async () => {
  const r = await buy(get('/api/buy?sku=FP-2OZ'), { fetchImpl: async () => new Response('{"error":{}}', { status: 400 }) });
  assert.equal(r.headers.get('location'), 'https://www.fruitypuppy.com/store/product/fruity-puppy-original');
  delete process.env.STRIPE_SECRET_KEY;
  const r2 = await buy(get('/api/buy?sku=FP-2OZ'), { fetchImpl: stripeMock([]) });
  assert.equal(r2.status, 303); assert.match(r2.headers.get('location'), /product\/fruity-puppy-original$/);
});
