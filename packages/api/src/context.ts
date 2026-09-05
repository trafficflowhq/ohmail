import type { ServiceContext } from "@trafficflow/services/mail";
import type { ApiDeps } from "./deps.js";

/**
 * The header the PLATFORM writes, and only that one.
 *
 * `x-vercel-forwarded-for` is genuinely unforgeable from outside: the Vercel edge overwrites
 * every `x-vercel-*` header on every request, so whatever a caller sent is discarded.
 *
 * `x-real-ip` used to be in this list under the same comment, and it does not belong there.
 * It is an ordinary header name with no platform reservation — a proxy that sets it makes it
 * trustworthy, and any deployment WITHOUT such a proxy hands every caller a
 * `curl -H 'x-real-ip: …'` switch for minting a fresh rate-limit bucket per request. On
 * Vercel the first entry always wins so the bug was unreachable, which is precisely the
 * shape of thing that survives review and then ships the day the host changes.
 *
 * A deployment behind a different proxy adds its own header here, in code, with the same
 * argument written down. It is one line and it should cost a thought.
 */
const TRUSTED_IP_HEADERS = ["x-vercel-forwarded-for"] as const;

const hopsOf = (raw: string | null): string[] =>
  (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);

/**
 * The client IP, from a header the CLIENT CANNOT CHOOSE.
 *
 * This used to read the FIRST hop of `X-Forwarded-For`, and that is a header a caller
 * writes: `curl -H 'X-Forwarded-For: 1.2.3.4'` and every proxy in the world appends to the
 * right of it, so the leftmost entry is whatever the caller invented. Any per-IP limit built
 * on that value — the registration throttle, or the audit trail an abuse
 * report is read from — is bypassable by rotating one header, one request at a time. That is
 * the entire cost of a leaked reusable invite code becoming unbounded registrations.
 *
 * The order below is "most trustworthy first":
 *  1. `x-vercel-forwarded-for` — set by the platform edge, which OVERWRITES any client-sent
 *     `x-vercel-*` header, so its value cannot be chosen by the caller (see
 *     {@link TRUSTED_IP_HEADERS} for why nothing else is on that list);
 *  2. the LAST hop of `x-forwarded-for` — the only entry in that list a client cannot
 *     prepend to, because it is appended by the nearest trusted proxy. Choosing the last hop
 *     can, behind an unusual proxy chain, key the limit to a PROXY rather than the client:
 *     that direction is safe (over-restrictive, and visible in the audit log) whereas
 *     trusting the first hop is a wide-open bypass.
 *
 * ── AND `""` MEANS "UNKNOWN", WHICH IS NOT AN IDENTITY ──────────────────────────────────
 *
 * When no header matches this returns the empty string, and callers must NOT key a limiter
 * on that value. They used to: `register:${ctx.ip ?? ""}` put every registration in the
 * deployment into one bucket the moment the platform headers were absent, so twenty requests
 * from anywhere locked out all new signups everywhere — a trivial denial of service on any
 * non-Vercel host, caused by the mechanism meant to prevent abuse.
 *
 * The rule is therefore: **an unknown client is not rate-limited per-IP, it is limited by
 * what does not need an identity.** For registration that is the consumable, email-bound
 * invite row (one leaked code buys exactly one account) plus the production ban on
 * `TF_INVITE_CODES`; for the waitlist it is the per-recipient mail limiter. Skipping a limit
 * we cannot key correctly is a bounded loss; sharing one bucket is an outage.
 *
 * Exported so the spoofing cases can be asserted directly (`clientIp` tests) rather than
 * inferred through a service.
 */
export function clientIp(req: Request): string {
  for (const name of TRUSTED_IP_HEADERS) {
    const hop = hopsOf(req.headers.get(name))[0];
    if (hop) return hop;
  }
  const hops = hopsOf(req.headers.get("x-forwarded-for"));
  return hops.length > 0 ? hops[hops.length - 1]! : "";
}

/**
 * Build the {@link ServiceContext} an AuthService method runs against. Identity
 * comes from `deps.session` (the session row, NEVER the body — contract §1.9):
 * protected routes carry accountId/userId/sessionId; public pre-session routes
 * have accountId="" / userId=null, the same shape the auth service's own tests
 * exercise. `ip`/`userAgent` are threaded for audit + lockout. `opts.accountId`
 * lets a caller pin an account when there is no session yet.
 *
 * `origin` is the raw `Origin` header, threaded for multi-origin WebAuthn:
 * ceremonies are admitted only from an allow-listed origin and then bound to it.
 * Native clients send none — `undefined` then means "the deployment's default
 * origin", which is exactly how a single-origin deployment behaves.
 */
export function serviceContext(
  deps: ApiDeps,
  req: Request,
  opts: { accountId?: string } = {},
): ServiceContext {
  const s = deps.session;
  return {
    db: deps.db,
    accountId: opts.accountId ?? s?.accountId ?? "",
    userId: s?.userId ?? null,
    sessionId: s?.sessionId ?? null,
    now: deps.now,
    requestId: deps.requestId,
    ip: clientIp(req),
    userAgent: req.headers.get("user-agent") ?? undefined,
    origin: req.headers.get("origin") ?? undefined,
    // The one wiring point for the response's account header on the credential routes. Every
    // service that mints or rotates a session reports through this, so a sign-in route added
    // later is covered without remembering to do anything — see `ACCOUNT_HEADER` in `app.ts`.
    noteCredentialAccount: (accountId: string) => { deps.credentialAccount = accountId; },
  };
}
