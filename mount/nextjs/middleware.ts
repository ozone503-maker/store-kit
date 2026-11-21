// Store Kit mount: pass the visitor's IP to the store's email signup, so its per-IP rate limit works
// behind the proxy (the store keeps only a salted hash). Copied from ozone503-maker/fruity-puppy middleware.ts.
//
// FP_PROXY_KEY must be the SAME random value on this site's Vercel project and on the Store Kit project.
// Generate one with `openssl rand -hex 32` and add it with `vercel env add FP_PROXY_KEY`. Never commit it.
// Without it the signup still works; it just rate-limits on the proxy IP.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const key = process.env.FP_PROXY_KEY;
  if (key && request.method === "POST" && request.nextUrl.pathname === "/store/api/subscribe") {
    const headers = new Headers(request.headers);
    const ip = (request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "").split(",")[0].trim();
    headers.set("x-fp-client-ip", ip);
    headers.set("x-fp-proxy-key", key);
    return NextResponse.next({ request: { headers } });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/store/api/subscribe"],
};
