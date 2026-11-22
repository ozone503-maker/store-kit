import { SOCIAL_HTML } from '../lib/social-html.js';
import { loadStore } from '../lib/store.js';
import { rateLimit } from '../lib/rate.js';

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function GET(request) {
  const limited = rateLimit(request, { limit: 60 });
  if (limited) return limited;

  const url = new URL(request.url);
  const id = url.searchParams.get('id') || url.pathname.split('/').filter(Boolean).pop();
  const brand = url.searchParams.get('brand') || undefined;
  if (!id) return new Response('Missing product id', { status: 400 });

  const { catalog, config } = loadStore(brand);
  const product = catalog.products.find((p) => p.id === id);
  if (!product) return new Response('Product not found', { status: 404 });

  const variants = product.variants || [];
  const first = variants[0] || {};
  const sub = product.subscription;
  const price = first.price_cents ? `$${(first.price_cents / 100).toFixed(2)}${sub ? ` a ${sub.interval || 'month'}` : ''}` : '$5 shipping';
  const images = (product.images || []).map((src) => `<img src="${esc(/^https?:/.test(src) ? src : '../' + src)}" alt="${esc(product.title)}">`).join('');
  const buyable = variants.filter((v) => v.active !== false);
  const soldOut = !buyable.length;
  const options = buyable.length > 1 ? buyable.map((v) => `<option value="${esc(v.sku)}">${esc(v.title)} ($${(v.price_cents / 100).toFixed(2)})</option>`).join('') : '';
  const firstBuy = buyable[0] || first;

  const chart = product.size_chart;
  const chartHtml = chart && chart.rows && chart.rows.length
    ? `<section class="size-chart"><h2>${esc(chart.title || 'Size chart')}</h2><p class="muted">${esc(chart.note || '')}</p><table><thead><tr>${chart.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${chart.rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></section>`
    : '';

  const suggested = (product.pairs || [])
    .map((pid) => catalog.products.find((p) => p.id === pid))
    .filter((p) => p && (p.variants || []).some((v) => v.active !== false))
    .slice(0, 3);
  const suggestHtml = suggested.length
    ? `<section class="suggest-block"><h2>Suggested</h2><div class="grid">${suggested.map((p) => {
        const v = p.variants.find((x) => x.active !== false) || {};
        const pPrice = v.price_cents ? `$${(v.price_cents / 100).toFixed(2)}` : '';
        return `<div class="card"><h3><a class="prod-link" data-id="${esc(p.id)}" href="${esc(p.id)}">${esc(p.title)}</a></h3><p class="price">${pPrice}</p><button class="add" data-add-sku="${esc(v.sku || '')}">Add to cart</button></div>`;
      }).join('')}</div></section>`
    : '';

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(product.title)} · ${esc(config.name || 'Shop')}</title>
<meta name="description" content="${esc((product.description || '').slice(0, 160))}">
<link id="css" rel="stylesheet" href="../store.css">
</head>
<body class="${brand || /brobots|kudoken/.test(url.hostname) ? '' : 'fp'}">
<header class="fp-head">
  <a class="fp-logo" id="home" href="https://www.fruitypuppy.com/" data-site-home>${esc(config.name || 'Shop')}</a>
  <nav><a href="https://www.fruitypuppy.com/" data-site-home>Home</a> <a id="shop" href="../">Shop</a> <a id="cart-link" href="../cart/">Cart</a></nav>
</header>
<main class="product">
  <div class="images">${images || '<p>No photos yet</p>'}</div>
  <div class="info">
    <h1>${esc(product.title)}</h1>
    <p class="desc">${esc(product.description || '')}</p>
    <p class="price">${price}</p>
    ${options ? `<label>Color <select id="sku">${options}</select></label>` : ''}
    ${product.coming_soon ? '<p class="stock-out">Coming soon. Not for sale yet.</p><button class="add" type="button" disabled>Coming soon</button>' : product.draft ? '<p class="stock-out">Coming soon. Not for sale yet; colors and sizes are planned, not confirmed with the printer.</p><button class="add" type="button" disabled>Coming soon</button>' : soldOut ? '<p class="stock-out">Out of stock right now</p><button class="add" type="button" disabled>Out of stock</button>' : sub ? `<a class="add join" data-buy-sku="${esc(firstBuy.sku || '')}" href="../buy/${esc(encodeURIComponent(firstBuy.sku || ''))}">Join The Fridge Club</a><p class="muted">$${(firstBuy.price_cents / 100).toFixed(2)} charged when you join, then every ${esc(sub.interval || 'month')}. ${sub.cancel_email ? `To cancel, email <a href="mailto:${esc(sub.cancel_email)}?subject=Cancel%20my%20Fridge%20Club">${esc(sub.cancel_email)}</a>. No further charges after you cancel.` : ''}</p>` : `<button class="add" data-add-sku="${esc(firstBuy.sku || '')}">Add to cart</button>`}
    ${chartHtml}
  </div>
</main>
${suggestHtml}
<footer class="fp-foot"><a id="back" href="../">Back to shop</a>${brand || /brobots|kudoken/.test(url.hostname) ? '' : SOCIAL_HTML}</footer>
<script>
const BASE = location.pathname.startsWith('/store') ? '/store' : '';
const brand = new URLSearchParams(location.search).get('brand') || (location.hostname.includes('kudoken') ? 'kudoken' : location.hostname.includes('brobots') ? 'brobots' : '');
const brandQ = brand ? '?brand=' + brand : '';
document.getElementById('css').href = BASE + '/store.css';
document.getElementById('shop').href = BASE + '/' + brandQ;
document.getElementById('cart-link').href = BASE + '/cart' + brandQ;
document.getElementById('back').href = BASE + '/' + brandQ;
document.querySelectorAll('.prod-link').forEach(a => a.href = BASE + '/product/' + a.dataset.id + brandQ);
document.querySelectorAll('[data-buy-sku]').forEach(a => a.href = BASE + '/buy/' + encodeURIComponent(a.dataset.buySku) + brandQ);
const sel = document.getElementById('sku');
const btn = document.querySelector('.add');
if (sel && btn) sel.addEventListener('change', () => btn.dataset.addSku = sel.value);
const s = document.createElement('script');
s.src = BASE + '/cart.js';
if (!new URLSearchParams(location.search).get('brand') && !/brobots|kudoken/.test(location.hostname)) { const g = document.createElement('script'); g.src = BASE + '/signup.js'; g.defer = true; document.head.appendChild(g); }
document.body.appendChild(s);
</script>
<script defer src="/_vercel/insights/script.js"></script>
</body></html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=60' } });
}
