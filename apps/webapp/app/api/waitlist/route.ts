import { NextResponse } from "next/server";
import { apiOrigin } from "./origin";

/**
 * The marketing waitlist submit, proxied server-side. The original reason (the marketing page could not be an auth
 * origin) is gone since the single-origin collapse, and it is worth saying so; it stays for a better one: the cookie
 * jar. `/api/*` is a REWRITE, and a rewrite forwards the browser's cookies verbatim — a browser POST to
 * `/api/waitlist` would hand `tf_session` and `tf_csrf` to a public unauthenticated endpoint from the one page a
 * stranger, a bot and a signed-in user all load.
 */

/**
 * This handler is the boundary: it forwards an email address and a tier, nothing else — no cookies, no IP, no
 * user agent. It shadows the `/api/:path*` rewrite by construction (`afterFiles`); `OWN_PATHS` enumerates it as the
 * deliberate shadow and a proxy guard asserts the ordering over a real socket.
 */

/**
 * The caller's IP is NOT forwarded: on Vercel `clientIp` prefers `x-vercel-forwarded-for`, which
 * the edge overwrites — anything set here would be ignored, and a header the API did trust would be
 * one an attacker could set by calling `api.ohmail.app` directly. The waitlist is rate-limited per
 * RECIPIENT (`MailService`'s limiter), the key that matches the harm — a mail landing in a
 * stranger's inbox. Unarmed by default: with no `TF_API_ORIGIN` this answers 503 and the client
 * shows "we could not record that" — a waitlist that silently discards signups is worse than a
 * form that says it is unavailable. `runtime = "nodejs"` because this is a real outbound request.
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
