import { assertBinding, bindDb, bindingOf, BindingRefusedError } from "@trafficflow/db";
import type { BoundDb, ServiceContext, UnboundDb } from "@trafficflow/services/mail";
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
 * Refuse a request's handle that is not as its host minted it: bound to an account, or carrying a
 * key. The host hands every request a handle bound to nothing; one that names more was bound for
 * another request, and a second request on its container must fail, never run as the first.
 */
function refuseSpentHandle(deps: ApiDeps, what: string): void {
  const held = bindingOf(deps.db);
  if (held !== undefined && (held.account !== null || held.keyed)) {
    throw new BindingRefusedError(`${what} was asked on a request whose handle is bound already`);
  }
}

/**
 * BIND THE REQUEST TO ITS SESSION'S ACCOUNT: the one place a request's handle comes to name an
 * account. Called by `withSession` alone, as its last step: after the token was resolved, after an
 * enrollment session was dropped on a route that does not admit it, after the 401. From then on
 * `deps.db` is the request's handle, and every statement a route or a service makes through it
 * rides a transaction that names the account first.
 *
 * The account is `deps.session.accountId`, the session row's own, and nothing else is read: no
 * body, query, path, header or cookie, and no other field of `deps`. A session whose account is
 * empty or no id is refused by the binder, never bound to nothing. A request with no session keeps
 * the handle bound to nothing. The session doors' second handle (`deps.sessionDb`) is closed here:
 * nothing swaps the request's handle after it was bound.
 *
 * A handle that already names an account, or carries a key, is refused: a container handed to a
 * second request fails here. A handle with no binding at all is one no host minted (a test's
 * container, the desktop's until its host mints too): it is left as it is, and
 * {@link serviceContext} binds each context from the session.
 */
export function bindRequest(deps: ApiDeps): void {
  refuseSpentHandle(deps, "the session's binding");
  delete deps.sessionDb;
  if (deps.session && bindingOf(deps.db) !== undefined) {
    deps.db = bindDb(deps.db, { account: deps.session.accountId });
  }
}

/**
 * THE HANDLE OF A DOOR THAT RUNS FOR NO ACCOUNT: a clock's route, which walks rows of many accounts
 * and binds each row's own (`passContext`). Bound to nothing, with no key: the request's handle as
 * the host minted it. A request that was bound to an account has no such door, and is refused.
 */
export function doorDb(deps: ApiDeps): UnboundDb {
  refuseSpentHandle(deps, "a door without an account");
  return bindDb(deps.db, { account: null });
}

/**
 * A context's handle. On a host that mints the request's handle it is `deps.db` itself, which
 * {@link bindRequest} bound: the session and the handle must agree, and a handle that names
 * another account, or nothing while a session stands, is refused. A handle with no binding (no
 * host minted it) is bound here from the session's row, each time it is asked.
 */
function contextDb(deps: ApiDeps): BoundDb | UnboundDb {
  const account = deps.session ? deps.session.accountId : null;
  const db = deps.db;
  if (bindingOf(db) === undefined) return account === null ? bindDb(db, { account: null }) : bindDb(db, { account });
  assertBinding(db, account);
  return db;
}

/**
 * Build the {@link ServiceContext} an AuthService method runs against. Identity comes from
 * `deps.session` (the session row, never the body): protected routes carry
 * accountId/userId/sessionId and the request's handle, bound to that account; public pre-session
 * routes have accountId="" / userId=null and a handle bound to nothing. `ip`/`userAgent` are threaded for
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
