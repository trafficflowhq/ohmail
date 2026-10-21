import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, max, sql } from "drizzle-orm";
import { alertDrills } from "./schema-cloud.js";
import {
  ALERT_KIND_ARMS, deliver,
  type AlertDriver, type AlertSink, type DeliveryReport, type SinkOutcome,
} from "./alerts.js";
import type { Alert, AlertKind } from "./alert-types.js";
import type { Tx } from "./change-log.js";

/**
 * ALERT DRILLS (cloud 0051). A drill sends every alert kind once through a driver's sinks, so the
 * pager's delivery is tested end to end, and records what each sink answered and whether a person
 * acknowledged the message. It is never a condition: it reaches the sinks through `deliver()`, the
 * database-free seam, and this module writes `alert_drills` and nothing else. No real incident's
 * row, mail window, pass record or delivery streak is read or written here, so a drill cannot
 * consume or delay a real page.
 *
 * One message per (run, driver, sink) carries every kind of the run: the API host's mail arm spends
 * a recipient limiter shared with real pages, and one link per kind would not fit a Telegram
 * message. So there is one ack token per message, its sha256 stored on every row the message
 * covers. Showing an ack page writes nothing; only a POST acknowledges, so a mail link scanner
 * cannot.
 */

/** One run per deployment per hour. */
export const DRILL_MIN_INTERVAL_MS = 60 * 60 * 1000;
/** A worker request not taken within this is stamped `expired` and never delivered. */
export const DRILL_REQUEST_TTL_MS = 60 * 60 * 1000;
/** How long a message can be acknowledged, counted from `fired_at`. */
export const DRILL_ACK_TTL_MS = 24 * 60 * 60 * 1000;
/** Kept equal to cloud 0051's CHECK: the sink outcomes, then the queue's three. */
export const DRILL_OUTCOMES = [
  "ok", "misconfigured", "refused", "unreachable", "timeout", "threw", "dispatched", "unarmed", "expired",
] as const;
export type DrillOutcome = (typeof DRILL_OUTCOMES)[number];
/** The `classid` half of the run throttle's `pg_advisory_xact_lock(int4, int4)`. */
export const ALERT_DRILL_LOCK_CLASS = 420_727_020;
/** Where an ack link points, below the host's API base. */
export const DRILL_ACK_PATH = "/internal/alerts/drill/ack";
/** The sink name of a worker request, and of a driver that had no usable sink. */
const NO_SINK = "*";
const DRILL_DETAIL = "A drill of the alert delivery, not a real condition.";

/** Every alert kind there is, sorted: the table `alert-kind-arms.test.ts` holds to the union. */
export function drillKinds(): AlertKind[] {
  return (Object.keys(ALERT_KIND_ARMS) as AlertKind[]).sort();
}

/** The environment a drill's sinks print: it is the first word of every header and mail subject. */
export function drillEnvironment(environment: string): string {
  return `DRILL ${environment}`;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** An ack token's shape: 32 random bytes in base64url. */
export function isDrillToken(t: unknown): t is string {
  return typeof t === "string" && TOKEN.test(t);
}

const newToken = (): string => randomBytes(32).toString("base64url");
const hashOf = (token: string): string => createHash("sha256").update(token).digest("base64url");

/**
 * The base an ack link may be built on, or null: https (http on loopback only), no credentials,
 * query or fragment, at most 200 characters. The API composes it from validated configuration; the
 * worker checks it again before mailing it.
 */
export function usableAckBase(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 200) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return null;
  if (u.username || u.password || u.search || u.hash || raw.includes("?") || raw.includes("#")) return null;
  return raw;
}

export function drillAckUrl(ackBase: string, token: string): string {
  return `${ackBase}${DRILL_ACK_PATH}?t=${token}`;
}

/**
 * One alert per kind. Every title carries the run, so two runs never share a mail arm's
 * idempotency key; the severity is always `warning`, so a paging webhook never escalates a drill;
 * the one ack link is in the first alert's detail.
 */
export function drillAlerts(runId: string, kinds: readonly AlertKind[], ackUrl: string | null): Alert[] {
  const run = runId.slice(0, 8);
  return kinds.map((kind, i) => ({
    key: `drill:${runId}:${kind}`,
    kind,
    severity: "warning" as const,
    title: `[DRILL] ${kind} (run ${run})`,
    detail: i === 0 && ackUrl
      ? `${DRILL_DETAIL} Acknowledge this message (${kinds.length} kinds) within 24 h: ${ackUrl}`
      : DRILL_DETAIL,
    count: 1,
    oldestSeconds: null,
    cls: "incident" as const,
  }));
}

export type DrillStart =
  | { state: "started"; runId: string; requestedAt: Date; tokens: Map<string, string> }
  | { state: "too_soon"; retryAt: Date };

export interface DrillStartInput {
  kinds: readonly AlertKind[];
  drivers: readonly AlertDriver[];
  /** The API host's usable sinks, by name; empty records the API driver `unarmed`. */
  apiSinkNames: readonly string[];
  ackBase: string;
  now: Date;
}

const asDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

/** One row as a run or a claim writes it: every column but `acked_at`. */
interface DrillRow {
  runId: string;
  kind: string;
  driver: AlertDriver;
  sink: string;
  ackBase: string | null;
  requestedAt: Date;
  firedAt?: Date | null;
  outcome?: DrillOutcome | null;
  ackTokenHash?: string | null;
}

/**
 * The inserts name their nine columns: the staff role holds INSERT on those and not on `acked_at`,
 * and a query-builder insert lists every column. ISO strings, cast, for postgres-js's binding.
 */
async function insertRows(tx: Tx, rows: readonly DrillRow[]): Promise<void> {
  if (rows.length === 0) return;
  const values = rows.map((r) => sql`(${r.runId}::uuid, ${r.kind}::text, ${r.driver}::text, ${r.sink}::text,
    ${r.ackBase}::text, ${r.requestedAt.toISOString()}::timestamptz, ${r.firedAt ? r.firedAt.toISOString() : null}::timestamptz,
    ${r.outcome ?? null}::text, ${r.ackTokenHash ?? null}::text)`);
  await tx.execute(sql`insert into ${alertDrills}
    (run_id, kind, driver, sink, ack_base, requested_at, fired_at, outcome, ack_token_hash)
    values ${sql.join(values, sql`, `)}`);
}

/**
 * Start a run, in one transaction under the throttle's lock: refused when any run was requested in
 * the last hour. Writes the worker's queued requests (`fired_at` NULL) and the API driver's rows,
 * one per kind and sink with that sink's fresh token hashed, `fired_at` now. The tokens are
 * returned for delivery and never stored.
 */
export async function startDrillRun(db: Tx, input: DrillStartInput): Promise<DrillStart> {
  const { kinds, now } = input;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ALERT_DRILL_LOCK_CLASS}::int4, 0)`);
    const [last] = await tx.select({ at: max(alertDrills.requestedAt) }).from(alertDrills);
    if (last?.at) {
      const lastAt = asDate(last.at as Date | string).getTime();
      if (now.getTime() - lastAt < DRILL_MIN_INTERVAL_MS) {
        return { state: "too_soon" as const, retryAt: new Date(lastAt + DRILL_MIN_INTERVAL_MS) };
      }
    }
    const runId = randomUUID();
    const tokens = new Map<string, string>();
    const rows: DrillRow[] = [];
    const base = { runId, ackBase: input.ackBase, requestedAt: now };
    if (input.drivers.includes("worker")) {
      for (const kind of kinds) rows.push({ ...base, kind, driver: "worker", sink: NO_SINK });
    }
    if (input.drivers.includes("api")) {
      const sinks = [...new Set(input.apiSinkNames)];
      if (sinks.length === 0) {
        for (const kind of kinds) rows.push({ ...base, kind, driver: "api", sink: NO_SINK, firedAt: now, outcome: "unarmed" });
      }
      for (const sink of sinks) {
        const token = newToken();
        tokens.set(sink, token);
        const ackTokenHash = hashOf(token);
        for (const kind of kinds) rows.push({ ...base, kind, driver: "api", sink, firedAt: now, ackTokenHash });
      }
    }
    await insertRows(tx, rows);
    return { state: "started" as const, runId, requestedAt: now, tokens };
  });
}

export interface DrillDelivery {
  runId: string;
  kinds: readonly AlertKind[];
  /** Each sink's token, by name; a sink without one gets no link. */
  tokens: ReadonlyMap<string, string>;
  ackBase: string | null;
  source: AlertDriver;
  environment: string;
  now: Date;
}

/** One `deliver()` call, so each sink is handed one message carrying its own token. No database. */
export function deliverDrill(sinks: readonly AlertSink[], d: DrillDelivery): Promise<DeliveryReport> {
  return deliver(sinks, (sink) => {
    const token = d.tokens.get(sink.name);
    return drillAlerts(d.runId, d.kinds, d.ackBase && token ? drillAckUrl(d.ackBase, token) : null);
  }, { source: d.source, environment: drillEnvironment(d.environment), now: d.now });
}

/** Each sink's closed outcome code onto its rows, once. A sink's error text is never stored. */
export async function recordDrillOutcomes(
  db: Tx, runId: string, driver: AlertDriver, outcomes: readonly SinkOutcome[],
): Promise<void> {
  for (const o of outcomes) {
    if (!(DRILL_OUTCOMES as readonly string[]).includes(o.outcome)) continue;
    await db.update(alertDrills).set({ outcome: o.outcome })
      .where(and(
        eq(alertDrills.runId, runId), eq(alertDrills.driver, driver), eq(alertDrills.sink, o.sink),
        isNull(alertDrills.outcome),
      ));
  }
}

export type QueuedDrill =
  | { state: "none" }
  | { state: "expired" | "unarmed"; runId: string; kinds: AlertKind[] }
  | { state: "claimed"; runId: string; kinds: AlertKind[]; tokens: Map<string, string>; ackBase: string | null };

/**
 * The worker driver's half: claim the oldest queued run, in one transaction. The claim is one
 * UPDATE guarded on `fired_at IS NULL`, so a second worker waiting on the same rows finds nothing.
 * A request past its hour is stamped `expired`; with no usable sink, `unarmed`; otherwise the
 * per-sink rows are written with fresh tokens, the API's ack base copied once it is checked.
 */
export async function takeQueuedDrill(
  db: Tx, input: { sinkNames: readonly string[]; now: Date },
): Promise<QueuedDrill> {
  const { now } = input;
  const queued = and(eq(alertDrills.driver, "worker"), eq(alertDrills.sink, NO_SINK), isNull(alertDrills.firedAt));
  return db.transaction(async (tx) => {
    const oldest = tx.select({ runId: alertDrills.runId }).from(alertDrills).where(queued)
      .orderBy(asc(alertDrills.requestedAt)).limit(1);
    const claimed = await tx.update(alertDrills).set({ firedAt: now, outcome: "dispatched" })
      .where(and(queued, inArray(alertDrills.runId, oldest)))
      .returning({
        runId: alertDrills.runId, kind: alertDrills.kind, requestedAt: alertDrills.requestedAt,
        ackBase: alertDrills.ackBase,
      });
    if (claimed.length === 0) return { state: "none" as const };
    const runId = claimed[0]!.runId;
    const kinds = claimed.map((r) => r.kind as AlertKind).sort();
    const requestedAt = Math.min(...claimed.map((r) => asDate(r.requestedAt as Date | string).getTime()));
    const request = and(eq(alertDrills.runId, runId), eq(alertDrills.driver, "worker"), eq(alertDrills.sink, NO_SINK));
    if (now.getTime() - requestedAt > DRILL_REQUEST_TTL_MS) {
      await tx.update(alertDrills).set({ outcome: "expired" }).where(request);
      return { state: "expired" as const, runId, kinds };
    }
    const sinks = [...new Set(input.sinkNames)];
    if (sinks.length === 0) {
      await tx.update(alertDrills).set({ outcome: "unarmed" }).where(request);
      return { state: "unarmed" as const, runId, kinds };
    }
    const ackBase = usableAckBase(claimed[0]!.ackBase);
    const tokens = new Map<string, string>();
    const rows: DrillRow[] = [];
    for (const sink of sinks) {
      const token = ackBase ? newToken() : null;
      if (token) tokens.set(sink, token);
      for (const kind of kinds) {
        rows.push({
          runId, kind, driver: "worker", sink, ackBase, requestedAt: new Date(requestedAt), firedAt: now,
          ackTokenHash: token ? hashOf(token) : null,
        });
      }
    }
    await insertRows(tx, rows);
    return { state: "claimed" as const, runId, kinds, tokens, ackBase };
  });
}

export type DrillAckState =
  | { state: "unknown" }
  | {
    state: "open" | "acked" | "expired";
    runId: string; driver: string; sink: string; kinds: number; firedAt: Date; ackedAt: Date | null;
  };

/** What a token's message is, for the ack page. Reads only. */
export async function drillAckState(db: Tx, token: string, now: Date): Promise<DrillAckState> {
  if (!isDrillToken(token)) return { state: "unknown" };
  const found = await db.select({
    runId: alertDrills.runId, driver: alertDrills.driver, sink: alertDrills.sink,
    firedAt: alertDrills.firedAt, ackedAt: alertDrills.ackedAt,
  }).from(alertDrills).where(eq(alertDrills.ackTokenHash, hashOf(token)));
  const first = found[0];
  if (!first || !first.firedAt) return { state: "unknown" };
  const firedAt = asDate(first.firedAt as Date | string);
  const acked = found.filter((r) => r.ackedAt !== null).map((r) => asDate(r.ackedAt as Date | string).getTime());
  const ackedAt = acked.length > 0 ? new Date(Math.min(...acked)) : null;
  const state = ackedAt ? "acked" : now.getTime() - firedAt.getTime() >= DRILL_ACK_TTL_MS ? "expired" : "open";
  return { state, runId: first.runId, driver: first.driver, sink: first.sink, kinds: found.length, firedAt, ackedAt };
}

/**
 * Acknowledge the message a token was sent in: one statement stamps every row it covers, once,
 * within {@link DRILL_ACK_TTL_MS} of its delivery. Answers how many rows it stamped.
 */
export async function ackDrill(db: Tx, token: string, now: Date): Promise<number> {
  if (!isDrillToken(token)) return 0;
  const stamped = await db.update(alertDrills).set({ ackedAt: now })
    .where(and(
      eq(alertDrills.ackTokenHash, hashOf(token)),
      isNull(alertDrills.ackedAt),
      gt(alertDrills.firedAt, new Date(now.getTime() - DRILL_ACK_TTL_MS)),
    ))
    .returning({ kind: alertDrills.kind });
  return stamped.length;
}

export interface DrillMessageSummary {
  driver: string;
  sink: string;
  kinds: number;
  firedAt: string | null;
  /** The message's code; `mixed` if its rows disagree, which no writer here produces. */
  outcome: string | null;
  ackedAt: string | null;
}

export interface DrillRunSummary {
  runId: string;
  requestedAt: string;
  kinds: number;
  messages: DrillMessageSummary[];
}

const isoOf = (v: Date | string | null): string | null => (v === null ? null : asDate(v).toISOString());

/** The last `limit` runs, newest first, one entry per (driver, sink). No hash, no ack base. */
export async function listDrillRuns(db: Tx, limit: number): Promise<DrillRunSummary[]> {
  const runs = await db.select({ runId: alertDrills.runId, requestedAt: max(alertDrills.requestedAt) })
    .from(alertDrills).groupBy(alertDrills.runId)
    .orderBy(desc(max(alertDrills.requestedAt)), asc(alertDrills.runId)).limit(Math.max(1, Math.min(limit, 20)));
  if (runs.length === 0) return [];
  const rows = await db.select({
    runId: alertDrills.runId, kind: alertDrills.kind, driver: alertDrills.driver, sink: alertDrills.sink,
    firedAt: alertDrills.firedAt, outcome: alertDrills.outcome, ackedAt: alertDrills.ackedAt,
  }).from(alertDrills).where(inArray(alertDrills.runId, runs.map((r) => r.runId)))
    .orderBy(asc(alertDrills.driver), asc(alertDrills.sink), asc(alertDrills.kind));
  return runs.map((run) => {
    const own = rows.filter((r) => r.runId === run.runId);
    const groups = new Map<string, typeof own>();
    for (const r of own) {
      const k = `${r.driver}/${r.sink}`;
      const g = groups.get(k);
      if (g) g.push(r);
      else groups.set(k, [r]);
    }
    const messages = [...groups.values()].map((g): DrillMessageSummary => {
      const outcomes = new Set(g.map((r) => r.outcome));
      const fired = g.map((r) => isoOf(r.firedAt as Date | string | null)).filter((v): v is string => v !== null).sort();
      const acked = g.map((r) => isoOf(r.ackedAt as Date | string | null)).filter((v): v is string => v !== null).sort();
      return {
        driver: g[0]!.driver, sink: g[0]!.sink, kinds: g.length,
        firedAt: fired.at(-1) ?? null,
        outcome: outcomes.size === 1 ? g[0]!.outcome : "mixed",
        ackedAt: acked.at(-1) ?? null,
      };
    });
    return {
      runId: run.runId, requestedAt: isoOf(run.requestedAt as Date | string)!,
      kinds: new Set(own.map((r) => r.kind)).size, messages,
    };
  });
}
