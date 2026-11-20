# Email list ("Get on the list.")

Where signups come from
- Footer form on every fruitypuppy.com page and every Fruity Puppy store page. Posts to
  `https://www.fruitypuppy.com/store/api/subscribe` (email only, honeypot field `website`, rate-limited
  5 per IP per 10 min and 500 per hour overall, deduped by lowercase email).
- Stripe Checkout (Fruity Puppy only, never Brobots/Kudoken). Two modes:
  - Now (default): a checkout field "Fruity Puppy emails? Unsubscribe anytime." with options
    "No thanks" (preselected) / "Yes, send me skin news" (Stripe custom_fields key `fp_emails`).
    Only "yes" joins the list (consent_version `checkout-dropdown-2026-11-20`).
  - Stripe's own promotions checkbox (`consent_collection[promotions]=auto`, unchecked by default).
    Stripe rejected it on 2026-11-20 with: "To set `consent_collection.promotions`, please visit
    https://dashboard.stripe.com/settings/checkout to agree to the Terms of Service." After accepting those
    terms in the Stripe dashboard, set `CHECKOUT_PROMO_CONSENT=stripe` on Vercel (fruity-puppy-store) and
    redeploy to switch. `consent.promotions = "opt_in"` then joins the list.
  - Opted-in buyers get source `checkout:<SKU>` (e.g. `checkout:FP-SAMPLE`; FP-SAMPLE buyers only if they
    opted in). Every order stores `consent` = { promotions, dropdown, method, opted_in }.

Storage
- Upstash Redis (same database as orders): `fps:subs:<email>` holds one JSON record; `fps:subs:_index`
  is a sorted set by signup time. Rate-limit counters live under `fps:rl:`.
- Record fields: email, status (`subscribed` / `unsubscribed`), source, sources, consent_text,
  consent_version, consent_at, created_at, updated_at, unsubscribed_at, ip_hash (salted sha256,
  never the raw IP).

Export the list
- Easiest: open https://www.fruitypuppy.com/store/admin, sign in with ADMIN_TOKEN, click
  "Export list CSV". The subscriber count shows next to it.
- Or from a terminal:
  ```
  curl -H "Authorization: Bearer $ADMIN_TOKEN" \
    "https://www.fruitypuppy.com/store/api/admin-orders?view=subscribers&format=csv" -o subscribers.csv
  ```
  `?view=subscribers` (no format) returns JSON: `{ count, subscribed, recent }` (latest 100).
- Only mail people whose `status` is `subscribed`. The CSV includes unsubscribed rows on purpose so
  they're never re-added by an import.

Unsubscribe
- Signed link: `https://www.fruitypuppy.com/store/unsubscribe?e=<email>&t=<token>` where the token is
  an HMAC of the email with `UNSUBSCRIBE_SECRET` (`unsubLink(email)` in `lib/subscribers.js`). GET shows
  a confirm page; POST sets status to `unsubscribed` (`forget=1` deletes the record). Put this link in
  every marketing email when you start sending.
- Signing up again later re-subscribes the address.

Notifications (OFF)
- `SIGNUP_NOTIFY_ENABLED=true` would email `SIGNUP_NOTIFY_TO` (aloha@fruitypuppy.com) once per new
  signup through Resend (needs RESEND_API_KEY + ORDER_EMAIL_FROM on a verified domain). Left off.
- Nothing in this code sends welcome or marketing email. Use the CSV with your email tool.

Env vars: CHECKOUT_PROMO_CONSENT (unset = dropdown; `stripe` = Stripe checkbox), FP_PROXY_KEY (shared with the
main site so the store sees the visitor IP behind the www proxy), UNSUBSCRIBE_SECRET (required for unsubscribe links and the IP-hash salt), SIGNUP_NOTIFY_TO,
SIGNUP_NOTIFY_ENABLED (unset = off). Shares UPSTASH_REDIS_REST_URL/TOKEN and ADMIN_TOKEN with orders.
