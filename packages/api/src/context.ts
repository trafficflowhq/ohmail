import type { ServiceContext } from "@trafficflow/services/mail";
import type { ApiDeps } from "./deps.js";

/**
 * The header the platform writes, and only that one. `x-vercel-forwarded-for` is genuinely
 * unforgeable from outside: the edge overwrites every `x-vercel-*` header on every request.
 * `x-real-ip` used to be here and does not belong: it is an ordinary header with no platform
 * reservation, so any deployment without a proxy that sets it hands every caller a
 * `curl -H 'x-real-ip: …'` switch for minting a fresh rate-limit bucket per request. A
 * deployment behind a different proxy adds its own header here, in code, with the same
 * argument written down.
 */
const TRUSTED_IP_HEADERS = ["x-vercel-forwarded-for"] as const;

const hopsOf = (raw: string | null): string[] =>
  (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);

/**
 * The client IP, from a header the client cannot choose: (1) `x-vercel-forwarded-for`
 * (TRUSTED_IP_HEADERS), else (2) the LAST hop of `x-forwarded-for`, the only entry a client cannot
 * prepend to. A chain that leaves a proxy as that hop keys every visitor to ONE address — one
 * lockout, one signup limit, one audit address for the deployment, which is an outage, never a safe
 * direction; the self-host adapter's walk (`forwardFor`, `http-host.ts`) strips that hop and logs
 * when it could not. `""` means unknown, never an identity: an unknown client is limited by what needs
 * none (the email-bound invite row, the per-recipient mail limiter). Exported for the spoofing tests.
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
 * Build the {@link ServiceContext} an AuthService method runs against. Identity comes from
 * `deps.session` (the session row, never the body): protected routes carry
 * accountId/userId/sessionId; public pre-session routes have accountId="" / userId=null.
 * `ip`/`userAgent` are threaded for audit + lockout. `opts.accountId` lets a caller pin an
 * account when there is no session yet. `origin` is the raw `Origin` header, threaded for
 * multi-origin WebAuthn: ceremonies are admitted only from an allow-listed origin and then
 * bound to it; native clients send none, which means the deployment's default origin.
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
    // Spread rather than assigned: a host that states no generation must leave the field ABSENT,
    // which is a different answer from a first generation (`ServiceContext.storeGeneration`).
    ...(deps.storeGeneration == null ? {} : { storeGeneration: deps.storeGeneration }),
    // Absent unless `withPressAge` read an age: the services' floors then admit, as before.
    ...(deps.press ? { pressFloor: deps.press.floor } : {}),
    // The one wiring point for the response's account header on the credential routes. Every
    // service that mints or rotates a session reports through this, so a sign-in route added
    // later is covered without remembering to do anything — see `ACCOUNT_HEADER` in `app.ts`.
    noteCredentialAccount: (accountId: string) => { deps.credentialAccount = accountId; },
  };
}
