// Store Kit mount for a Next.js site. Copied from ozone503-maker/fruity-puppy next.config.ts.
// Paste the array into `async rewrites() { return { beforeFiles: storeRewrites, afterFiles: [], fallback: [] }; }`.
// It MUST be beforeFiles: otherwise any app/store page in your site shadows the store.
//
// STORE_ORIGIN is the Store Kit Vercel project's production URL (it stays the same after the GitHub rename).
// BRAND is the folder under store/brands/<brand>/. Leave it "" for the default (Fruity Puppy) catalog in store/.
const STORE_ORIGIN = "https://fruity-puppy-store.vercel.app";
const BRAND = ""; // e.g. "brobots"
const q = BRAND ? `?brand=${BRAND}` : "";

export const storeRewrites = [
  { source: "/store", destination: `${STORE_ORIGIN}/${q}` },
  { source: "/store.css", destination: `${STORE_ORIGIN}/store.css` },
  { source: "/cart.js", destination: `${STORE_ORIGIN}/cart.js` },
  { source: "/store/product/:path*", destination: `${STORE_ORIGIN}/product/:path*${q}` },
  { source: "/store/buy/:sku", destination: `${STORE_ORIGIN}/buy/:sku${q}` },
  { source: "/store/api/:path*", destination: `${STORE_ORIGIN}/api/:path*${q}` },
  { source: "/store/cart", destination: `${STORE_ORIGIN}/cart${q}` },
  { source: "/store/cart/", destination: `${STORE_ORIGIN}/cart/${q}` },
  { source: "/store/confirmation", destination: `${STORE_ORIGIN}/confirmation${q}` },
  { source: "/store/confirmation/", destination: `${STORE_ORIGIN}/confirmation/${q}` },
  { source: "/store/cart.js", destination: `${STORE_ORIGIN}/cart.js` },
  { source: "/store/store.css", destination: `${STORE_ORIGIN}/store.css` },
  { source: "/store/signup.js", destination: `${STORE_ORIGIN}/signup.js` },
  { source: "/store/unsubscribe", destination: `${STORE_ORIGIN}/unsubscribe` },
  { source: "/store/admin", destination: `${STORE_ORIGIN}/admin/` },
  { source: "/store/admin/", destination: `${STORE_ORIGIN}/admin/` },
  { source: "/store/ship/:id", destination: `${STORE_ORIGIN}/ship/:id` },
];

// Also add these to your site:
// - redirects: /shop, /cart, /checkout -> /store (permanent: false)
// - Content-Security-Policy: form-action and connect-src must allow https://checkout.stripe.com
// - robots: Disallow /store/buy/, /store/admin, /store/ship/ (the store also sends X-Robots-Tag noindex)
