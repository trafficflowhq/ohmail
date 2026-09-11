import { silentLogger, type Logger } from "@trafficflow/core";
import {
  adminAccountDetail, adminAccounts, adminActions, adminAlerts,
  adminAlertDrivers, adminPlatformSignals, adminWorker,
  adminWorkerInstances, adminFunnel,
  type AccountQuery, type AdminDb, type ApiHealth, type OverviewSnapshot,
} from "@trafficflow/services";
import { DEFAULT_ALERT_THRESHOLDS, alertSchemaReadable } from "@trafficflow/db/cloud";
import { presentsSecret, secretRouteJson as json } from "../secret-auth.js";
import { resolveStaffSession } from "./admin-staff.js";
import { API_VERSION } from "../version.js";
import { healthFault, probeDatabase } from "./health.js";
// The BOTH-HALVES census. Hosted-only by construction — see `health-cloud.ts`; the admin console
// is a hosted surface and the local route table does not mount it.
import {
  EXPECTED_MARKERS, SCHEMA_MARKER_JOURNAL_TAG, CLOUD_TIER_MARKERS,
  CHECK_DEFINITION_MARKERS, CLOUD_INDEX_MARKERS, CLOUD_FUNCTION_MARKERS,
} from "./health-cloud.js";
import type { ApiDeps } from "../deps.js";
import type { Handler, Route, RouteParams } from "../router.js";

/**
 * `GET /admin/*` — the eight reads behind the staff console; no write route here (queries:
 * `admin-service.ts`). Authorization: the shared secret AND a live staff session ({@link
 * STAFF_SESSION_HEADER}). Every route is `{ public, anonymous, raw }`; `anonymous` runs the
 * pipeline with no `withSession`, so a logged-in customer gets a byte-identical answer to a
 * stranger (`test/admin-routes.test.ts` compares bytes). 404 unarmed, 401 otherwise. No message
 * content, credential blob, Stripe payload or token hash may return: the blind role answers 42501
 * to `messages` entirely, a read receives {@link StaffContext} only, and the DTOs cannot name
 * such a field, marker-tested. Handlers are wrapped by {@link adminRoute}.
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

  // The same probe `/health` runs, from the same module — two copies would drift on the first
  // schema marker added, silently, both endpoints still 200. Explicit marker lists, because
  // `probeDatabase`'s default narrowed to the mail half when the Cloud marker list left
  // `health.ts` (that module ships in the desktop engine); the console is a hosted surface and
  // must measure against both journals — cloud 0011 is invisible to name-only probes, cloud
  // 0013's index name cannot live in `health.ts`, cloud 0014 is a replaced function body, and the
  // definition list is both halves (`CHECK_DEFINITION_MARKERS`; mail 0100 widens a mail CHECK).
  const probe = await probeDatabase(
    deps.db, CLOUD_TIER_MARKERS, CHECK_DEFINITION_MARKERS, CLOUD_INDEX_MARKERS,
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
 * Everything a staff read is given. The point is not that the shape is small — it is that
 * `ApiDeps` is absent, so the runtime `Db` a staff route must never issue SQL on is not a value
 * the callback can name, capture, launder through a helper, default a parameter to, or cast from
 * (`as unknown as AdminDb` needs something runtime-capable on its left; there is nothing).
 * `keyof` this interface is pinned by `test/contract/staff-callback.fixture.ts`, so widening it
 * is a decision defended in a diff rather than a field that arrives because it was convenient
 * once.
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
  // Sequential on purpose — this was `Promise.all`, and it deadlocked every time: the blind pool
  // is `max: 1`, and one of these reads opens a transaction; with a sibling query queued on the
  // pool's only connection, an inner query inside the transaction queues behind the sibling,
  // which waits for the transaction — a circular wait killed only by the platform's 60 s timeout.
  // Each read alone is fine; the parallel pair hangs. Do not "optimise" this back.
  // `ctx.apiHealth()` and not `ctx.db`: the health block reports the runtime connection on
  // purpose; everything else reads through the blind one.
  const api = await ctx.apiHealth();
  const instances = await adminWorkerInstances(ctx.db, now);

  // The schema-skew reads are gated, because this page is the one that diagnoses skew. When the
  // expected schema is absent (an API deployed ahead of its migration), every read below touches
  // something that migration adds — the first raised 42703/42P01 and the whole route answered a
  // generic 503, taking down the page built to explain the fault. Gated rather than try/caught: a
  // catch would still run the queries and would swallow a real fault as skew. And `apiHealth()`
  // only answers half — it probes the runtime connection, saying nothing about whether
  // `harden-staff-role.sql` was re-run — so the readiness question is asked of the blind handle
  // itself, with the same marker the alert preflight uses: a missing column and an ungranted
  // column are equally invisible to `information_schema`, and both mean these reads must not run.
  const schemaReady = api.schemaOk && await alertSchemaReadable(ctx.db);
  const alerts = schemaReady ? await adminAlerts(ctx.db, now) : [];
  // SEQUENTIAL, on the deadlock note above — these are two more reads on the same `max: 1` blind
  // pool and a `Promise.all` here would reintroduce exactly the circular wait that comment
  // records. Both are bounded: two rows from `alert_pass_runs` by primary key, and one grouped
  // aggregate over fifteen minutes of `platform_signals` on its own index.
  const alertDrivers = schemaReady ? await adminAlertDrivers(ctx.db, now) : [];
  const platformSignals = schemaReady ? await adminPlatformSignals(ctx.db, now) : [];
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
    alertDrivers,
    platformSignals,
    // SAID ON THE WIRE, not inferred from the empties above — see the field's own note. The
    // console cannot derive this from `api.schemaOk`, because the grant half of it leaves that
    // flag true.
    alertsUnavailable: !schemaReady,
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
 * Per-instance serialization of admin reads. The blind handle is a module-cached `max: 1` pool,
 * and the Today dashboard fires three reads concurrently: two on the same warm instance contend
 * for the single connection, a read holds it across an `await` while the next queues, and the
 * circular wait rides to the platform limit as a 504 — each read alone is sub-second. Serializing
 * closes the across-handler case the client's fan-out opened. The chain advances only when the
 * previous read settles, a rejection is swallowed on the chain (the caller still sees it), and it
 * is keyed by the `staff` factory in a WeakMap — one warm instance, one chain.
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
 * Where the staff session token rides on a read. The writes carry it in the JSON body; a GET has
 * no body, so the reads carry it here. The value is the raw `staff_sessions` token the console's
 * proxy pulls out of the operator's HttpOnly `__Host-ohmail_admin_session` cookie server-side —
 * the browser never sends this header, and the proxy forwards nothing else. The console's proxy
 * spells the same name and cannot import this constant (it deliberately depends on no server
 * package), so a suite reads that file's source and asserts the two spellings agree.
 */
export const STAFF_SESSION_HEADER = "x-staff-session";

/**
 * The gate, the staff session, the blind handle, the try/catch and the `no-store` JSON, applied
 * identically to all eight — written once so "every admin read is authorized the same way, on the
 * same connection" is checkable by reading one function. Two refusals, not the same fact: 404
 * when the surface is unarmed (no secret or no `DATABASE_URL_ADMIN`; `/health` names which half),
 * and 503 when the handle refuses to exist — the boot attestation watched the connection answer a
 * mail-content read or found a capability outside `STAFF_SELECT_GRANTS`; the console stays down
 * until the database or environment is fixed. This function is also where `deps` stops: it builds
 * a {@link StaffContext} and passes that.
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
    // The second credential: resolved against `staff_sessions` on every request, never cached, on
    // the runtime connection — the blind role holds no grant on `staff_users` ("the role that
    // serves the console cannot read the credentials that protect it"). A caller with only the
    // shared secret has no token to put in the header, so this is where a leaked gate credential
    // stops; `test/admin-routes.test.ts` presents the correct secret without a session and
    // requires the 401. Its own try/catch, because `raw` means nothing above this file catches: a
    // database fault during resolution must become the same readable 503 a fault inside the read
    // becomes — never a 401 telling an operator their session died when the database did.
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

/** All NINE are GET, all nine are `public + anonymous + raw`. There is no tenth. */
const OPTIONS = { public: true, anonymous: true, raw: true } as const;

/**
 * All NINE are `unauthenticated`: their authority is a shared secret compared in
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
    relay: false,  /* the hosted console's own surface */
    cost: COST,
    options: OPTIONS,
    handler: adminRoute("overview", (_req, ctx) => overview(ctx)),
  },
  {
    method: "GET",
    pattern: "/admin/accounts",
    relay: false,  /* the hosted console's own surface */
    cost: COST,
    options: OPTIONS,
    handler: adminRoute("accounts", (req, ctx) =>
      adminAccounts(ctx.db, ctx.now(), accountQueryOf(req))),
  },
  {
    method: "GET",
    pattern: "/admin/accounts/:id",
    relay: false,  /* the hosted console's own surface */
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
    pattern: "/admin/funnel",
    relay: false,  /* the hosted console's own surface */
    cost: COST,
    options: OPTIONS,
    handler: adminRoute("funnel", (_req, ctx) => adminFunnel(ctx.db, ctx.now())),
  },
  {
    method: "GET",
    pattern: "/admin/worker",
    relay: false,  /* the hosted console's own surface */
    cost: COST,
    options: OPTIONS,
    handler: adminRoute("worker", (_req, ctx) => adminWorker(ctx.db, ctx.now())),
  },
  {
    method: "GET",
    pattern: "/admin/actions",
    relay: false,  /* the hosted console's own surface */
    cost: COST,
    options: OPTIONS,
    handler: adminRoute("actions", (_req, ctx) => adminActions(ctx.db, ctx.now())),
  },
];
