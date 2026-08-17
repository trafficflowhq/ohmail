import { NextResponse } from "next/server";
import { apiOrigin } from "./origin";

/**
 * The marketing waitlist submit, proxied SERVER-SIDE.
 *
 * ## Why a route handler and not a browser fetch to the API — RE-DERIVED for one origin
 *
 * **The original reason is gone, and it is worth saying so rather than leaving a comment
 * that argues from a fact that stopped being true.** This existed because `ohmail.app`
 * could never be an auth origin: `origins.ts` refused it, `withRequestGuard` refuses any
 * `Origin` that is not one of the deployment's own, and a browser POST from the marketing
 * page straight to `api.ohmail.app` therefore answered 403 `cross_site_denied`. Since the
 * collapse onto one origin, `https://ohmail.app` IS the deployment's auth origin. That
 * POST would now succeed, and this handler is no longer load-bearing for that reason.
 *
 * **It stays for a different reason, and a better one: the cookie jar.** `/api/*` is a
 * REWRITE, and a rewrite forwards the browser's cookies verbatim. A browser POST to
 * `/api/waitlist` would therefore hand `tf_session` and `tf_csrf` to the API on a PUBLIC,
 * unauthenticated endpoint that has no use for either — from the one page in the product
 * that a stranger, a bot and a signed-in user all load. This handler is the boundary: it
 * forwards an email address and a tier, and nothing else. No cookies, no IP, no
 * user agent, no `Origin`, no `Sec-Fetch-Site`.
 *
 * That it is ALSO a same-origin request answered locally rather than proxied is not
 * incidental: a `rewrites()` array is `afterFiles`, so this filesystem route shadows
 * `/api/:path*` by construction. `apps/webapp/next.config.mjs` (`OWN_PATHS`) enumerates
 * that as the single deliberate shadow and a proxy guard asserts the ordering
 * over a real socket rather than trusting it.
 *
 * ## What is NOT forwarded, and why
 *
 * The caller's IP. On Vercel, `clientIp` prefers `x-vercel-forwarded-for`, which the edge
 * OVERWRITES on every request — so anything this handler set would be ignored on the API
 * side anyway, and a header the API *did* trust from here would be one an attacker could
 * also set by calling `api.ohmail.app` directly. The waitlist is rate-limited per
 * RECIPIENT (the limiter inside `MailService`), which is the key that matches the harm:
 * a mail landing in a stranger's inbox. See `packages/api/src/routes/waitlist.ts`.
 *
 * Nothing else is forwarded either — not the user agent, not cookies. This endpoint needs
 * an email address and a tier.
 *
 * ## Unarmed by default
 *
 * With no `TF_API_ORIGIN` this answers **503** and the client shows the honest "we could not
 * record that" state. It does NOT pretend to have worked: a waitlist that silently discards
 * signups is worse than a form that says it is temporarily unavailable, because nobody ever
 * finds out. `runtime = "nodejs"` because this is a real outbound request, not an edge
 * rewrite.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * The compiled allow-list and `apiOrigin` live in `./origin.ts`, NOT here. A `route.ts` may
 * only export the HTTP verbs and Next's segment-config fields; exporting a helper from it
 * fails `next build` ("apiOrigin" is not a valid Route export field) while passing
 * `tsc --noEmit`. See the header of that file.
 */

/** Bound the body before it is parsed: this is an unauthenticated public endpoint. */
const MAX_BODY_BYTES = 2_000;

export async function POST(req: Request): Promise<Response> {
  const origin = apiOrigin(process.env.TF_API_ORIGIN);
  if (!origin) {
    return NextResponse.json(
      { error: { code: "waitlist_unavailable", message: "The waitlist is not reachable right now." } },
      { status: 503 },
    );
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: { code: "validation_failed", message: "That request was too large." } },
      { status: 413 },
    );
  }

  let body: { email?: unknown; tier?: unknown };
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json(
      { error: { code: "validation_failed", message: "That request could not be read." } },
      { status: 400 },
    );
  }

  // Re-serialised from the two fields we accept, so nothing else the caller sent — a
  // `source` claiming to be somewhere it is not, a field a future API version might grow —
  // is relayed onward. `source` is set HERE because this handler IS the landing.
  const payload = JSON.stringify({
    email: typeof body.email === "string" ? body.email : "",
    tier: typeof body.tier === "string" ? body.tier : "undecided",
    source: "landing",
  });

  try {
    const upstream = await fetch(`${origin}/waitlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      // A marketing form must not hold a serverless invocation open behind a slow API.
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    const text = await upstream.text();
    return new Response(text || "{}", {
      status: upstream.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch {
    // The upstream error is deliberately not echoed: it can carry a hostname, and this
    // response goes to an anonymous browser.
    return NextResponse.json(
      { error: { code: "waitlist_unavailable", message: "The waitlist is not reachable right now." } },
      { status: 502 },
    );
  }
}
