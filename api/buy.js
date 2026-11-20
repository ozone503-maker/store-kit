import { loadStore } from '../lib/store.js';
import { rateLimit } from '../lib/rate.js';
import { createStripeSession, validateItems } from './checkout.js';

// Direct buy: GET /buy/<sku> creates a Stripe Checkout session for one unit of an
// available SKU and 303-redirects to Stripe. Anything that cannot be bought (unknown,
// inactive, coming soon) never reaches Stripe; it redirects to the product page or shop.
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|whatsapp|telegram|discord|slack|skype|vkshare|pinterest|linkedin|quora|redditbot|bitly|headless|lighthouse|curl\/|wget|python-requests|httpclient|go-http-client/i;
const FP_HOME = 'https://www.fruitypuppy.com';

function storeBase(config, brand, request) {
  const allowed = config.allowed_origins || [];
  for (const h of [request.headers.get('referer'), request.headers.get('origin')]) {
    try { const u = new URL(h); if (allowed.includes(u.origin)) return { origin: u.origin, base: brand ? '' : '/store' }; } catch {}
  }
  if (!brand) return { origin: FP_HOME, base: '/store' };
  return { origin: allowed[0] || FP_HOME, base: '' };
}

const redirect = (location, extra = {}) => new Response(null, {
  status: 303,
  headers: { Location: location, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', ...extra },
});

export async function GET(request, { fetchImpl = fetch } = {}) {
  const limited = rateLimit(request, { limit: 20 });
  if (limited) return limited;

  const url = new URL(request.url);
  const sku = url.searchParams.get('sku') || decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
  const brand = url.searchParams.get('brand') || undefined;
  const q = brand ? `?brand=${encodeURIComponent(brand)}` : '';

  let store;
  try { store = loadStore(brand); } catch { return redirect(FP_HOME + '/store'); }
  const { config, catalog } = store;
  const { origin, base } = storeBase(config, brand, request);
  const shop = `${origin}${base}/${q}`;

  const product = catalog.products.find(p => (p.variants || []).some(v => v.sku === sku));
  const productPage = product ? `${origin}${base}/product/${encodeURIComponent(product.id)}${q}` : shop;

  const check = validateItems({ items: [{ sku, quantity: 1 }] }, catalog, 1);
  if (check.error || product?.coming_soon || product?.draft) return redirect(productPage);

  // Crawlers and link previewers must not mint Stripe sessions; send them to the product page.
  const ua = request.headers.get('user-agent') || '';
  if (!ua || BOT_UA.test(ua)) return redirect(productPage);

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return redirect(productPage);

  const result = await createStripeSession({
    lines: check.lines, config, brand,
    hint: `${origin}${base}/confirmation`,
    stripeKey, fetchImpl,
  });
  if (result.error || !/^https:\/\/checkout\.stripe\.com\//.test(result.url || '')) return redirect(productPage);
  return redirect(result.url);
}

export function HEAD(request) {
  return new Response(null, { status: 405, headers: { Allow: 'GET', 'X-Robots-Tag': 'noindex, nofollow' } });
}
