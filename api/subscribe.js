import { json } from '../lib/http.js';
import { getOrderStore } from '../lib/order-store.js';
import { loadStore } from '../lib/store.js';
import { esc } from '../lib/email.js';
import { CONSENT, normalizeEmail, clientIp, ipHash, upsertSubscriber, notifySignup, verifyUnsubToken } from '../lib/subscribers.js';

// POST /api/subscribe            footer signup { email, website (honeypot, must be empty), source }
// GET  /unsubscribe?e=&t=        signed link: shows status + confirm buttons (no change on GET)
// POST /unsubscribe?e=&t=        unsubscribe (or forget=1 to delete the record); RFC 8058 one-click compatible
const PER_IP = { limit: 5, windowSec: 600 };
const GLOBAL = { limit: 500, windowSec: 3600 };
const FAIL = "That didn't take. Try again?";

function originAllowed(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const { config } = loadStore();
  return [...(config.allowed_origins || []), 'https://fruity-puppy-store.vercel.app'].includes(origin);
}
async function readBody(request) {
  const type = request.headers.get('content-type') || '';
  const raw = await request.text();
  if (raw.length > 4000) return null;
  if (type.includes('application/json')) { try { return JSON.parse(raw || '{}'); } catch { return null; } }
  return Object.fromEntries(new URLSearchParams(raw));
}
const safeSource = s => /^[a-z0-9:/_.-]{1,80}$/i.test(String(s || '')) ? String(s) : 'footer';

async function subscribe(request, deps) {
  if (!originAllowed(request)) return json({ ok: false, error: FAIL }, 403);
  const store = deps.store !== undefined ? deps.store : getOrderStore();
  if (!store) return json({ ok: false, error: FAIL }, 503);
  const body = await readBody(request);
  if (!body) return json({ ok: false, error: FAIL }, 400);
  if (String(body.website || body.company || '').trim()) return json({ ok: false, error: FAIL }, 400); // honeypot
  const email = normalizeEmail(body.email);
  if (!email) return json({ ok: false, error: FAIL }, 400);
  const ip_hash = ipHash(clientIp(request));
  const now = deps.now || new Date();
  try {
    const win = Math.floor(now.getTime() / 1000 / PER_IP.windowSec);
    if (ip_hash && (await store.hit(`sub:${ip_hash}:${win}`, PER_IP.windowSec)) > PER_IP.limit) return json({ ok: false, error: FAIL }, 429);
    const gwin = Math.floor(now.getTime() / 1000 / GLOBAL.windowSec);
    if ((await store.hit(`sub:all:${gwin}`, GLOBAL.windowSec)) > GLOBAL.limit) return json({ ok: false, error: FAIL }, 429);
    const source = `footer:${safeSource(body.source).replace(/^footer:/, '')}`;
    const r = await upsertSubscriber(store, { email, source, consent: CONSENT.footer, ip_hash, now });
    if (r.created) await notifySignup(r.record, { ...(deps.notifyCfg ? { cfg: deps.notifyCfg } : {}), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }).catch(() => {});
    return json({ ok: true, message: "You're on the list. Good choice." });
  } catch {
    return json({ ok: false, error: FAIL }, 503);
  }
}

const page = (title, body, status = 200) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>body{font-family:Georgia,serif;max-width:520px;margin:60px auto;padding:0 18px;color:#251a1d;background:#fff8ef}h1{font-weight:400}button{font:14px Arial,sans-serif;margin:8px 8px 0 0;padding:11px 18px;border-radius:99px;border:1px solid #251a1d;background:#251a1d;color:#fff;cursor:pointer}button.alt{background:transparent;color:#251a1d}p{line-height:1.6}a{color:#e0517d}</style></head><body>${body}<p><a href="https://www.fruitypuppy.com/">Back to Fruity Puppy</a></p></body></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' } });

async function unsubscribe(request, deps, method) {
  const url = new URL(request.url);
  const store = deps.store !== undefined ? deps.store : getOrderStore();
  const email = normalizeEmail(url.searchParams.get('e'));
  const t = url.searchParams.get('t') || '';
  if (!process.env.UNSUBSCRIBE_SECRET || !store) return page('Unavailable', '<h1>Unsubscribe is not set up yet.</h1>', 503);
  if (!email || !verifyUnsubToken(email, t)) return page('Link not valid', '<h1>This link is not valid.</h1>', 403);
  const rec = await store.getSub(email);
  if (method === 'GET') {
    if (!rec) return page('Not on the list', `<h1>${esc(email)} is not on the list.</h1>`);
    if (rec.status !== 'subscribed') return page('Unsubscribed', `<h1>${esc(email)} is unsubscribed.</h1><p>No more Fruity Puppy emails.</p>`);
    return page('Unsubscribe', `<h1>Leave the list?</h1><p>${esc(email)} gets Fruity Puppy emails.</p><form method="post"><button type="submit">Unsubscribe</button><button class="alt" type="submit" name="forget" value="1">Unsubscribe and delete my email</button></form>`);
  }
  const body = await readBody(request) || {};
  if (body.forget === '1') {
    if (rec) await store.delSub(email);
    return page('Deleted', `<h1>Done. ${esc(email)} is off the list and deleted.</h1>`);
  }
  if (rec && rec.status === 'subscribed') {
    const at = new Date().toISOString();
    await store.putSub({ ...rec, status: 'unsubscribed', unsubscribed_at: at, updated_at: at });
  }
  return page('Unsubscribed', `<h1>You're unsubscribed.</h1><p>No more Fruity Puppy emails to ${esc(email)}.</p>`);
}

export async function POST(request, deps = {}) {
  const action = new URL(request.url).searchParams.get('action');
  if (action === 'unsubscribe') return unsubscribe(request, deps, 'POST');
  return subscribe(request, deps);
}
export async function GET(request, deps = {}) {
  const action = new URL(request.url).searchParams.get('action');
  if (action === 'unsubscribe') return unsubscribe(request, deps, 'GET');
  return json({ error: 'Method not allowed' }, 405);
}
