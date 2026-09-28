import { sql } from "drizzle-orm";
import { apiFaults } from "./schema.js";
import type { Tx } from "./change-log.js";
import type { CallFault } from "./entitlements-client.js";

/**
 * THE API'S OWN 5xx RECORD (cloud 0033) — write, read, prune.
 *
 * `platformSignals` counts what the PLATFORM served and names no route; this names the route and
 * cannot see a killed invocation. Neither subsumes the other, so both rules exist.
 *
 * The write is called from `withErrorEnvelope` THROUGH A PORT — `packages/api/src/middleware.ts`
 * is inside the desktop engine's import closure and may never name a Cloud table. See
 * `ApiFaultLogPort` there.
 */

/** How long a fault row is kept. `SIGNAL_RETENTION_MS`' horizon: rules read minutes, people read days. */
export const API_FAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The error class name a pooled-acquire refusal carries, matched as a STRING for the reason
 * `packages/api/src/middleware.ts` matches it as one: naming `@trafficflow/db`'s entry point from
 * a module in the engine's closure pulls the whole Cloud schema into a published artifact.
 * `test/api-faults.test.ts` imports the real class and asserts this still names it.
 */
export const POOLER_REFUSAL_ERROR_CLASS = "DbAcquireTimeoutError";

/**
 * A credit-check call no request was waiting on that got no answer: a refresh behind a response.
 * On a host that freezes after answering it is the host's pause as often as the program's, and it
 * refused nobody, so it is recorded under its own class and is not a 5xx the API served. How long
 * it ran is on the warn line the same call writes; the row carries no timing.
 */
export const OUTLIVED_REQUEST_ERROR_CLASS = "EntitlementsCallOutlivedRequest";

/** Which arm answered the request. `alert_pass_runs.driver`'s closed set, with a CHECK behind it. */
export type ApiFaultArm = "api" | "worker";

/** The synthetic route a failed call OUT to the entitlements program is recorded under. */
export const ENTITLEMENTS_FAULT_ROUTE_PREFIX = "entitlements:";

/**
 * HOW EACH ARM RECORDS A FAILED CALL TO THE ENTITLEMENTS PROGRAM: a row per call from the API host,
 * a row per path per minute from the worker. The worker asks per account on every cycle, roster
 * read and alert pass, so an outage would write up to 360 rows per account per hour (one call per
 * budget plus fault hold, 10 s); the minute bounds it at 60 per path per hour per process.
 * `api_fault_rate` reads this table to say what its count counts.
 */
export const ENTITLEMENTS_FAULT_GRAIN: { readonly [A in ApiFaultArm]: "call" | "minute" } = {
  api: "call", worker: "minute",
};

export interface ApiFaultInput {
  route: string;
  method: string;
  status: number;
  errorClass: string;
  requestId: string | null;
  arm: ApiFaultArm;
  at: Date;
}

/**
 * A CREDIT-CHECK CALL FAULT AS A ROW (cloud 0033), beside the constraints it must satisfy.
 *
 * The route is SYNTHETIC and names the far end and its path (`entitlements:/v1/spend`): the route
 * whose request failed already writes its own 503 row, so a second row under that pattern would
 * double every count read from this table. `arm` is the HOST whose call failed, by ruling
 * (2026-09-29) — the prefix names the far end, so no third arm value exists. The status is
 * CHECK-constrained to 500-599: nothing arriving reads 504, the program's own 5xx passes through,
 * anything else reads 502.
 */
export function entitlementsFaultRow(
  fault: { path: string; status: number | null; outlivedRequest?: boolean },
  arm: ApiFaultArm, at: Date,
): ApiFaultInput {
  const s = fault.status;
  return {
    route: `${ENTITLEMENTS_FAULT_ROUTE_PREFIX}${fault.path}`,
    method: "POST",
    status: s === null ? 504 : (s >= 500 && s <= 599 ? s : 502),
    // A closed set, not the status spelled into a name: every rule that groups on this column
    // wants a small set, and the exact status is on the warn line the same call writes. A program
    // that ANSWERED 5xx did so whoever waited; only a missing answer behind a response is moot.
    errorClass: s !== null ? "EntitlementsCallRefused"
      : fault.outlivedRequest ? OUTLIVED_REQUEST_ERROR_CLASS : "EntitlementsCallTimeout",
    // Our own request id is bound by the middleware, downstream of the client that dials. Null is
    // the state the column names, not a value we could have had and dropped.
    requestId: null,
    arm,
    at,
  };
}

/** The one line shape a fault recorder logs to; a host's `Logger` satisfies it. */
export interface FaultRecorderLog {
  warn(event: string, fields?: Record<string, unknown>): void;
}

/**
 * THE ONE RECORDER A HOST HANDS ITS ENTITLEMENTS CLIENT as `onCallFault`: a warn line per failed
 * call, and a row at the arm's grain ({@link ENTITLEMENTS_FAULT_GRAIN}). Never rejects — a row that
 * cannot be written is a warn line, not the caller's error. `handle` is asked per row, so a host
 * may give each write a fresh connection. The caller decides whether to await it.
 */
export function entitlementsFaultRecorder(
  handle: () => Tx, arm: ApiFaultArm,
  opts: { log?: FaultRecorderLog; now?: () => Date } = {},
): (fault: CallFault) => Promise<void> {
  const clock = opts.now ?? (() => new Date());
  const recordedMinute = new Map<string, number>();
  return async (fault) => {
    const at = clock();
    const row = entitlementsFaultRow(fault, arm, at);
    opts.log?.warn("entitlements_call_fault", {
      route: row.route, status: fault.status, errorClass: row.errorClass,
      elapsedMs: fault.elapsedMs, budgetMs: fault.budgetMs,
    });
    if (ENTITLEMENTS_FAULT_GRAIN[arm] === "minute") {
      const minute = Math.floor(at.getTime() / 60_000);
      if (recordedMinute.get(row.route) === minute) return;
      recordedMinute.set(row.route, minute);
    }
    try {
      await recordApiFault(handle(), row);
    } catch (err) {
      opts.log?.warn("entitlements_fault_unrecorded", { route: row.route, errorClass: faultClassOf(err) });
    }
  };
}

/** Ceilings from cloud 0033's `api_faults_len_check`, applied here so a write is refused by the
 *  application before the database refuses it — the row is diagnostic, and losing one to a
 *  constraint violation would take the diagnosis with it. */
const LIMITS = { route: 200, method: 20, errorClass: 200, requestId: 100 } as const;

const clamp = (v: string, max: number): string => (v.length <= max ? v : v.slice(0, max));

/**
 * The class name of a thrown value — `String` for a thrown primitive, which is a real shape here
 * (`organizer_profile_write_failed` lost the payload of a thrown string for exactly this reason).
 * Never the message: a driver's message quotes connection strings and an application's quotes
 * what a person typed.
 */
export function faultClassOf(err: unknown): string {
  if (err === null) return "null";
  if (err === undefined) return "undefined";
  if (typeof err !== "object") return err.constructor?.name ?? typeof err;
  const named = (err as { name?: unknown }).name;
  if (typeof named === "string" && named.length > 0) return named;
  return (err as object).constructor?.name ?? "Object";
}

/** One row. Throws only what the caller's own catch handles — the port swallows. */
export async function recordApiFault(db: Tx, input: ApiFaultInput): Promise<void> {
  await db.insert(apiFaults).values({
    at: input.at,
    route: clamp(input.route, LIMITS.route),
    method: clamp(input.method, LIMITS.method),
    status: input.status,
    errorClass: clamp(input.errorClass, LIMITS.errorClass),
    requestId: input.requestId === null ? null : clamp(input.requestId, LIMITS.requestId),
    arm: input.arm,
  });
}

export interface ApiFaultRouteCount {
  route: string;
  arm: string;
  faults: number;
  poolerRefusals: number;
  newest: Date;
}

/**
 * Faults inside the window, GROUPED BY ROUTE — the population `api_fault_rate` judges.
 *
 * A COUNT and never a rate: this table holds no successes, so there is no denominator to divide
 * by. `platformSignals` owns the ratio question and has both counts; a rate invented from one of
 * them would be a quotient over an unknown population. A call that outlived its request answered
 * no request, so it is not in the population ({@link OUTLIVED_REQUEST_ERROR_CLASS}).
 */
export async function apiFaultWindow(
  db: Tx, now: Date, windowMs: number,
): Promise<ApiFaultRouteCount[]> {
  const cut = new Date(now.getTime() - windowMs);
  const rows = await db
    .select({
      route: apiFaults.route,
      arm: apiFaults.arm,
      faults: sql<number>`count(*)::int`,
      poolerRefusals:
        sql<number>`count(*) filter (where ${apiFaults.errorClass} = ${POOLER_REFUSAL_ERROR_CLASS})::int`,
      newest: sql<Date>`max(${apiFaults.at})`,
    })
    .from(apiFaults)
    // `.toISOString()::timestamptz` and not the Date: a JS Date inside a raw fragment has no
    // column to take its type from, and postgres@3 refuses it where PGlite accepts it.
    .where(sql`${apiFaults.at} >= ${cut.toISOString()}::timestamptz
      and ${apiFaults.errorClass} <> ${OUTLIVED_REQUEST_ERROR_CLASS}`)
    .groupBy(apiFaults.route, apiFaults.arm);
  return rows
    .map((r) => ({
      route: r.route,
      arm: r.arm,
      faults: Number(r.faults ?? 0),
      poolerRefusals: Number(r.poolerRefusals ?? 0),
      newest: new Date(r.newest as unknown as string),
    }))
    .sort((a, b) => b.faults - a.faults || a.route.localeCompare(b.route));
}

/**
 * Pooled-acquire refusals inside the window, DEPLOYMENT-WIDE.
 *
 * Not per route, and that is the whole reading: a saturated pooler refuses whichever request
 * asked next, so the route it landed on is noise. `middleware.ts` says the same thing one level
 * up — one refusal is the ceiling working, and the incident is the RATE.
 */
export async function poolerRefusalsInWindow(
  db: Tx, now: Date, windowMs: number,
): Promise<{ refusals: number; routes: number; newest: Date | null }> {
  const cut = new Date(now.getTime() - windowMs);
  const rows = await db
    .select({
      refusals: sql<number>`count(*)::int`,
      routes: sql<number>`count(distinct ${apiFaults.route})::int`,
      newest: sql<Date | null>`max(${apiFaults.at})`,
    })
    .from(apiFaults)
    .where(sql`${apiFaults.at} >= ${cut.toISOString()}::timestamptz
      and ${apiFaults.errorClass} = ${POOLER_REFUSAL_ERROR_CLASS}`);
  const r = rows[0];
  return {
    refusals: Number(r?.refusals ?? 0),
    routes: Number(r?.routes ?? 0),
    newest: r?.newest ? new Date(r.newest as unknown as string) : null,
  };
}

/** Rows older than `retentionMs` are deleted; the count is returned so a pass can log a drain. */
export async function pruneApiFaults(
  db: Tx, now: Date, retentionMs: number = API_FAULT_RETENTION_MS,
): Promise<number> {
  const cut = new Date(now.getTime() - retentionMs);
  const res = await db
    .delete(apiFaults)
    .where(sql`${apiFaults.at} < ${cut.toISOString()}::timestamptz`);
  return Number((res as unknown as { count?: number }).count ?? 0);
}
