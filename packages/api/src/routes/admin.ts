import { silentLogger, type Logger } from "@trafficflow/core";
import {
  adminAccountDetail, adminAccounts, adminActions, adminAlerts, adminWorker,
  adminWorkerInstances, adminBilling, adminFunnel,
  type AccountQuery, type AdminDb, type ApiHealth, type OverviewSnapshot,
} from "@trafficflow/services";
import { DEFAULT_ALERT_THRESHOLDS } from "@trafficflow/db/cloud";
import { presentsSecret, secretRouteJson as json } from "../secret-auth.js";
import { resolveStaffSession } from "./admin-staff.js";
import { API_VERSION } from "../version.js";
import { healthFault, probeDatabase } from "./health.js";
// The BOTH-HALVES census. Hosted-only by construction — see `health-cloud.ts`; the admin console
// is a hosted surface and the local route table does not mount it.
import {
  EXPECTED_MARKERS, SCHEMA_MARKER_JOURNAL_TAG, CLOUD_TIER_MARKERS,
  CLOUD_CHECK_DEFINITION_MARKERS, CLOUD_INDEX_MARKERS, CLOUD_FUNCTION_MARKERS,
} from "./health-cloud.js";
import type { ApiDeps } from "../deps.js";
import type { Handler, Route, RouteParams } from "../router.js";

/**
 * `GET /admin/*` — the six READS behind the staff console.
 *
 * The console rendered real screens driven entirely by fixtures before these endpoints
 * existed. Every number on it was invented. These six endpoints are what make it
 * show production instead, and they are the whole read surface: there is no write route here,
 * on purpose. See `packages/services/src/admin-service.ts` for the queries and for what they
 * may never select.
 *
 * ══ 1. AUTHORIZATION: THE SHARED SECRET **AND** A LIVE STAFF SESSION ═══════════════════════
 *
 * Every route is `{ public: true, anonymous: true, raw: true }`. `anonymous` is the load-bearing
 * one: it selects `ANONYMOUS_PIPELINE` in `app.ts`, which is `[withRequestId, withRequestGuard]`
 * and **does not include `withSession`**. No CUSTOMER credential a caller presents is ever
 * resolved against `sessions`, so:
 *
 *   **an ordinary logged-in customer gets a byte-identical answer to an anonymous stranger.**
 *
 * That is a property of the PIPELINE, not of a branch somebody has to remember to write — the
 * handler has no customer session to check because none was ever fetched. A customer's bearer
 * token simply fails the constant-time compare against the staff secret, exactly as a random
 * string would. `test/admin-routes.test.ts` seeds a real session, presents it as
 * both a cookie and a bearer, and compares the response bytes to the anonymous one.
 *
 * Two credentials, in series, both required — the same pair every admin WRITE has demanded
 * since the first one shipped:
 *
 *  1. `Authorization: Bearer <TF_ADMIN_SECRET>`, the same shape and the same constant-time
 *     compare `POST /internal/alerts` uses (`../secret-auth.js`). Its holder is the admin
 *     console's server-side proxy, which is the only thing that ever presents it; the browser
 *     never sees it.
 *  2. A live STAFF SESSION, resolved against `staff_sessions` from the token the proxy forwards
 *     in {@link STAFF_SESSION_HEADER}. A GET has no body, so the token rides in a header where
 *     the writes put it in the body; the proxy reads it out of the operator's HttpOnly
 *     `__Host-ohmail_admin_session` cookie server-side, exactly as `account-actions.ts` does
 *     for the writes. Every `staff_sessions` row is minted past the TOTP wall
 *     (`admin-staff.ts`), so the second factor is structural, not re-checked here.
 *
 * **The reads were secret-only at first, and closing that is the point of the second
 * credential:** the gate secret is a shared, non-revocable bearer — a former
 * operator, a screenshot, a synced browser profile all keep it — and these six responses carry
 * customer PII (login emails, billing emails, account names, mailbox addresses). Requiring the
 * per-person second factor on reads bounds who can pull the roster to people who can pass TOTP
 * today, and makes a read attributable to a person rather than to a shared secret.
 *
 * **404 when `deps.admin` is absent, 401 when the secret is wrong, 401 `staff_session_required`
 * when the secret is right and no live staff session accompanies it.** A deployment that
 * configured no secret has no admin surface, and advertising an endpoint it cannot
 * authenticate is strictly worse than not having one. Missing header and wrong secret are the
 * same 401 with the same body: on an anonymous route those are the same fact.
 *
 * ══ 2. THE CEILING, WRITTEN DOWN ══════════════════════════════════════════════════════════
 *
 * One secret. No per-person revocation, no read audit, no rate limit on the compare. Rotating it
 * means changing an environment variable on TWO deployments and redeploying both. Anyone
 * with dashboard access to either can read it. What bounds the damage is that the
 * secret ALONE now buys **nothing at all**: every read here and every write in
 * `admin-actions.ts` / `admin-oauth.ts` also requires a live
 * `staff_sessions` row — a person, minted past the TOTP wall, revocable one row at a time.
 *
 * This paragraph has tightened twice, in the honest direction each time. It first said "no
 * write route exists to be reached with it"; suspend/resume shipped and it became "the secret
 * alone buys read-only cross-account metadata"; the staff-session requirement on reads retired
 * that too, because metadata here means the customer roster and its addresses.
 *
 * `admin-oauth.ts` records its actor ON THE ROW (`oauth_provider_config.updated_by`) instead of
 * in `audit_log`, because `audit_log.account_id` is NOT NULL and a change to this deployment's
 * own Entra registration belongs to no account; forcing one in would be a lie in the column the
 * audit trail is keyed by.
 *
 * The reads in THIS file remain read-only on the blind role (`deps.adminDb`), which the
 * pipeline (`anonymous`, no `withSession`) and the boot attestation enforce structurally.
 *
 * ══ 3. WHAT THESE ENDPOINTS MAY NEVER RETURN, AND WHY IT IS NO LONGER A PROMISE ═══════════
 *
 * No message content — not a subject, snippet, sender, recipient or body; no credential blob,
 * no Stripe payload, no password or token hash. That is published to users
 * (`apps/webapp/messages/en.json`, q5). Three independent mechanisms stand behind it, and each
 * is stated below WITH what it does not cover — two of the three were overstated in this
 * comment before, and a confident sentence here is what made the published claim false:
 *
 *  1. **The DATABASE refuses.** Every read below runs on `deps.adminDb`, a second connection in
 *     this process authenticated as `ohmail_admin`, whose grants answer 42501 to every
 *     mail-content column — and, after a later hardening, to the `messages` relation ENTIRELY,
 *     along with `change_log`, `folder_state` and `flag_state`. That last part is a correction
 *     an external security review forced: a `messages(id, mailbox_id)` grant reads as minimal
 *     and is still a receipt oracle, because `count(*)` names no column and a row's existence
 *     around a delivery the tester chose is exactly the fact a content-blind role must not
 *     disclose. `assertContentBlind` now bites on
 *     `select count(*) from messages` for exactly that reason.
 *
 *     **What this does not cover:** the provisioning script's effective-privilege postcondition
 *     closed a family of review findings — a `SECURITY DEFINER` routine reachable through
 *     `PUBLIC`, a leftover view in
 *     schema `admin`, and privileges inherited from role membership, ownership or `PUBLIC` — but
 *     it closed them by ABORTING rather than by repairing, so a database in one of those states
 *     is a failed provisioning run an operator has to resolve, not a state this file survives.
 *  2. **THE CALLBACK HAS NO RUNTIME HANDLE TO REACH FOR.** The brand is the
 *     small half of this and the earlier wording rested on it: `adminAccounts` and its five
 *     siblings take a branded `AdminDb`, so handing one of THEM a bare `Db` does not typecheck
 *     — but brands are erased at runtime and `as unknown as AdminDb` forges one in a single
 *     edit. What actually holds is VALUE-SCOPING: a read receives {@link StaffContext} and
 *     nothing else — the blind handle, a clock, the environment string, this route's logger,
 *     and `apiHealth()`. **There is no `Db` in scope to select from, and none to cast FROM
 *     either**, because a double assertion needs a runtime-capable value on its left. Closure
 *     capture, a laundering helper and a defaulted parameter all fail for the same one reason:
 *     `ApiDeps` never enters the callback.
 *
 *     **What that does NOT cover, stated rather than implied:** nothing in this process stops a
 *     callback from writing `import { makePooledDb }` and reading the pooled URL out of the
 *     environment for itself. That is somebody deliberately opening a second connection — not
 *     the "seventh endpoint someone forgot to keep narrow" path the content-blind rule is about,
 *     which is the
 *     one this contract closes. The escalation for the other one is a separate admin deployment
 *     whose environment simply has no runtime URL to read; that is recorded future work, and it
 *     is deliberately not built yet.
 *  3. The DTOs in `packages/services/src/admin-dto.ts` cannot NAME such a field, and
 *     `test/admin-routes.test.ts` seeds real mail with distinctive markers and fails if one appears
 *     in any of the six responses. This is the half that still depends on review: a new DTO
 *     field is one edit away, and only the marker scan would catch it.
 *
 * `ctx.apiHealth()` is the ONE deliberate exception, and it is a CAPABILITY rather than a
 * value: {@link adminRoute} closes over `deps` and hands the callback a function it can only
 * CALL, whose return type is {@link ApiHealth} — a fixed record of host, version, latency and
 * marker counts, which cannot express an application row. The probe behind it reads
 * `information_schema` and `pg_catalog` on the RUNTIME connection, because the console's claim
 * is that it renders what a probe of the user-serving host would see. It is a function and not
 * a pre-computed field because five of the six reads never look at it, and pre-computing would
 * run a database round trip on all six.
 *
 * ══ 4. NO ERROR ENVELOPE ABOVE THIS FILE ══════════════════════════════════════════════════
 *
 * `raw` means `withErrorEnvelope` does not run, so an unhandled rejection here becomes the
 * platform's own HTML 500 — an ops console whose failure mode is unreadable. Every handler is
 * therefore wrapped by {@link adminRoute}, which is the only place a throw can be caught.
 */

/**
 * The console's `GET /health` block, computed in-process rather than over the network.
 *
 * MODULE-PRIVATE, and it must stay that way: this is the only function in the file that takes
 * `ApiDeps`, and the only one that touches the runtime connection. It is reachable from a staff
 * read exclusively as {@link StaffContext.apiHealth}, a closure {@link adminRoute} builds — so
 * what a callback holds is the RESULT type, never the handle the result was computed from.
 */
async function apiHealthFor(req: Request, deps: ApiDeps): Promise<ApiHealth> {
  const injected = deps.health;
  const version = injected?.version ?? API_VERSION;
  const kek = injected?.kek ?? null;
  const kekError = injected?.kekError ?? null;
  const buildError = injected?.buildError ?? null;
  const host = req.headers.get("host") ?? (() => {
    try {
      return new URL(req.url).host;
    } catch {
      return "";
    }
  })();
  const checkedAt = deps.now().toISOString();

  // THE SAME probe `/health` runs, from the same module — not a second implementation of it.
  // The console's claim is that it renders what a probe would see, and two copies of this
  // query would drift on the first schema marker anybody adds, silently, with both endpoints
  // still answering 200.
  // EXPLICIT, because `probeDatabase`'s default narrowed to the MAIL half when the Cloud marker
  // list left `health.ts` (that module ships in the desktop engine). The admin console is a
  // hosted surface and must keep measuring against both journals.
  // The CHECK-DEFINITION, CLOUD-INDEX and CLOUD-FUNCTION halves are passed for the same reason
  // the column list is: a hosted surface must measure against both journals — cloud 0011 is
  // invisible to every probe that reads only names, cloud 0013's index name cannot live in
  // `health.ts`, and cloud 0014 is a replaced function BODY that only the fifth class can see.
  const probe = await probeDatabase(
    deps.db, CLOUD_TIER_MARKERS, CLOUD_CHECK_DEFINITION_MARKERS, CLOUD_INDEX_MARKERS,
    CLOUD_FUNCTION_MARKERS,
  );
  const base = {
    host,
    version,
    cookieAuth: deps.allowCookieAuth !== false,
    kek,
    checkedAt,
  };
  if (probe.kind !== "probed") {
    return {
      ...base,
      status: 503,
      ok: false,
      dbLatencyMs: probe.dbLatencyMs,
      dbReachable: false,
      pgTrgm: false,
      schemaOk: false,
      schemaMarkers: { found: 0, expected: EXPECTED_MARKERS, through: SCHEMA_MARKER_JOURNAL_TAG },
      error: probe.kind === "unreachable" ? "database_unreachable" : "database_probe_empty",
      errorDetail: probe.kind === "unreachable" ? probe.errorCode : null,
    };
  }
  const fault = healthFault({
    schemaOk: probe.schemaOk, markersFound: probe.markersFound, kekError, buildError,
  });
  return {
    ...base,
    status: fault ? 503 : 200,
    ok: fault === null,
    dbLatencyMs: probe.dbLatencyMs,
    dbReachable: true,
    pgTrgm: probe.pgTrgm,
    schemaOk: probe.schemaOk,
    // `EXPECTED_MARKERS`, not `SCHEMA_MARKERS.length` — the console publishes the SAME
    // `ApiHealth` /health does, and `found` here is `probe.markersFound`, which counts the
    // column, index AND check probes. Measuring it against the column list alone published
    // `18/17` for a perfectly healthy database (and `19/17` once mail 0022 landed) — the exact
    // drift this file's header warns a second copy of the health logic would cause.
    schemaMarkers: {
      found: probe.markersFound, expected: EXPECTED_MARKERS, through: SCHEMA_MARKER_JOURNAL_TAG,
    },
    error: fault?.error ?? null,
    errorDetail: fault?.detail ?? null,
  };
}

/**
 * EVERYTHING A STAFF READ IS GIVEN. There is no seventh field and no `deps`.
 *
 * The point is not that the shape is small — it is that `ApiDeps` is ABSENT, so the runtime
 * `Db` a staff route must never issue SQL on is not a value the callback can name, capture,
 * launder through a helper, default a parameter to, or cast from. `as unknown as AdminDb` is
 * the forge the review named, and it needs something runtime-capable on its left; there is nothing.
 *
 * `keyof` this interface is pinned by `test/contract/staff-callback.fixture.ts`,
 * so widening it is a decision somebody has to make on purpose and defend in a diff, rather
 * than a field that arrives because it was convenient once.
 */
export interface StaffContext {
  /** The blind handle, already awaited — `ohmail_admin`, attested at construction. */
  db: AdminDb;
  /** `deps.now`, so a staff read is as fake-clockable as everything else. */
  now(): Date;
  /** `production` / `preview` — `deps.admin.environment`, defaulted by the wrapper. */
  environment: string;
  /** This route's child logger (`route: /admin/<name>`), the same one the wrapper logs on. */
  logger: Logger;
  /**
   * The §3 exception, as a capability. Calling it runs the SAME catalog probe `/health` runs,
   * on the runtime connection the wrapper holds; the callback gets {@link ApiHealth} back and
   * never the handle. A fixed record of scalars cannot express an application row.
   */
  apiHealth(): Promise<ApiHealth>;
}

/**
 * The staff read contract. `req` stays because `accountQueryOf` needs the query string and a
 * `Request` carries no database; `params` stays for `/admin/accounts/:id`.
 */
export type StaffRead =
  (req: Request, ctx: StaffContext, params: RouteParams) => Promise<unknown>;

async function overview(ctx: StaffContext): Promise<OverviewSnapshot> {
  const now = ctx.now();
  // SEQUENTIAL on purpose — this was `Promise.all`, and it DEADLOCKED, every time, in every
  // environment (both hosted-Postgres providers alike; "admin never worked" was this line). The
  // blind pool
  // is `max: 1`, and one of these reads opens a transaction: with a sibling query queued on
  // the pool's only connection, an inner query inside the transaction queues BEHIND the
  // sibling, which waits for the transaction — a circular wait, killed only by the platform's
  // 60s timeout. The same class as nesting a pooled query inside an open transaction. Reproduced
  // and bisected:
  // each read alone is fine, the parallel pair hangs. Do not "optimise" this back.
  //
  // `ctx.apiHealth()` and not `ctx.db`: the health block reports the RUNTIME connection, on
  // purpose — see §3. Everything else on this page reads through the blind one.
  const api = await ctx.apiHealth();
  const instances = await adminWorkerInstances(ctx.db, now);
  const alerts = await adminAlerts(ctx.db, now);
  return {
    now: now.toISOString(),
    environment: ctx.environment,
    api,
    worker: {
      instances,
      // The alerter's own threshold, so the console judges by the rule that pages a human.
      leaderStaleAfterSeconds: Math.round(DEFAULT_ALERT_THRESHOLDS.leaderStaleMs / 1000),
    },
    alerts,
  };
}

/** `?search=&filter=&page=&pageSize=` → {@link AccountQuery}. Unknown values fall back. */
function accountQueryOf(req: Request): AccountQuery {
  const params = new URL(req.url).searchParams;
  const filter = params.get("filter");
  const allowed = ["all", "attention", "suspended", "past_due", "no_subscription"] as const;
  return {
    // Bounded before it reaches a `LIKE`-free in-process fold, so a megabyte of query string
    // cannot become a megabyte of `normalize("NFD")`.
    search: (params.get("search") ?? "").slice(0, 200),
    filter: (allowed as readonly string[]).includes(filter ?? "")
      ? (filter as AccountQuery["filter"])
      : "all",
    page: Number(params.get("page") ?? 0),
    pageSize: Number(params.get("pageSize") ?? 0),
  };
}

/**
 * PER-INSTANCE SERIALIZATION OF ADMIN READS — the production 504 fix.
 *
 * The blind handle is a module-cached `max: 1` pool (`makePooledDb` in `@trafficflow/db`), so
 * every request a WARM instance serves shares ONE connection to the pooler. The Today dashboard
 * fires `overview()`, `billing()` and `worker()` concurrently (a client `Promise.allSettled`);
 * when two of them land on the same warm instance they contend for that single connection, and
 * because a read holds it across an `await` while the next query queues, the wait is CIRCULAR and
 * rides to the platform's 60 s limit as a 504. Measured in production: each read alone returns in
 * well under a second, so nothing here is slow — the fault is
 * purely the interleaving.
 *
 * This is the SAME `max: 1` hazard `overview()` and `adminWorker()` already defend against WITHIN
 * a single handler (their comments: "do not `Promise.all` them"). Serializing here closes the
 * ACROSS-handler case the client's concurrent fan-out opened, and it costs nothing because the
 * reads are sub-second: three serialized reads still finish far under the function limit.
 *
 * The chain advances only when the previous read SETTLES — so the pool is free before the next
 * read acquires it — and a rejection is swallowed on the CHAIN so one read's failure cannot wedge
 * the chain for the next request (the caller still sees the rejection through the returned promise).
 *
 * KEYED BY THE `staff` FACTORY, not a bare module variable. That factory is memoised per warm
 * instance (`apps/api-vercel/src/deps.ts`: `adminDbFor` is held module-level), so one instance = one
 * key = one chain = the pool's own lifetime, which is exactly the scope that must be serialized. A
 * WeakMap rather than a module global also means each test's freshly-built factory gets its own
 * chain, so a deliberately-hung read in one test cannot serialize the next.
 */
const adminReadChains = new WeakMap<object, Promise<unknown>>();
function serializeAdminRead<T>(key: object, work: () => Promise<T>): Promise<T> {
  const prev = adminReadChains.get(key) ?? Promise.resolve();
  const run = prev.then(work, work);
  adminReadChains.set(key, run.then(() => undefined, () => undefined));
  return run;
}

/**
 * Bounds the RESPONSE, never the platform's 60 s. A read (or a wait for the serialization chain)
 * that exceeds this becomes a fast, readable 503 the console degrades gracefully, instead of a
 * gateway 504 the browser renders as a dead request. Comfortably above the sub-second reads and
 * well under Vercel's `maxDuration`, so a healthy console never sees it.
 */
const ADMIN_READ_TIMEOUT_MS = 12_000;

function withAdminTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`admin_read_timeout after ${ms}ms`)), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * WHERE THE STAFF SESSION TOKEN RIDES ON A READ.
 *
 * The writes carry it in the JSON body (`admin-actions.ts`); a GET has no body, so the reads
 * carry it here. The value is the raw `staff_sessions` token the console's proxy pulls out of
 * the operator's HttpOnly `__Host-ohmail_admin_session` cookie server-side — the browser never
 * sends this header itself, and the proxy forwards nothing else from the inbound request.
 *
 * The console's server-side proxy spells the same name; it cannot import this constant (the
 * console deliberately depends on no server package), so a suite reads that file's source and
 * asserts the two spellings agree — the same guard the console applies to its own cookie-name
 * duplication in its middleware.
 */
export const STAFF_SESSION_HEADER = "x-staff-session";

/**
 * The gate, the STAFF SESSION, the BLIND HANDLE, the try/catch and the `no-store` JSON,
 * applied identically to all six.
 *
 * Writing it once is what makes "every admin read is authorized the same way, on the same
 * connection" checkable by reading one function instead of six handlers — and what stops the
 * seventh endpoint somebody adds from being the one that forgot.
 *
 * ── THE TWO REFUSALS, WHICH ARE NOT THE SAME FACT ─────────────────────────────────────────
 *
 * **404 when the surface is unarmed** — no secret, or no `DATABASE_URL_ADMIN`. This host has
 * no admin surface at all, and advertising an endpoint it cannot authenticate (or cannot serve
 * blind) is strictly worse than not having one. `/health` names which half is missing.
 *
 * **503 when the handle REFUSES TO EXIST** — the factory's boot attestation either watched the
 * connection ANSWER a mail-content read (the runtime credentials are in the admin variable) or
 * found it holding a capability outside `STAFF_SELECT_GRANTS` — a column, a table privilege, a
 * role membership, ownership, or an executable `SECURITY DEFINER` routine.
 * The log line names which. The console goes down and stays down until somebody fixes the
 * database or the environment. That is the whole design: every misconfiguration of this seam
 * has to become a downed console, never exposure.
 *
 * ── AND THE THIRD THING IT OWNS: THE ONLY `ApiDeps` IN THE STAFF PATH ──────────────────────
 *
 * This function is where `deps` stops. It reads what a staff route legitimately needs out of
 * it, builds a {@link StaffContext}, and passes THAT — so "no admin read issues route-local
 * SQL on the runtime connection" is a property of one wrapper's scope instead of six handlers'
 * discipline. The health capability is a closure over `deps` built here for the same reason.
 */
function adminRoute(name: string, read: StaffRead): Handler {
  return async (req, deps, params) => {
    const cfg = deps.admin;
    const staff = deps.adminDb;
    const log = (deps.logger ?? silentLogger).child({ route: `/admin/${name}` });
    // Unconfigured ⇒ this host has no admin surface. 404, not 401.
    if (!cfg || cfg.secret.trim().length === 0 || !staff) {
      return json(404, { error: { code: "not_found" } });
    }
    if (!presentsSecret(req, cfg.secret)) {
      // Logged because it is an operator's problem: either somebody is probing the endpoint or
      // the two deployments' secrets have diverged, and the second one is invisible otherwise.
      log.warn("admin_unauthorized", {});
      return json(401, { error: { code: "unauthorized" } });
    }
    // THE SECOND CREDENTIAL. Resolved against `staff_sessions` on
    // every request, never cached, on the RUNTIME connection — the blind role holds no grant on
    // `staff_users` by design ("the role that serves the console cannot read the credentials
    // that protect it", admin-staff.ts); the writes make the identical runtime read. A caller
    // with only the shared secret has no token to put in the header, so this is where a
    // leaked/retained gate credential stops. Mutation-watched: `test/admin-routes.test.ts` presents
    // the correct secret WITHOUT a session and requires the 401.
    //
    // Its own try/catch, because `raw` means nothing above this file catches: a database fault
    // DURING resolution must become the same readable 503 a fault inside the read becomes —
    // and never a 401, which would tell an operator their session died when the database did.
    let staffWho;
    try {
      staffWho = await resolveStaffSession(
        deps.db, req.headers.get(STAFF_SESSION_HEADER)?.trim() || undefined, deps.now(),
      );
    } catch (err) {
      log.error("admin_read_failed", { err });
      return json(503, { error: { code: "admin_read_failed" } });
    }
    if (!staffWho) {
      log.warn("admin_read_no_staff_session", {});
      return json(401, { error: { code: "staff_session_required" } });
    }
    try {
      // INSIDE the try: a handle that refuses to construct is a 503 an operator can read, and
      // the reason is logged. It must never fall back to `deps.db`.
      //
      // SERIALIZED and TIME-BOUNDED. `staff()` (its one-per-instance attestation
      // probe) and `read()` both touch the `max: 1` blind pool, so both run inside the chain — a
      // sibling request cannot acquire the connection until this one has released it. The timeout
      // wraps the WHOLE serialized promise, so a request queued behind a stuck predecessor still
      // returns a bounded 503 rather than riding to a 60 s 504.
      const payload = await withAdminTimeout(
        serializeAdminRead(staff, async () => {
          const ctx: StaffContext = {
            db: await staff(),
            now: deps.now,
            environment: cfg.environment ?? "production",
            logger: log,
            apiHealth: () => apiHealthFor(req, deps),
          };
          return read(req, ctx, params);
        }),
        cfg.readTimeoutMs ?? ADMIN_READ_TIMEOUT_MS,
      );
      return json(200, payload);
    } catch (err) {
      // `raw`: nothing above this catches. A 503 an operator can read beats the platform's 500.
      log.error("admin_read_failed", { err });
      return json(503, { error: { code: "admin_read_failed" } });
    }
  };
}

/** All six are GET, all six are `public + anonymous + raw`. There is no seventh. */
const OPTIONS = { public: true, anonymous: true, raw: true } as const;

/**
 * All six are `unauthenticated`: their authority is a shared secret compared in
 * constant time (`secret-auth.ts`), never a user session, and ANONYMOUS_PIPELINE resolves
 * no session at all, so there is no account whose verification state could be judged.
 * `test/spend-gate.test.ts` asserts that pairing in both directions — an `anonymous` route must
 * be `unauthenticated`, and an `unauthenticated` route must be `public` — because a route
 * that resolves no session cannot be defended by `withSpendGate` and must therefore be
 * defended by the table.
 */
const COST = "unauthenticated" as const;

export const adminRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/admin/overview",
    cost: COST,
    options: OPTIONS,
    handler: adminRoute("overview", (_req, ctx) => overview(ctx)),
  },
  {
    method: "GET",
    pattern: "/admin/accounts",
    cost: COST,
    options: OPTIONS,
    handler: adminRoute("accounts", (req, ctx) =>
      adminAccounts(ctx.db, ctx.now(), accountQueryOf(req))),
  },
  {
    method: "GET",
    pattern: "/admin/accounts/:id",
    cost: COST,
    options: OPTIONS,
    // `null` for an unknown id, not 404: the seam's `account(id)` is typed
    // `Promise<AccountDetail | null>`, and the console renders "no such account" from the
    // null rather than from an error path it would otherwise need twice.
    handler: adminRoute("accounts/:id", (_req, ctx, params) =>
      adminAccountDetail(ctx.db, ctx.now(), params.id ?? "")),
  },
  {
    method: "GET",
    pattern: "/admin/billing",
    cost: COST,
    options: OPTIONS,
    handler: adminRoute("billing", (_req, ctx) => adminBilling(ctx.db, ctx.now())),
  },
  {
    method: "GET",
    pattern: "/admin/funnel",
    cost: COST,
    options: OPTIONS,
    handler: adminRoute("funnel", (_req, ctx) => adminFunnel(ctx.db, ctx.now())),
  },
  {
    method: "GET",
    pattern: "/admin/worker",
    cost: COST,
    options: OPTIONS,
    handler: adminRoute("worker", (_req, ctx) => adminWorker(ctx.db, ctx.now())),
  },
  {
    method: "GET",
    pattern: "/admin/actions",
    cost: COST,
    options: OPTIONS,
    handler: adminRoute("actions", (_req, ctx) => adminActions(ctx.db, ctx.now())),
  },
];
