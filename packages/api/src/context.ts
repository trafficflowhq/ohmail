import { bindDb } from "@trafficflow/db";
import type { BoundDb, Db, ServiceContext, UnboundDb } from "@trafficflow/services/mail";
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

/** The handle each request's context holds, re-minted when the handle or the session's account changes. */
const contextHandles = new WeakMap<ApiDeps, { readonly db: Db; readonly account: string | null; readonly bound: BoundDb | UnboundDb }>();

/**
 * The request's handle: bound to the session's account, or to nothing when the request has no
 * session. Chosen by the session alone, never by an id the request carries; a session whose account
 * is empty or malformed is refused by the binder. One per request (`withSessionAcquireCeiling`
 * swaps `deps.db` before the session is read, and a later call sees the swap).
 */
function contextDb(deps: ApiDeps): BoundDb | UnboundDb {
  const session = deps.session;
  const account = session ? session.accountId : null;
  const held = contextHandles.get(deps);
  if (held !== undefined && held.db === deps.db && held.account === account) return held.bound;
  const bound = session ? bindDb(deps.db, { account: session.accountId }) : bindDb(deps.db, { account: null });
  contextHandles.set(deps, { db: deps.db, account, bound });
  return bound;
}

/**
 * Build the {@link ServiceContext} an AuthService method runs against. Identity comes from
 * `deps.session` (the session row, never the body): protected routes carry
 * accountId/userId/sessionId and a handle bound to that account; public pre-session routes have
 * accountId="" / userId=null and a handle bound to nothing. `ip`/`userAgent` are threaded for
 * audit + lockout. `origin` is the raw `Origin` header, threaded for multi-origin WebAuthn:
 * ceremonies are admitted only from an allow-listed origin and then bound to it; native clients
 * send none, which means the deployment's default origin.
 */
export function serviceContext(deps: ApiDeps, req: Request): ServiceContext {
  const s = deps.session;
  return {
    db: contextDb(deps),
    accountId: s?.accountId ?? "",
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
    ...(deps.press ? { pressFloor: deps.press.floor, pressAged: deps.press.aged } : {}),
    // Absent unless the desktop engine's door admitted this search under a lane (`search-lanes.ts`).
    ...(deps.searchSupersede ? { searchSupersede: deps.searchSupersede } : {}),
    // Absent unless the desktop engine's door passes its loop turn.
    ...(deps.loopTurn ? { loopTurn: deps.loopTurn } : {}),
    // The one wiring point for the response's account header on the credential routes. Every
    // service that mints or rotates a session reports through this, so a sign-in route added
    // later is covered without remembering to do anything — see `ACCOUNT_HEADER` in `app.ts`.
    noteCredentialAccount: (accountId: string) => { deps.credentialAccount = accountId; },
  };
}
