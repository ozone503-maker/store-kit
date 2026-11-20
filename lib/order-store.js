// Durable order storage. Uses an Upstash Redis REST endpoint when configured
// (KV_REST_API_URL/KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN).
// No silent in-memory fallback in production: getOrderStore() returns null when unconfigured,
// and callers fail with 503 so Stripe retries the webhook instead of the order being lost.

export function memoryStore() {
  const kv = new Map();
  const queue = [];
  const subs = [];
  return {
    kind: 'memory',
    async claimEvent(id) { const k = `evt:${id}`; if (kv.has(k)) return false; kv.set(k, '1'); return true; },
    async releaseEvent(id) { kv.delete(`evt:${id}`); },
    async getOrder(id) { const v = kv.get(`order:${id}`); return v ? JSON.parse(v) : null; },
    async putOrder(order) {
      const isNew = !kv.has(`order:${order.id}`);
      kv.set(`order:${order.id}`, JSON.stringify(order));
      if (isNew) queue.push(order.id);
    },
    async listOrderIds(limit = 50) { return queue.slice(-limit).reverse(); },
    async nextOrderSeq() { const n = Number(kv.get('order_seq') || 0) + 1; kv.set('order_seq', String(n)); return n; },
    async setAlias(key, id) { kv.set(`alias:${key}`, id); },
    async getAlias(key) { return kv.get(`alias:${key}`) || null; },
    // Fixed-window counter for rate limits.
    async hit(key, ttlSec) { const k = `rl:${key}`; const n = Number(kv.get(k) || 0) + 1; kv.set(k, String(n)); return n; },
    // Email subscribers (fps:subs:<email>, index fps:subs:_index).
    async getSub(email) { const v = kv.get(`subs:${email}`); return v ? JSON.parse(v) : null; },
    async putSub(rec) { const isNew = !kv.has(`subs:${rec.email}`); kv.set(`subs:${rec.email}`, JSON.stringify(rec)); if (isNew) subs.push(rec.email); },
    async delSub(email) { kv.delete(`subs:${email}`); const i = subs.indexOf(email); if (i >= 0) subs.splice(i, 1); },
    async listSubEmails(limit = 1000) { return subs.slice(-limit).reverse(); },
    async countSubs() { return subs.length; },
  };
}

export function upstashStore({ url, token, prefix = 'fps:', fetchImpl = fetch }) {
  // Prefix isolates this store's keys; the Redis database may be shared with other projects.
  const k = key => `${prefix}${key}`;
  async function cmd(args) {
    const res = await fetchImpl(url.replace(/\/$/, ''), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(`Order store ${args[0]} failed (${res.status})`);
    return body.result;
  }
  return {
    kind: 'upstash',
    async claimEvent(id) { return (await cmd(['SET', k(`evt:${id}`), '1', 'NX', 'EX', String(60 * 60 * 24 * 30)])) === 'OK'; },
    async releaseEvent(id) { await cmd(['DEL', k(`evt:${id}`)]); },
    async getOrder(id) { const v = await cmd(['GET', k(`order:${id}`)]); return v ? JSON.parse(v) : null; },
    async putOrder(order) {
      const created = await cmd(['SET', k(`order:${order.id}`), JSON.stringify(order)]);
      await cmd(['ZADD', k('orders'), 'NX', String(order.created_at_ms || Date.now()), order.id]);
      return created;
    },
    async listOrderIds(limit = 50) { return cmd(['ZRANGE', k('orders'), '0', String(limit - 1), 'REV']); },
    // Order numbers: atomic counter, FP-1001 and up (see lib/orders.js).
    async nextOrderSeq() { return Number(await cmd(['INCR', k('order_seq')])); },
    // Lookups from Stripe payment intent / Printify order id back to the order id.
    async setAlias(key, id) { await cmd(['SET', k(`alias:${key}`), id]); },
    async getAlias(key) { return (await cmd(['GET', k(`alias:${key}`)])) || null; },
    async hit(key, ttlSec) {
      const n = Number(await cmd(['INCR', k(`rl:${key}`)]));
      if (n === 1) await cmd(['EXPIRE', k(`rl:${key}`), String(ttlSec)]);
      return n;
    },
    async getSub(email) { const v = await cmd(['GET', k(`subs:${email}`)]); return v ? JSON.parse(v) : null; },
    async putSub(rec) {
      await cmd(['SET', k(`subs:${rec.email}`), JSON.stringify(rec)]);
      await cmd(['ZADD', k('subs:_index'), 'NX', String(Date.parse(rec.created_at) || Date.now()), rec.email]);
    },
    async delSub(email) { await cmd(['DEL', k(`subs:${email}`)]); await cmd(['ZREM', k('subs:_index'), email]); },
    async listSubEmails(limit = 1000) { return cmd(['ZRANGE', k('subs:_index'), '0', String(limit - 1), 'REV']); },
    async countSubs() { return Number(await cmd(['ZCARD', k('subs:_index')])); },
  };
}

let override;
export function setOrderStore(store) { override = store; }

export function getOrderStore(env = process.env) {
  if (override !== undefined) return override;
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return upstashStore({ url, token });
  return null;
}
