# Mount kit: put the store at `/store` on any site

The store runs as one Vercel project (`fruity-puppy-store`, https://fruity-puppy-store.vercel.app).
Each brand's site proxies its own `/store/*` to it. Nothing is copied or rebuilt per site.
These files are copied from the live sites with secrets left out.

| File | For | What it does |
|------|-----|--------------|
| `nextjs/store-rewrites.ts` | Next.js sites | `beforeFiles` rewrites for `/store`, product, buy, cart, confirmation, api, admin, ship, signup |
| `nextjs/middleware.ts` | Next.js sites | Passes visitor IP + `FP_PROXY_KEY` to `/store/api/subscribe` (rate limiting) |
| `nextjs/shop-links.ts` | Any site | The `/store/product/<id>` and `/store/buy/<SKU>` link pattern |
| `nextjs/FooterSignup.tsx` | Next.js sites | "Get on the list." form posting to `/store/api/subscribe` |
| `vercel/vercel.json` | Static / non-Next sites on Vercel | Same rewrites as plain `vercel.json` (as used on kudoken.space). Replace `BRAND`. |

Static store pages already load `public/signup.js` for the footer signup on the default brand.

## Steps

1. Create `store/brands/<brand>/config.json` and `catalog.json` in this repo (see the top-level README). Add your site's origin(s) to `allowed_origins`.
2. Add the rewrites (Next.js: `store-rewrites.ts` with `BRAND` set; otherwise `vercel/vercel.json` with `BRAND` replaced).
   The default brand (Fruity Puppy) uses no `?brand=`.
3. Optional: add `middleware.ts` and set the same `FP_PROXY_KEY` on both Vercel projects.
4. Make sure your CSP allows `https://checkout.stripe.com` in `form-action` and `connect-src`.
5. Deploy, then check with a browser User-Agent: `/store` is 200, `/store/buy/<SKU>` is a 303 to `checkout.stripe.com`.

Live examples: `ozone503-maker/fruity-puppy` (Next.js, default brand), `ozone503-maker/brobots-space-academy`
(`vercel.json`, `brand=brobots`), `ozone503-maker/kudoken` (`vercel.json`, `brand=kudoken`).
