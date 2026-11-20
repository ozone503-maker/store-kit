import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { POST as subPost, GET as subGet } from '../api/subscribe.js';
import { POST as checkout } from '../api/checkout.js';
import { POST as webhook } from '../api/stripe-webhook.js';
import { GET as adminGet } from '../api/admin-orders.js';
import { memoryStore, upstashStore } from '../lib/order-store.js';
import { normalizeEmail, unsubToken, subscribersCsv, notifySignup } from '../lib/subscribers.js';

const WH = 'whsec_test_local_only';
beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_local_only';
  process.env.STRIPE_WEBHOOK_SECRET = WH;
  process.env.ADMIN_TOKEN = 'admin-local-token';
  process.env.UNSUBSCRIBE_SECRET = 'unsub-local';
  delete process.env.SIGNUP_NOTIFY_ENABLED;
});
const req = (body, headers = {}, url = 'https://x/api/subscribe') => new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://www.fruitypuppy.com', 'x-real-ip': '203.0.113.9', ...headers }, body: JSON.stringify(body) });

test('email validation', () => {
  assert.equal(normalizeEmail(' Signup-Test@FruityPuppy.com '), 'signup-test@fruitypuppy.com');
  for (const bad of ['', 'nope', 'a@b', 'a b@c.com', 'a@@c.com', 'x'.repeat(250) + '@c.com']) assert.equal(normalizeEmail(bad), null, bad);
});

test('signup stores, dedupes by lowercase email, never stores raw IP', async () => {
  const store = memoryStore();
  let r = await subPost(req({ email: 'Signup-Test@FruityPuppy.com', website: '', source: '/our-cream' }), { store });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).message, "You're on the list. Good choice.");
  r = await subPost(req({ email: 'signup-test@fruitypuppy.com', source: 'store/' }), { store });
  assert.equal(r.status, 200);
  assert.equal(await store.countSubs(), 1);
  const rec = await store.getSub('signup-test@fruitypuppy.com');
  assert.equal(rec.status, 'subscribed');
  assert.equal(rec.source, 'footer:/our-cream');
  assert.ok(rec.consent_text.includes('Unsubscribe anytime'));
  assert.ok(rec.created_at && rec.ip_hash && !JSON.stringify(rec).includes('203.0.113.9'));
});

test('bad email, honeypot and foreign origin are rejected', async () => {
  const store = memoryStore();
  for (const [body, h, code] of [[{ email: 'nope' }, {}, 400], [{ email: 'bot@example.com', website: 'http://spam' }, {}, 400], [{ email: 'a@example.com' }, { origin: 'https://evil.example' }, 403]]) {
    const r = await subPost(req(body, h), { store });
    assert.equal(r.status, code);
    assert.equal((await r.json()).error, "That didn't take. Try again?");
  }
  assert.equal(await store.countSubs(), 0);
});

test('rate limit per IP', async () => {
  const store = memoryStore();
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await subPost(req({ email: `r${i}@example.com` }), { store })).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
  assert.equal((await subPost(req({ email: 'other@example.com' }, { 'x-real-ip': '198.51.100.1' }), { store })).status, 200);
});

test('notify stays off unless flag is on', async () => {
  let called = 0;
  const f = async () => { called++; return new Response('{}', { status: 200 }); };
  await notifySignup({ email: 'a@example.com', source: 'footer:/' }, { cfg: { enabled: false, apiKey: 'k', from: 'f@x', to: 't@x' }, fetchImpl: f });
  assert.equal(called, 0);
  const store = memoryStore();
  await subPost(req({ email: 'n@example.com' }), { store, fetchImpl: f });
  assert.equal(called, 0);
});

test('signed unsubscribe: GET no change, POST unsubscribes, forget deletes, bad token 403', async () => {
  const store = memoryStore();
  await subPost(req({ email: 'u@example.com' }), { store });
  const t = unsubToken('u@example.com');
  const u = `https://x/api/subscribe?action=unsubscribe&e=u%40example.com&t=${t}`;
  assert.equal((await subGet(new Request(u), { store })).status, 200);
  assert.equal((await store.getSub('u@example.com')).status, 'subscribed');
  assert.equal((await subGet(new Request(u.replace(t, 'bad')), { store })).status, 403);
  await subPost(new Request(u, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' }), { store });
  assert.equal((await store.getSub('u@example.com')).status, 'unsubscribed');
  await subPost(req({ email: 'u@example.com' }), { store });
  assert.equal((await store.getSub('u@example.com')).status, 'subscribed', 'resubscribe works');
  await subPost(new Request(u, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'forget=1' }), { store });
  assert.equal(await store.getSub('u@example.com'), null);
  assert.equal(await store.countSubs(), 0);
});

test('checkout asks Stripe for promotions consent (Fruity Puppy only)', async () => {
  const cap = [];
  const mock = async (url, init) => { cap.push(init); return new Response(JSON.stringify({ id: 'cs_test_x', url: 'https://checkout.stripe.com/c/pay/x' }), { status: 200 }); };
  await checkout(req({ items: [{ sku: 'FP-SAMPLE', quantity: 1 }] }, {}, 'https://x/api/checkout'), { fetchImpl: mock });
  assert.equal(new URLSearchParams(cap[0].body).get('consent_collection[promotions]'), 'auto');
});

function signed(event) {
  const raw = JSON.stringify(event); const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', WH).update(`${t}.${raw}`).digest('hex');
  return new Request('https://x/api/stripe-webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` }, body: raw });
}
const lineMock = async (url) => url.includes('/line_items')
  ? new Response(JSON.stringify({ data: [{ description: 'Free sample', quantity: 1, amount_total: 0, price: { product: { metadata: { sku: 'FP-SAMPLE' } }, metadata: {} } }] }), { status: 200 })
  : new Response('{}', { status: 200 });
const sess = (id, consent) => ({ id, object: 'checkout.session', payment_status: 'paid', amount_total: 0, currency: 'usd', created: 1790000000, metadata: { brand: '' }, customer_details: { email: 'Buyer@Example.com' }, consent_collection: { promotions: 'auto' }, consent });

test('webhook: opt_in buyer joins list with checkout:<sku>; none/unticked does not; consent saved on order', async () => {
  const store = memoryStore();
  const opts = { store, fetchImpl: lineMock, emailCfg: { enabled: false }, fulfill: async () => ({}) };
  assert.equal((await webhook(signed({ id: 'evt_1', type: 'checkout.session.completed', data: { object: sess('cs_test_in', { promotions: 'opt_in' }) } }), opts)).status, 200);
  assert.equal((await webhook(signed({ id: 'evt_2', type: 'checkout.session.completed', data: { object: { ...sess('cs_test_out', null), customer_details: { email: 'quiet@example.com' } } } }), opts)).status, 200);
  const rec = await store.getSub('buyer@example.com');
  assert.equal(rec.source, 'checkout:FP-SAMPLE');
  assert.equal(rec.consent_version, 'stripe-checkout-promotions-2026-11-20');
  assert.equal(await store.getSub('quiet@example.com'), null);
  const o1 = await store.getOrder('cs_test_in'); const o2 = await store.getOrder('cs_test_out');
  assert.equal(o1.consent.promotions, 'opt_in');
  assert.equal(o2.consent.promotions, null);
});

test('admin: subscriber count + CSV need the token', async () => {
  const store = memoryStore();
  await subPost(req({ email: 'c@example.com', source: '/' }), { store });
  await subPost(req({ email: '=cmd@example.com' }, { 'x-real-ip': '198.51.100.7' }), { store });
  assert.equal((await adminGet(new Request('https://x/api/admin-orders?view=subscribers&format=csv'), { store })).status, 401);
  const auth = { authorization: 'Bearer admin-local-token' };
  const j = await (await adminGet(new Request('https://x/api/admin-orders?view=subscribers', { headers: auth }), { store })).json();
  assert.equal(j.count, 2);
  const res = await adminGet(new Request('https://x/api/admin-orders?view=subscribers&format=csv', { headers: auth }), { store });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const csv = await res.text();
  assert.ok(csv.startsWith('email,status,source'));
  assert.ok(csv.includes('"c@example.com","subscribed","footer:/"'));
  assert.ok(csv.includes(`"'=cmd@example.com"`), 'formula-safe');
});

test('upstash store uses fps:subs: keys and rate keys', async () => {
  const cmds = [];
  const f = async (url, init) => { const body = JSON.parse(init.body); cmds.push(...(Array.isArray(body[0]) ? body : [body])); return new Response(JSON.stringify(Array.isArray(body[0]) ? body.map(() => ({ result: 1 })) : { result: 1 }), { status: 200 }); };
  const s = upstashStore({ url: 'https://u', token: 't', fetchImpl: f });
  await s.putSub({ email: 'a@example.com', status: 'subscribed', created_at: new Date().toISOString() });
  await s.hit('sub:abc:1', 600);
  const flat = JSON.stringify(cmds);
  assert.ok(flat.includes('fps:subs:a@example.com') && flat.includes('fps:subs:_index') && flat.includes('fps:rl:sub:abc:1'));
});
