// Email list ("Get on the list."). Records live in Upstash Redis under fps:subs:<lowercase email>.
// Nothing here sends marketing email. The optional per-signup notification to the team is OFF unless
// SIGNUP_NOTIFY_ENABLED=true (plus RESEND_API_KEY, ORDER_EMAIL_FROM and SIGNUP_NOTIFY_TO).
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { esc } from './email.js';

export const CONSENT = {
  footer: { version: 'footer-2026-11-20', text: 'By signing up you agree to get Fruity Puppy emails. Unsubscribe anytime.' },
  checkout: { version: 'stripe-checkout-promotions-2026-11-20', text: 'Stripe Checkout promotional emails checkbox (unchecked by default), ticked by the buyer.' },
};

export function normalizeEmail(raw) {
  const e = String(raw ?? '').trim().toLowerCase();
  if (!e || e.length > 254) return null;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(e)) return null;
  const tld = e.split('.').pop();
  if (tld.length < 2 || /^\d+$/.test(tld)) return null;
  return e;
}

export function clientIp(request, proxyKey = process.env.FP_PROXY_KEY) {
  const h = request.headers;
  const first = v => (v || '').split(',')[0].trim();
  // Requests proxied by www.fruitypuppy.com carry the visitor IP plus a shared key (see main-site middleware.ts).
  const given = h.get('x-fp-proxy-key');
  if (proxyKey && given && given.length === proxyKey.length && timingSafeEqual(Buffer.from(given), Buffer.from(proxyKey)) && first(h.get('x-fp-client-ip'))) return first(h.get('x-fp-client-ip'));
  return first(h.get('x-vercel-forwarded-for')) || first(h.get('x-real-ip')) || first(h.get('x-forwarded-for')) || '';
}
export function ipHash(ip, salt = process.env.UNSUBSCRIBE_SECRET || 'fps-subs') {
  if (!ip) return null;
  return createHash('sha256').update(`fps-subs-ip:${salt}:${ip}`).digest('hex').slice(0, 24);
}

// Adds or refreshes a subscriber. Returns { created, resubscribed, record }.
export async function upsertSubscriber(store, { email, source, consent, ip_hash = null, now = new Date() }) {
  const at = now.toISOString();
  const existing = await store.getSub(email);
  if (existing) {
    const sources = Array.from(new Set([...(existing.sources || [existing.source]), source]));
    const resubscribed = existing.status !== 'subscribed';
    const record = { ...existing, sources, updated_at: at, ...(resubscribed ? { status: 'subscribed', resubscribed_at: at, consent_text: consent.text, consent_version: consent.version, consent_at: at, unsubscribed_at: null } : {}) };
    await store.putSub(record);
    return { created: false, resubscribed, record };
  }
  const record = { email, status: 'subscribed', source, sources: [source], consent_text: consent.text, consent_version: consent.version, consent_at: at, created_at: at, updated_at: at, ip_hash };
  await store.putSub(record);
  return { created: true, resubscribed: false, record };
}

// Signed unsubscribe links: /store/unsubscribe?e=<email>&t=<token>.
export function unsubToken(email, secret = process.env.UNSUBSCRIBE_SECRET) {
  if (!secret) return null;
  return createHmac('sha256', secret).update(`unsub:${email}`).digest('base64url').slice(0, 32);
}
export function verifyUnsubToken(email, token, secret = process.env.UNSUBSCRIBE_SECRET) {
  const want = unsubToken(email, secret);
  if (!want || !token) return false;
  const a = Buffer.from(String(token)); const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function unsubLink(email, base = (process.env.STORE_PUBLIC_BASE || 'https://www.fruitypuppy.com/store').replace(/\/$/, '')) {
  const t = unsubToken(email);
  return t ? `${base}/unsubscribe?e=${encodeURIComponent(email)}&t=${t}` : null;
}

// Team notification (OFF by default).
export function notifyConfig(env = process.env) {
  return { enabled: env.SIGNUP_NOTIFY_ENABLED === 'true', apiKey: env.RESEND_API_KEY || '', from: env.ORDER_EMAIL_FROM || '', to: env.SIGNUP_NOTIFY_TO || '' };
}
export const canNotify = c => !!(c.enabled && c.apiKey && c.from && c.to);
export async function notifySignup(record, { cfg = notifyConfig(), fetchImpl = fetch } = {}) {
  if (!canNotify(cfg)) return { skipped: true, reason: 'disabled' };
  const text = `New Fruity Puppy list signup\n\nEmail: ${record.email}\nSource: ${record.source}\nAt: ${record.created_at}`;
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `signup/${record.email}` },
      body: JSON.stringify({ from: cfg.from, to: [cfg.to], subject: `New list signup: ${record.email}`, text, html: `<p>New Fruity Puppy list signup</p><p>Email: ${esc(record.email)}<br>Source: ${esc(record.source)}<br>At: ${esc(record.created_at)}</p>` }),
    });
    return { status: res.ok ? 'sent' : 'failed' };
  } catch { return { status: 'failed' }; }
}

// CSV (formula-safe, every cell quoted).
const COLS = ['email', 'status', 'source', 'sources', 'consent_version', 'consent_text', 'consent_at', 'created_at', 'updated_at', 'unsubscribed_at', 'ip_hash'];
function cell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}
export function subscribersCsv(records) {
  const rows = [COLS.join(',')];
  for (const r of records) {
    const v = { ...r, sources: (r.sources || []).join('; '), consent_version: r.consent_version ?? r.consent?.version, consent_text: r.consent_text ?? r.consent?.text, consent_at: r.consent_at ?? r.consent?.at };
    rows.push(COLS.map(c => cell(v[c])).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}
