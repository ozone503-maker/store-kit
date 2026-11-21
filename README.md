# Store Kit

One store program for every brand: storefront, cart, Stripe Checkout, order book, email list,
3PL + Printify fulfillment and tracking emails. A new store is a catalog and a config, not a rebuild.

**Repo:** https://github.com/ozone503-maker/store-kit (GitHub template; was `fruity-puppy-store`)
**Vercel project:** `fruity-puppy-store` (team `ozone503-6682`) → https://fruity-puppy-store.vercel.app

| Brand | Public URL | Catalog | Mounted by |
|-------|-----------|---------|------------|
| Fruity Puppy (default) | https://www.fruitypuppy.com/store | `store/catalog.json` + `store/config.json` | `ozone503-maker/fruity-puppy` (Next.js rewrites) |
| Brobots | https://brobots.space/store | `store/brands/brobots/` | `ozone503-maker/brobots-space-academy` (`vercel.json`, `?brand=brobots`) |
| Kudoken | https://kudoken.space/store | `store/brands/kudoken/` | `ozone503-maker/kudoken` (`vercel.json`, `?brand=kudoken`) |

Bots: read this file, then `store/OPERATOR.md`, before touching anything. Order and email details are in
`store/ORDERS.md`; the email list is in `store/SUBSCRIBERS.md`.

## Contents

1. [What every store gets](#what-every-store-gets)
2. [How it fits together](#how-it-fits-together)
3. [New store checklist](#new-store-checklist)
4. [Per-store settings](#per-store-settings)
5. [Environment variables](#environment-variables)
6. [Stripe setup](#stripe-setup)
7. [Printify: how an agent drives it](#printify-how-an-agent-drives-it)
8. [Testing](#testing)
9. [Approval gates and security rules](#approval-gates-and-security-rules)
10. [Mockups, standard catalog issue, merch menu](#mockups)

## What every store gets

These are part of the program. They are not rebuilt per brand.

- **Storefront**: store home, product pages (`/store/product/<id>`), suggested products from `pairs`
  (otherwise the rest of the catalog).
- **Cart**: drawer plus `/store/cart`. Quantity, remove, subtotal. One cart per brand.
- **Direct buy**: `/store/buy/<SKU>` creates a Stripe Checkout session for one unit and 303-redirects to it.
- **Checkout**: Stripe Checkout. Uses `stripe_price_id` when linked, otherwise inline price data. Shipping
  options and the free-shipping threshold come from the brand config. Optional email opt-in
  (`CHECKOUT_PROMO_CONSENT`).
- **Confirmation**: `/store/confirmation` after Stripe. Cart clears, receipt line shown.
- **Order book**: the Stripe webhook writes every order to Upstash Redis (prefix `fps:`), numbered
  `FP-1001`, `FP-1002`… (non-default brands use the first two letters of the brand). Refunds and
  failures are recorded. `/store/admin` (Bearer `ADMIN_TOKEN`) lists, filters, marks shipped, resends
  emails, retries Printify, and exports CSV.
- **Fulfillment**: Printify lines become Printify orders (draft; `send_to_production` stays false).
  Default-brand warehouse lines get a 3PL email with a signed ship link (`/store/ship/<id>`).
- **Emails** (off until switched on): customer thank-you, shipping/tracking, 3PL order email, via Resend.
- **Email list**: "Get on the list." footer form → `/store/api/subscribe`, stored at
  `fps:subs:<email>`, CSV export, signed unsubscribe links (`/store/unsubscribe`).

## How it fits together

```
brand site (fruitypuppy.com, brobots.space, …)
   └─ /store/*  ── rewrite ──▶  fruity-puppy-store.vercel.app  (this repo)
                                  ├─ public/          static storefront, cart, confirmation, admin, signup.js
                                  ├─ api/*.js         Vercel functions (Web Request/Response handlers)
                                  ├─ lib/             Stripe, Printify, Upstash, email, ledger, subscribers
                                  └─ store/           catalogs + configs (bundled into every function)
Stripe ── webhook ──▶ /store/api/stripe-webhook      Printify ── webhook ──▶ /store/api/printify-webhook
```

| Path | Handler | What it does |
|------|---------|--------------|
| `/store`, `/store/cart`, `/store/confirmation` | `public/` | Static pages; brand chosen by `?brand=` |
| `/store/product/<id>` | `api/product.js` | Server-rendered product page with share tags |
| `/store/buy/<SKU>` | `api/buy.js` | One unit → Stripe Checkout (303). Bots go to the product page instead. |
| `/store/api/checkout` | `api/checkout.js` | Cart → Stripe Checkout session |
| `/store/api/catalog` | `api/catalog.js` | Catalog JSON for the storefront |
| `/store/api/stripe-webhook` | `api/stripe-webhook.js` | Signed Stripe events → order book, fulfillment, emails |
| `/store/api/printify-webhook` | `api/printify-webhook.js` | Signed Printify shipment events → tracking + email |
| `/store/api/order-status` | `api/order-status.js` | Confirmation page lookup |
| `/store/api/admin-orders` | `api/admin-orders.js` | Admin API (Bearer `ADMIN_TOKEN`), CSV export |
| `/store/api/stripe-sync` | `api/stripe-sync.js` | Admin: link catalog SKUs to Stripe prices |
| `/store/api/subscribe` | `api/subscribe.js` | Email list signup / unsubscribe |
| `/store/ship/<id>` | `api/ship.js` | 3PL "mark shipped + tracking" page (signed link) |

The mount rules for a brand site are in [`mount/`](mount/README.md) (Next.js and plain `vercel.json`).

## New store checklist

1. **Folder**: create `store/brands/<brand>/` (lowercase, no spaces; this is the `?brand=` value).
2. **`config.json`**: copy `store/brands/brobots/config.json` and change:
   - `name`, `tagline`, `currency`, `theme` colours
   - `allowed_origins`: every origin that will mount the store (e.g. `https://example.com`, `https://www.example.com`)
   - `shipping.options`, `free_over_cents`, `countries`
   - `checkout.promo_codes`, `checkout.automatic_tax`
   - `default_fulfiller` and `fulfillers` (see below)
3. **`catalog.json`**: `{ "products": [ … ] }`. Each product:
   ```jsonc
   {
     "id": "brand-tee",                 // URL slug: /store/product/brand-tee
     "title": "Brand Tee",
     "brand": "Brand",
     "type": "Apparel",
     "description": "…",
     "images": ["https://…/character-wearing-it.webp"],
     "tags": ["tee"],
     "pairs": ["brand-hoodie"],
     "fulfiller": "printify",           // or "warehouse" / "printshop" (manual)
     "variants": [
       { "sku": "BR-TEE-M", "title": "M", "price_cents": 2800, "active": true,
         "stripe_price_id": "price_… (optional)",
         "printify_product_id": "<24-hex id>", "printify_variant_id": 12345 }
     ]
   }
   ```
   SKUs must be unique across all brands. Printify products are best created with the merch factory
   (below), which writes these fields for you.
4. **Check it**: `npm run check` (validates every brand; exits 1 on errors such as a Printify variant
   with no Printify IDs, which could be bought but never fulfilled).
5. **Mount it** on the brand's site with [`mount/`](mount/README.md), using `?brand=<brand>`.
6. **Commit and push.** Vercel deploys `main` to production. Then run the live checks in [Testing](#testing).

## Per-store settings

| Setting | Where | Notes |
|---------|-------|-------|
| Products, SKUs, prices, images | `catalog.json` | Prices in cents. |
| Name, theme, shipping, origins | `config.json` | `allowed_origins` controls where `/buy` sends the customer back to. |
| Stripe account | `STRIPE_SECRET_KEY` | **One key for every brand today** (Fight Church Media, `acct_1D1Gw8FbLd9Fo05X`). A store on its own Stripe account needs a small code change (per-brand key env + its own webhook secret). |
| Printify shop | `config.fulfillers.printify.token_env` / `shop_id_env` | Names of the env vars to read. Default `PRINTIFY_TOKEN` / `PRINTIFY_SHOP_ID`. A brand can point at its own, e.g. `PRINTIFY_SHOP_ID_BROBOTS`. |
| 3PL email | `THREEPL_EMAIL` | Only default-brand (`warehouse`, manual) lines go to the 3PL (`lib/orders.js` `THREEPL_BRAND`). Fruity Puppy: RX Star, info@rxstarusa.com. |
| Order numbers | `lib/orders.js` | `FP-` for the default brand, first two letters for others; one shared counter. |
| Storage prefix | `lib/order-store.js` | `fps:` for all brands (orders carry a `brand` field). |
| Email list | `lib/subscribers.js` | Default brand only for now. |
| Public base for links in emails | `STORE_PUBLIC_BASE` | Default `https://www.fruitypuppy.com/store`. |

## Environment variables

Names only. Values live in Vercel (Project → Settings → Environment Variables) and must never be
committed, pasted in chat, or printed in logs. Add with `vercel env add <NAME> production`, then redeploy.

| Name | Required | What it does |
|------|----------|--------------|
| `STRIPE_SECRET_KEY` | yes | Stripe secret key of the account that charges. |
| `STRIPE_WEBHOOK_SECRET` | yes | Signing secret (`whsec_…`) of the Stripe webhook endpoint. |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | yes | Upstash Redis (Vercel Marketplace integration sets these). `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` also work. |
| `ADMIN_TOKEN` | yes | Bearer token for `/store/admin` and the admin API. Long random string. |
| `UNSUBSCRIBE_SECRET` | yes (email list) | Signs unsubscribe links. |
| `PRINTIFY_TOKEN` | for Printify | Printify Personal Access Token. |
| `PRINTIFY_SHOP_ID` | for Printify | Printify shop ID (`GET /v1/shops.json`). |
| `PRINTIFY_WEBHOOK_SECRET` | for tracking | Secret used when registering the Printify webhook; verifies `x-pfy-signature`. |
| `RESEND_API_KEY` | for emails | Resend API key. |
| `ORDER_EMAIL_FROM` | for emails | Sender on a domain verified in Resend. |
| `ORDER_EMAIL_REPLY_TO` | optional | Reply-to (default fruitypuppyskincream@gmail.com). |
| `ORDER_EMAILS_ENABLED` | switch | `true` sends customer thank-you and shipping emails. Off by default. |
| `THREEPL_EMAIL` | for 3PL | Where the 3PL order email goes. |
| `THREEPL_EMAILS_ENABLED` | switch | `true` sends 3PL emails. Off by default. |
| `SHIP_LINK_SECRET` | for 3PL | Signs `/store/ship/<id>` links. |
| `CHECKOUT_PROMO_CONSENT` | optional | `dropdown` = custom "Fruity Puppy emails?" field (default No thanks); `stripe` = Stripe's promotions checkbox (needs Checkout terms accepted); unset = no opt-in. |
| `SIGNUP_NOTIFY_TO` | optional | Address told about each new signup. |
| `SIGNUP_NOTIFY_ENABLED` | switch | `true` sends those notifications. Off by default. |
| `FP_PROXY_KEY` | optional | Shared with the mounting site; lets it pass the visitor IP for signup rate limiting. |
| `STORE_PUBLIC_BASE` | optional | Public base URL used in emails and unsubscribe links. |
| `STORE_DIR` | dev/test | Alternative `store/` folder. |

Generate random secrets locally (`openssl rand -hex 32`) and paste them straight into `vercel env add`.

## Stripe setup

1. Use the Stripe account that should receive the money; put its secret key in `STRIPE_SECRET_KEY`.
2. Dashboard → Developers → Webhooks → **Add endpoint**:
   - URL: `https://<brand site>/store/api/stripe-webhook` (Fruity Puppy:
     `https://www.fruitypuppy.com/store/api/stripe-webhook`). One endpoint serves every brand on the
     same Stripe account.
   - Events (5): `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
     `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`.
3. Copy the endpoint's signing secret into `STRIPE_WEBHOOK_SECRET` (Production and Preview), redeploy.
4. Make sure the endpoint is **enabled**. The handler is signature-verified and idempotent; on a
   failure it returns 5xx so Stripe retries.
5. Optional: link catalog SKUs to Stripe Prices from `/store/admin` (`/api/stripe-sync`).
6. Optional: to use Stripe's own marketing checkbox, accept the Checkout terms at
   https://dashboard.stripe.com/settings/checkout, then set `CHECKOUT_PROMO_CONSENT=stripe`.
   Setting `stripe` before accepting the terms makes every checkout fail.

## Printify: how an agent drives it

**Auth.** Printify dashboard → My Account → Connections/API → create a Personal Access Token with
scopes `shops.read`, `catalog.read`, `uploads.write`, `products.read`, `products.write`,
`orders.read`, `orders.write`, `webhooks.read`, `webhooks.write`. Store it as `PRINTIFY_TOKEN` in Vercel
(and only in a local `.env`, which is git-ignored, when running tools). All calls go to
`https://api.printify.com/v1` with `Authorization: Bearer <token>`. `lib/printify.js` wraps them.

**Create a product (merch factory).** `tools/merch-factory.js` does steps 2–7 for you:

```
# 1. Look before you create: resolve blueprint, provider and variants live; creates nothing.
PRINTIFY_TOKEN=… PRINTIFY_SHOP_ID=… node tools/merch-factory.js --brand brobots \
  --image https://…/design.png --title "Brobots Factory Tee" --type "unisex heavy cotton tee" --dry-run

# 2. Create it and write it into store/brands/brobots/catalog.json
… same command without --dry-run [--colors "Black" --sizes "S,M,L,XL,2XL" --price 2800]
```

| Step | Call | `lib/printify.js` |
|------|------|-------------------|
| 1. Find the shop | `GET /shops.json` | `listShops()` |
| 2. Find the blueprint (product type) | `GET /catalog/blueprints.json` (match title) | `listBlueprints()`, `getBlueprint(id)` |
| 3. Pick a provider (Printify Choice, else US) | `GET /catalog/blueprints/{bp}/print_providers.json`, `GET /catalog/print_providers/{id}.json` | `listPrintProviders()`, `getPrintProvider()` |
| 4. Pick variants (colour, S–XL) | `GET /catalog/blueprints/{bp}/print_providers/{pp}/variants.json` | `listVariants()` |
| 5. Upload the design | `POST /uploads/images.json` (`url` or base64 `contents`) | `uploadImage()` |
| 6. Create the product | `POST /shops/{shop}/products.json` | `createProduct()` |
| 7. Read it back | `GET /shops/{shop}/products/{id}.json` | `getProduct()` |
| 8. Write to the catalog | product + per-variant `printify_product_id` / `printify_variant_id` | merch factory |
| 9. Commit | `npm run check && npm test`, then push | |

Never hardcode blueprint, provider or variant IDs; they change. The factory resolves them live
(`lib/printify-resolve.js`). `--blueprint` / `--provider` still work but are checked against the live catalog.

**Orders.** When a paid Stripe order contains Printify lines, the webhook calls
`POST /shops/{shop}/orders.json` (`createOrder()`) with the stored product/variant IDs and the
shipping address. `send_to_production` stays **false**: orders wait as drafts in Printify until a human
(or an approved agent) sends them (`POST /shops/{shop}/orders/{id}/send_to_production.json`).
Retry failed submissions from `/store/admin`.

**Tracking.** Register once per shop (needs Jessie's yes, it is an external change):
`POST /shops/{shop}/webhooks.json` with `{"topic":"order:shipment:created","url":"https://www.fruitypuppy.com/store/api/printify-webhook","secret":"<PRINTIFY_WEBHOOK_SECRET>"}`.
The handler verifies `x-pfy-signature` (HMAC-SHA256), records tracking, and emails the customer
when emails are on. Check registrations with `listWebhooks()`.

**Listing photos.** Printify is fulfillment only. The listing image is a character wearing the gear
(`store/characters/`). Printify mockups are only a fallback until that photo exists.

## Testing

```
npm test          # unit tests (node --test), no network, no secrets
npm run check     # catalog/config validation for every brand
npm run dev       # local preview at http://localhost:3000/store/ (static + api handlers)
```

Live checks after a deploy. `/store/buy/<SKU>` deliberately sends bots (curl, wget, headless,
python-requests, link previewers…) to the product page, so always send a browser User-Agent:

```
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
curl -s -o /dev/null -w '%{http_code}\n' -A "$UA" https://www.fruitypuppy.com/store                   # 200
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -A "$UA" https://www.fruitypuppy.com/store/buy/FP-SAMPLE  # 303 https://checkout.stripe.com/…
curl -s -o /dev/null -w '%{http_code}\n' -A "$UA" https://brobots.space/store                         # 200
curl -s -o /dev/null -w '%{http_code}\n' -A "$UA" https://kudoken.space/store                         # 200
```

Do not complete a checkout to test; the account is live. Webhook changes are tested with signed test
events, never by echoing the signing secret.

## Approval gates and security rules

Stop and get Jessie's explicit yes (an agent's say-so is not approval) before:

- spending money, or sending a Printify order to production
- publishing a new product or a major page change
- emailing customers, the 3PL or anyone else, or turning on any `*_ENABLED` email switch
- changing Stripe settings, webhook endpoints or the Stripe account
- deleting anything irreversible

Security:

- Never print, echo, commit or paste a secret or token (Stripe keys, `whsec_…`, `ADMIN_TOKEN`,
  Printify token, Resend key, proxy key). Names are fine; values are not.
- Secrets live only in Vercel env vars. `.env` is git-ignored; backups contain no secrets.
- Never put passwords in chat.
- Routine catalog updates and draft copy can proceed without a gate.

## Mockups

When you add a product or expand a design, copy the mockups from the original catalog onto the new listing. Do not leave a new product on a logo or an empty `images` array if the original already has mockups. See `store/OPERATOR.md`.

## Standard catalog issue

**Standard catalog issue** is a fixed set of products. When someone says “standard catalog issue”, “standard issue”, or “add the standard catalog,” expand it into **all six** of these, using the same design on every one:

| Key | Product | What it is |
|-----|---------|------------|
| `tee` | T-shirt | Unisex Softstyle / staple tee (lightweight) |
| `long-sleeve` | Long-sleeved t-shirt | Unisex long sleeve tee |
| `hoodie-beach` | Beach hoodie | Lightweight 6–8 oz, after-sun style |
| `hoodie-kilauea` | Kīlauea hoodie | Standard hooded sweatshirt |
| `hoodie-mauna-kea` | Mauna Kea hoodie | Thick and expensive |
| `blanket` | Blanket | Velveteen plush or Sherpa fleece blanket |

Hoodie weights: **Beach** (light 6–8 oz) → **Kīlauea** (standard) → **Mauna Kea** (thick, premium).

That is the whole standard set. Do not drop any of them. Do not invent extra items unless the user named them.

### How to expand a request

If the user says:

> take this design, make me a trucker hat, a duffel bag and standard catalog issue

You create **8 products** from that one design:

1. trucker hat (named extra)
2. duffel bag (named extra)
3. tee
4. long-sleeve
5. Beach hoodie
6. Kīlauea hoodie
7. Mauna Kea hoodie
8. blanket

Named extras are in addition to the standard set. They are not a replacement for it.

### Rules

- Same design, same title stem, different product type on each listing.
- Copy mockups from the original catalog product onto every new listing.
- Resolve real Printify `blueprint_id` and `print_provider_id` at create time. Do not hardcode stale IDs.
- Prefer Printify Choice / a US provider when both exist.
- Enable the common size run (S–XL minimum on apparel; all offered sizes on the blanket).
- Write every product into the brand catalog (`store/brands/<brand>/catalog.json`, or `store/catalog.json` for Fruity Puppy) with `fulfiller: "printify"` and the Printify product/variant IDs.
- Commit. The store deploys from the catalog file.

Machine-readable copy: `store/standard-catalog.json`.

## Merch menu

`store/merch-menu.json` is a menu of 50 Printify clothing styles (jackets, hoodies, sweatsuits, jerseys, hats) for the merch factory to pick from. Each entry has the Printify `blueprint_id`, base price and 1.2x retail price. These are not listings. Resolve the print provider live when you create a product.
