# Store Operator Guide (for bots)

## Env vars needed on Vercel

Full table with what each one does: `README.md` → Environment variables. Names only; never print values.

Required: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `KV_REST_API_URL` + `KV_REST_API_TOKEN`
(Upstash; `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` also work), `ADMIN_TOKEN`, `UNSUBSCRIBE_SECRET`.

Printify: `PRINTIFY_TOKEN` (Personal Access Token, Printify > My Account > API), `PRINTIFY_SHOP_ID`
(`GET /shops.json`), `PRINTIFY_WEBHOOK_SECRET` (shipment webhook). A brand can use other names via
`fulfillers.printify.token_env` / `shop_id_env` in its config.

Emails (all off until switched on, and switching on needs Jessie's yes): `RESEND_API_KEY`,
`ORDER_EMAIL_FROM`, `ORDER_EMAIL_REPLY_TO` (optional), `ORDER_EMAILS_ENABLED`, `THREEPL_EMAIL`,
`THREEPL_EMAILS_ENABLED`, `SHIP_LINK_SECRET`, `SIGNUP_NOTIFY_TO`, `SIGNUP_NOTIFY_ENABLED`.

Optional: `CHECKOUT_PROMO_CONSENT` (`dropdown` | `stripe` | unset), `FP_PROXY_KEY` (shared with the
mounting site), `STORE_PUBLIC_BASE`, `STORE_DIR` (dev/test).

Set on the live project today (Nov 2026): STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, KV_*, REDIS_URL, ADMIN_TOKEN,
UNSUBSCRIBE_SECRET, PRINTIFY_TOKEN, PRINTIFY_SHOP_ID, FP_PROXY_KEY, SIGNUP_NOTIFY_TO, CHECKOUT_PROMO_CONSENT.
`STRIPE_FRUITY_PUPPY` is also set but no code reads it.

## Duplicatable program

One deployment. Many brands. Do not rebuild the shop for a new brand.

Every store already has:

- Cart (drawer + `/cart`), one cart per brand
- Suggested products from `pairs`, else other products in that catalog
- Order confirmation at `/confirmation`
- Stripe checkout

To add a brand: create `store/brands/<brand>/catalog.json` and `config.json`, then mount `/store` with `?brand=<brand>` or hostname detection. Cart, suggestions, and confirmation come with it.

## Mockups: the characters wear the gear

Do not use Printify mockups on the listing. Do not leave the listing on a logo.

Read `store/characters/README.md` first. Use those models. Do not invent a new face.

Models on file:

- Ipo — pink dog, blue eyes. Default for Fruity Puppy and Kudoken.
- Shockbot — gold robot, leopard hat, headphones, mustache.
- Tank — weathered grey robot, fedora, yellow eyes.
- Mystery Drone Pilot — blue alien, large head, brown eyes.
- Fonk — red scaled creature, pointed ears.
- Erv — large brown toad.
- Dinny — tan frog, big eyes.

Rules:

1. **Ipo always has at least a pair of shorts on.** No exceptions on any merch mockup.
2. Match the reference image in `store/characters/`. Same face, same colors, same body. Only the clothing changes.
3. One photo per product, minimum. Front view, the item clearly visible.
4. Ipo is the default for Fruity Puppy and Kudoken. The others are available for any brand.
5. Put the image URL in the catalog `images` array. Commit. A listing without a character photo is not done.
6. Printify is for fulfillment only. It is not the photo source.

## Standard catalog issue

Read `README.md` and `store/standard-catalog.json`.

**Standard catalog issue** always expands to all six: tee, long-sleeve, Beach hoodie, Kīlauea hoodie, Mauna Kea hoodie, blanket.

Hoodie weights:
- Beach — lightweight 6–8 oz, after-sun style
- Kīlauea — standard hooded sweatshirt
- Mauna Kea — thick and expensive

If the user names extra products (trucker hat, duffel bag, etc.) plus standard catalog issue, create the extras **and** all six standard items. Extras do not replace the standard set.

Example: "take this design, make me a trucker hat, a duffel bag and standard catalog issue" → 8 products.

## Adding a Printify product
1. Upload design via PrintifyClient.uploadImage (URL or base64).
2. Create product with blueprint_id, print_provider_id, variants (id, price in cents, is_enabled), print_areas with placeholders.images[{id, x, y, scale, angle}].
3. Fulfillment stays on Printify. The listing photo is a character wearing the gear, not the Printify mockup.
4. Add to the brand catalog with fulfiller: "printify", and on variants add printify_product_id and printify_variant_id.
   - Brobots: store/brands/brobots/catalog.json
   - Fruity Puppy: store/catalog.json
   - Kudoken: store/brands/kudoken/catalog.json
5. Commit the catalog change.

Resolve blueprint and provider IDs live from the Printify catalog. Do not hardcode stale IDs.

## Order flow
The Stripe webhook calls fulfillOrder for the Printify lines of a paid order (see store/ORDERS.md). send_to_production stays false.
Webhook at /api/printify-webhook receives tracking and calls recordTracking.

## Merch factory
See tools/merch-factory.js (flags are documented at the top of the file; `npm run factory -- <flags>`).
It resolves blueprint, provider and variant IDs live from the Printify catalog (`lib/printify-resolve.js`); run with `--dry-run` first.
It writes `printify_product_id` / `printify_variant_id` on every variant. Printify creates the product. The catalog image is the character photo.
Run `npm run check` before committing: it fails on Printify variants without Printify IDs.

Default fulfiller is warehouse. Set product.fulfiller to "printify" for POD items.

## Foundational operating principles (for bots)

These rules sit above product creation and page writing. Follow them before expanding catalogs or writing copy.

### Demand validation first
Do not add products because someone likes the idea. Prefer items with evidence of existing demand:
- Public sales signals (Amazon Best Sellers Rank under ~50k in category, "bought in past month," Movers & Shakers)
- Search trends that are stable or rising
- Social proof (people already asking about or filming the item)
- Clear margin after product cost, shipping, and reasonable ad spend

Ask for the numbers. Never invent sales volume, ranks, or margins. If you cannot verify a figure, say so and stop.

### Review-to-page method
Customer objections are free research. Before writing or rewriting a product page:
1. Collect real language from 3-star (and lower) reviews on comparable products, existing support emails, or market comments.
2. List the specific complaints that almost stopped the sale (size mismatch, shipping time, durability, texture, fridge requirement, fruit content claims, etc.).
3. Write the page so the headline and body answer those exact objections instead of using supplier or generic descriptions.
4. For Fruity Puppy cream, typical objections include: real fruit vs. extracts, refrigeration, jar life after opening, texture under makeup, price justification.
5. For merch, typical objections include fit, fabric weight, print durability, and whether the character photo matches what arrives.

The page is done when the biggest complaints have been directly answered in the customer's own language.

### Approval gates
Stop and ask for Jessie's explicit yes before:
- Spending money (ads, inventory, paid tools)
- Publishing a new product or major page change
- Emailing customers
- Deleting anything irreversible

Routine catalog updates and draft copy can proceed; irreversible or customer-facing actions require the gate.

### Fulfillment order
Test with POD / dropship / existing fulfillment first. Bring volume winners in-house only after demand is proven. Printify is fulfillment only; listing photos remain character mockups.

### Daily hygiene
When running ops, surface: new orders, low stock, payment or webhook failures, and anything that broke. Do not invent status.

### Prompting pattern
When starting work, state the goal, the limits, what needs approval, and what done looks like. Work in stages: research → store/page → fulfillment → legal/ops → marketing. Never skip the research stage.
