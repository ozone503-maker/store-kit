// Store Kit mount: buy links. Copied from ozone503-maker/fruity-puppy app/shop-links.ts.
//
// /store/product/<product id>  -> the product page (id from catalog.json `products[].id`)
// /store/buy/<SKU>             -> one unit straight to Stripe Checkout (SKU from `variants[].sku`).
//                                 Bots/crawlers (curl, wget, headless, python-requests...) are sent to the
//                                 product page instead, so test it in a real browser or with a browser User-Agent.
// /store                       -> the store home
export const SHOP = {
  original: "/store/product/fruity-puppy-original",
  faceJuice: "/store/product/thorny-toad",
} as const;

export const BUY = {
  original: "/store/buy/FP-2OZ",
  sample: "/store/buy/FP-SAMPLE",
} as const;

// Usage: <a href={BUY.original}>Buy now</a>   (a plain link; no client JS needed)
