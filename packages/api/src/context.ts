import { assertBinding, bindDb, bindingOf, BindingRefusedError } from "@trafficflow/db";
import type { SessionLifecycle } from "@trafficflow/services/auth";
import { hashToken, type BoundDb, type ServiceContext, type UnboundDb } from "@trafficflow/services/mail";
import type { ApiDeps } from "./deps.js";

const hopsOf = (raw: string | null): string[] =>
  (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);

/**
 * Vercel owns its forwarding header on its own runtime. The Node adapter strips that
 * namespace and writes the authenticated web address or the trusted proxy walk's result
 * into the last hop of x-forwarded-for. An empty value means the client is unknown.
 */
export function clientIp(req: Request): string {
  if (process.env.VERCEL === "1") {
    const hop = hopsOf(req.headers.get("x-vercel-forwarded-for"))[0];
    if (hop) return hop;
  }
  const hops = hopsOf(req.headers.get("x-forwarded-for"));
  return hops.length > 0 ? hops[hops.length - 1]! : "";
}

/**
 * REFUSE A REQUEST'S HANDLE THAT IS NOT AS ITS HOST MINTED IT. The host hands every request a handle
 * bound to nothing, with no key (`depsFor`); that, and nothing else, is what a request starts on:
 *
 * - a handle with no binding at all is one no host minted. A host that stopped minting would run
 *   every route on the pool's own handle, with no account named on the wire;
 * - a handle that names an account, or carries a key, was bound for another request: a second
 *   request on its container must fail, never run as the first.
 */
function refuseUnmintedHandle(deps: ApiDeps, what: string): void {
  const held = bindingOf(deps.db);
  if (held === undefined) {
    throw new BindingRefusedError(`${what} was asked on a request whose handle no host minted`);
  }
  if (held.account !== null || held.keyed) {
    throw new BindingRefusedError(`${what} was asked on a request whose handle is bound already`);
  }
}

const credentialDbs = new WeakMap<ApiDeps, UnboundDb>();

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
 * the request keeps its account handle. Only the credential ceremonies retain a handle for
 * an exact lookup started before its owner is known.
 *
 * The handle must be as the host minted it ({@link refuseUnmintedHandle}): one that names an
 * account or carries a key is refused, so a container handed to a second request fails here, and
 * so is one no host minted.
 */
export function bindRequest(deps: ApiDeps, credentialLookup = false): void {
  refuseUnmintedHandle(deps, "the session's binding");
  delete deps.sessionDb;
  credentialDbs.delete(deps);
  if (deps.session) {
    if (credentialLookup) credentialDbs.set(deps, bindDb(deps.db, { account: null }));
    deps.db = bindDb(deps.db, { account: deps.session.accountId });
  }
}

/**
 * THE HANDLE OF A DOOR THAT RUNS FOR NO ACCOUNT: a clock's route, which walks rows of many accounts
 * and binds each row's own (`passContext`). Bound to nothing, with no key: the request's handle as
 * the host minted it ({@link refuseUnmintedHandle}). A request that was bound to an account has no
 * such door, and neither has one whose handle no host minted.
 */
export function doorDb(deps: ApiDeps): UnboundDb {
  refuseUnmintedHandle(deps, "a door without an account");
  return bindDb(deps.db, { account: null });
}

/**
 * A context's handle: `deps.db` itself, which the host minted and {@link bindRequest} bound. The
 * session and the handle must agree: a handle that names another account, nothing while a session
 * stands, an account while none does, or no binding at all (no host minted it) is refused.
 */
function contextDb(deps: ApiDeps): BoundDb | UnboundDb {
  const db = deps.db;
  assertBinding(db, deps.session ? deps.session.accountId : null);
  return db;
}

/** Bind the digests of the browser's presented credentials within the request's own account scope. */
export function browserLogoutProofs(
  deps: ApiDeps, refresh?: string, access?: string,
): Parameters<SessionLifecycle["assertBrowserLogout"]>[1] {
  const db = contextDb(deps);
  const account = deps.session?.accountId ?? null;
  const proofOf = (presented: string | undefined) => {
    if (!presented) return null;
    const digest = hashToken(presented);
    const proofDb = account === null ? bindDb(db, { account: null, key: digest }) : bindDb(db, { account, key: digest });
    return { digest, db: proofDb };
  };
  return { access: proofOf(access), refresh: proofOf(refresh) };
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
    ...(credentialDbs.has(deps) ? { credentialDb: credentialDbs.get(deps) } : {}),
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
    noteCredentialAccount: (accountId, familyId) => {
      deps.credentialAccount = accountId;
      deps.credentialFamily = familyId;
    },
  };
}
