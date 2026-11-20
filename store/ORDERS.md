# Orders, accounting and fulfillment

Payment state and fulfillment state are separate on every order.

- payment: `pending` → `paid` | `failed` | `expired`; `refunded` after a full refund (partial refunds keep `paid` and set `amount_refunded_cents`).
- fulfillment: `not_ready` → `queued` (warehouse/3PL only) or `handoff_pending` (has Printify lines) → `partially_shipped` → `shipped`; `cancelled` if payment fails.
- Lines are grouped by fulfiller in `order.groups` (`warehouse`, `printify`). Each group ships separately; `order.shipments[]` holds carrier, tracking number, tracking URL and the shipping-email outbox.

## Flow
1. `POST /api/checkout` and `GET /buy/<sku>` create the Stripe Checkout session (US shipping address and phone number collected).
2. Stripe calls `POST /api/stripe-webhook` (signature-verified, idempotent). Handled: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`. On failure the event claim is released and a 5xx is returned so Stripe retries.
3. New orders get a number from a Redis counter: `FP-1001`, `FP-1002`, … The ledger fields are subtotal, discount, shipping, tax, total, Stripe fee and net (from the balance transaction, best effort), and refunds.
4. When paid: a customer thank-you email and (for Fruity Puppy warehouse lines: FP-2OZ, TT-JUICE, FP-SAMPLE) a 3PL email are queued; Printify lines are submitted to Printify as an order (`send_to_production: false`, so someone approves it in Printify).
5. The 3PL email has a signed one-time link `/store/ship/<order id>?t=<HMAC>`; the form takes carrier + tracking number, marks the warehouse lines shipped and emails the customer the tracking link.
6. `POST /api/printify-webhook` (topic `order:shipment:created`) marks Printify lines shipped and emails the customer.
7. `/store/confirmation` shows the order number, items and total once the webhook has recorded the order.
8. `/store/admin`: order list with filters, mark shipped, resend emails, retry Printify, CSV export (Bearer `ADMIN_TOKEN`, kept in sessionStorage).

## Email switches (all OFF by default)
| Email | Needs |
|---|---|
| Customer thank-you + shipping | `ORDER_EMAILS_ENABLED=true`, `RESEND_API_KEY`, `ORDER_EMAIL_FROM` (sender on a domain verified in Resend). Reply-to defaults to fruitypuppyskincream@gmail.com (`ORDER_EMAIL_REPLY_TO` overrides). |
| 3PL order email | `THREEPL_EMAILS_ENABLED=true`, `THREEPL_EMAIL`, `SHIP_LINK_SECRET`, plus `RESEND_API_KEY` and `ORDER_EMAIL_FROM`. |

Queued emails wait on the order while sending is off; `POST /api/admin-orders` (or "Retry due emails" in admin) sends them once switched on. Resend `Idempotency-Key`s prevent double sends; admin "Resend" uses a fresh key.

## Required configuration
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (signing secret of the endpoint `https://fruity-puppy-store.vercel.app/api/stripe-webhook` on the account that charges; subscribe the 5 events above).
- Order store: Upstash Redis REST, `KV_REST_API_URL` + `KV_REST_API_TOKEN`. Keys are prefixed `fps:` (database shared with other projects).
- `ADMIN_TOKEN`.
- `SHIP_LINK_SECRET` (long random string) for the 3PL links.
- `PRINTIFY_TOKEN`, `PRINTIFY_SHOP_ID`, `PRINTIFY_WEBHOOK_SECRET` (the `secret` used when registering the Printify webhook `order:shipment:created` → `https://fruity-puppy-store.vercel.app/api/printify-webhook`).

Tests: `npm test` (local mocks only; nothing is sent).

## Email list
Signups (footer + Stripe Checkout opt-in), storage, CSV export and unsubscribe: see [SUBSCRIBERS.md](SUBSCRIBERS.md).
