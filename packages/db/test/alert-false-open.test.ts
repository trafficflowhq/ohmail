import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
// The SAME table objects `alerts.ts` reads, because the refusing handle matches them by identity.
import { authEvents, devices, sessions } from "../src/schema.js";
import {
  alertPassRuns, alertState, platformSignals, writeHeartbeat,
  runAlertPass, newDeliveryStreak, type AlertKind, type AlertPassOptions, type AlertSink,
} from "../src/cloud.js";
import type { PlaneOpsReading } from "../src/entitlements-port.js";
/* @reads: packages/db/src/alert-types.ts */

/**
 * EVERY KIND, BOTH WAYS AN OPEN ROW CLOSES — and never by a human.
 *
 * RESOLVE: the pass looked at the key and it did not fire, so it cleared and a notice is owed.
 * FALSE-OPEN: nothing has confirmed the row for the dark threshold, so the next pass closes it
 * with no notice owed. A row confirmed a minute ago by the other arm stays open. Imports only
 * what the base tree had, so the same file reads red there: that is the red-before.
 */
const NOW = new Date("2026-09-20T12:00:00.000Z");
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function seedLeader(db: Db): Promise<void> {
  await writeHeartbeat(db, {
    shardIndex: 0, instanceId: "wkr", shards: 1, mailboxes: 1, expected: 1, accounts: 1,
    quarantined: 0, degraded: false, aiCircuitOpenSince: null,
    lastCycleAt: ago(10 * SEC), startedAt: ago(HOUR),
  }, ago(10 * SEC));
  // Both arms recently ran, so neither driver-dark arm has anything to say.
  for (const driver of ["worker", "api"] as const) {
    await db.insert(alertPassRuns).values({
      driver, ranAt: ago(MIN), firing: 0, delivered: 0, failedSinks: 0, sinkFailureStreak: 0,
      sinksConfigured: 1,
    });
  }
}

async function seedOpen(db: Db, key: string, kind: AlertKind, seenAgo: number): Promise<void> {
  await db.insert(alertState).values({
    alertKey: key, kind, severity: "critical", openedAt: ago(4 * HOUR), lastSeenAt: ago(seenAgo),
    notifiedAt: ago(4 * HOUR), notifyCount: 2, detail: "seeded", cls: "incident",
    title: "seeded", count: 1,
  } as never);
}

async function rowOf(db: Db, key: string) {
  const [r] = await db.select({ resolvedAt: alertState.resolvedAt, notifyCount: alertState.notifyCount })
    .from(alertState).where(eq(alertState.alertKey, key));
  return r!;
}

/** One sampled bucket: the project is on the board and its window is not measured. */
async function sampledWindow(db: Db): Promise<void> {
  await db.insert(platformSignals).values({
    provider: "vercel", project: "ohmail-api", windowStart: ago(5 * MIN),
    requests: 900, errors5xx: 40, truncated: true, sampleCause: "page_budget", fetchedAt: ago(4 * MIN),
  } as never);
}

/** Three complete, healthy buckets: the window is measured and clear. */
async function measuredWindow(db: Db): Promise<void> {
  for (const m of [5, 10, 15]) {
    await db.insert(platformSignals).values({
      provider: "vercel", project: "ohmail-api", windowStart: ago(m * MIN),
      requests: 500, errors5xx: 0, truncated: false, fetchedAt: ago(m * MIN),
    } as never);
  }
}

/**
 * A handle whose reads of the named tables answer 42501, the refusal a handle the grants have
 * not reached yet raises. The builder is the real one, so it still embeds as a subquery; it
 * refuses only when it is awaited.
 */
function refusing(db: Db, tables: readonly unknown[]): Db {
  const refused = (b: object): unknown => new Proxy(b, {
    get(bt, bp) {
      if (bp === "then") {
        const err = Object.assign(new Error("permission denied"), { code: "42501" });
        return (ok: (v: unknown) => unknown, no: (e: unknown) => unknown) => Promise.reject(err).then(ok, no);
      }
      const v = Reflect.get(bt, bp);
      if (typeof v !== "function") return v;
      return (...a: unknown[]) => {
        const r = (v as (...x: unknown[]) => unknown).apply(bt, a);
        return r === bt ? refused(bt) : r;
      };
    },
  });
  return new Proxy(db, {
    get(target, prop, recv) {
      if (prop === "select") {
        return (...args: unknown[]) => {
          const b = (target.select as (...a: unknown[]) => object)(...args);
          return new Proxy(b, {
            get(bt, bp) {
              if (bp === "from") {
                return (tbl: unknown, ...rest: unknown[]) => {
                  const built = (Reflect.get(bt, "from") as (...a: unknown[]) => object).call(bt, tbl, ...rest);
                  return tables.includes(tbl) ? refused(built) : built;
                };
              }
              const v = Reflect.get(bt, bp);
              return typeof v === "function" ? v.bind(bt) : v;
            },
          });
        };
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

interface Scenario { pass: AlertPassOptions; world?: (db: Db) => Promise<void>; refuse?: readonly unknown[] }
interface KindCase {
  kind: AlertKind;
  key: string;
  /** A pass that did NOT evaluate this key, or null: every pass whose read succeeds evaluates it. */
  notEvaluated: Scenario | null;
  /** A pass that evaluated this key and found it clear. */
  evaluatedClear: Scenario;
}

const W: AlertPassOptions = { now: NOW, sinks: [], driver: "worker", shards: [] };
const A: AlertPassOptions = { now: NOW, sinks: [], driver: "api", shards: [0] };

/** A plane whose passes all ran and that has no billing alert: every plane rule reads clear. */
const healthyPlane = async (): Promise<PlaneOpsReading> => ({
  state: "read",
  answer: {
    v: 1, observedAt: NOW.toISOString(), alertsTruncated: false, alerts: [],
    passes: [{
      name: "reconcile", stale: false, severity: "warning", ageSeconds: 60, staleAfterSeconds: 21_600,
      lastDoneAt: ago(MIN).toISOString(), lastOutcome: "done", lastOutcomeAt: ago(MIN).toISOString(),
      failureStreak: 0, lastErrorClass: null, recorded: true,
    }],
  },
});

/** Every kind in the union; the first case below asserts this list IS the union. */
const KIND_CASES: readonly KindCase[] = [
  { kind: "worker_down", key: "worker_down:0", notEvaluated: { pass: W }, evaluatedClear: { pass: A } },
  { kind: "worker_degraded", key: "worker_degraded:0", notEvaluated: { pass: W }, evaluatedClear: { pass: A } },
  { kind: "ai_provider_down", key: "ai_provider_down:0", notEvaluated: { pass: W }, evaluatedClear: { pass: A } },
  { kind: "schema_behind", key: "schema_behind:api", notEvaluated: { pass: W }, evaluatedClear: { pass: A } },
  // Never written by a pass (the last-resort page writes no row); a stray one clears like schema_behind's.
  { kind: "alert_db_unreadable", key: "alert_db_unreadable:api", notEvaluated: { pass: W }, evaluatedClear: { pass: A } },
  { kind: "alert_driver_dark", key: "alert_driver_dark:worker", notEvaluated: { pass: W }, evaluatedClear: { pass: A } },
  { kind: "imap_admission_refused", key: "imap_admission_refused", notEvaluated: { pass: A }, evaluatedClear: { pass: W } },
  {
    kind: "api_5xx_rate", key: "api_5xx_rate:vercel:ohmail-api",
    notEvaluated: { pass: A, world: sampledWindow }, evaluatedClear: { pass: A, world: measuredWindow },
  },
  {
    kind: "storage_at_cap", key: "storage_at_cap",
    notEvaluated: { pass: W }, evaluatedClear: { pass: { ...W, accountsAtCap: async () => ({ atCap: [], read: 0, total: 0 }) } },
  },
  { kind: "device_sync_stale", key: "device_sync_stale:d1", notEvaluated: { pass: W, refuse: [devices] }, evaluatedClear: { pass: W } },
  { kind: "session_sync_stale", key: "session_sync_stale:s1", notEvaluated: { pass: W, refuse: [sessions] }, evaluatedClear: { pass: W } },
  { kind: "session_reuse_revoked", key: "session_reuse_revoked:a1", notEvaluated: { pass: W, refuse: [authEvents] }, evaluatedClear: { pass: W } },
  { kind: "credential_replay_wide", key: "credential_replay_wide", notEvaluated: { pass: W, refuse: [authEvents] }, evaluatedClear: { pass: W } },
  { kind: "session_refresh_replayed", key: "session_refresh_replayed:a1", notEvaluated: { pass: W, refuse: [authEvents] }, evaluatedClear: { pass: W } },
  // Read by every pass that reads at all: a refusal here fails the pass, so "not evaluated"
  // cannot happen, and the evaluation that did not confirm the row is the one that clears it.
  { kind: "sends_stuck", key: "sends_stuck", notEvaluated: null, evaluatedClear: { pass: W } },
  { kind: "sync_lag", key: "sync_lag", notEvaluated: null, evaluatedClear: { pass: W } },
  { kind: "api_fault_rate", key: "api_fault_rate:api:/auth/session", notEvaluated: null, evaluatedClear: { pass: W } },
  { kind: "pooler_refusals", key: "pooler_refusals", notEvaluated: null, evaluatedClear: { pass: W } },
  // Keyed by the OTHER driver: the worker never evaluates its own reach.
  {
    kind: "alert_driver_undeliverable", key: "alert_driver_undeliverable:worker",
    notEvaluated: { pass: W }, evaluatedClear: { pass: A },
  },
  // Absent streaks are no reader, never "every arm is fine".
  {
    kind: "alert_sink_degraded", key: "alert_sink_degraded:worker:mail",
    notEvaluated: { pass: W }, evaluatedClear: { pass: { ...W, deliveryStreak: newDeliveryStreak() } },
  },
  // `apiCron: null` is a shard > 0 or the organizer: it clears nothing of shard 0's.
  {
    kind: "api_cron_stale", key: "api_cron_stale:scheduled_send",
    notEvaluated: { pass: { ...W, apiCron: null } },
    evaluatedClear: { pass: { ...W, apiCron: { since: ago(MIN), targets: [
      { target: "scheduled_send", everySeconds: 60, lastOkAt: ago(MIN).toISOString() },
    ] } } },
  },
  { kind: "signal_source_dark", key: "signal_source_dark:vercel:ohmail-api", notEvaluated: null, evaluatedClear: { pass: W, world: measuredWindow } },
  // No reader stated is unread, never "the plane is fine"; a reader that read clears.
  {
    kind: "plane_pass_stale", key: "plane_pass_stale:reconcile",
    notEvaluated: { pass: W }, evaluatedClear: { pass: { ...W, planeOps: healthyPlane } },
  },
  {
    kind: "billing_alert", key: "billing_alert:events_failed",
    notEvaluated: { pass: W }, evaluatedClear: { pass: { ...W, planeOps: healthyPlane } },
  },
  // Keyed by the reading driver: the API arm never evaluates the worker's own failed reads.
  {
    kind: "plane_ops_unreadable", key: "plane_ops_unreadable:worker",
    notEvaluated: { pass: A }, evaluatedClear: { pass: { ...W, planeOps: healthyPlane } },
  },
];

async function passOver(c: KindCase, sc: Scenario, seenAgo: number) {
  const db = await makeTestDb();
  await seedLeader(db);
  await sc.world?.(db);
  await seedOpen(db, c.key, c.kind, seenAgo);
  const handle = sc.refuse ? refusing(db, sc.refuse) : db;
  const pass = await runAlertPass(handle, sc.pass);
  return { db, pass, row: await rowOf(db, c.key) };
}

describe("the cases cover the whole AlertKind union", () => {
  it("a kind added without a case here is a red, not a gap", () => {
    const src = readFileSync(new URL("../src/alert-types.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const union = [...src.match(/export type AlertKind =([\s\S]*?);/)![1]!.matchAll(/"([a-z0-9_]+)"/g)]
      .map((m) => m[1]!);
    expect(KIND_CASES.map((c) => c.kind).sort()).toEqual([...union].sort());
  });
});

describe("RESOLVE — a pass that evaluated the key and found it clear closes it, notice owed", () => {
  for (const c of KIND_CASES) {
    it(`${c.kind}`, async () => {
      const { pass, row } = await passOver(c, c.evaluatedClear, MIN);
      expect(pass.firing.map((a) => a.key), "the scenario is clear").not.toContain(c.key);
      expect(row.resolvedAt, "closed by the evaluation").not.toBeNull();
      expect(pass.resolved, "reported as cleared").toContain(c.key);
      expect(Number(row.notifyCount), "the resolution notice is still owed").toBe(2);
    });
  }
});

describe("FALSE-OPEN — an open row nothing confirmed for the dark threshold closes, no notice", () => {
  for (const c of KIND_CASES) {
    it(`${c.kind}`, async () => {
      const sc = c.notEvaluated ?? c.evaluatedClear;
      const { pass, row } = await passOver(c, sc, 3 * HOUR);
      expect(pass.firing.map((a) => a.key), "nothing confirmed it on this pass").not.toContain(c.key);
      expect(row.resolvedAt, "the evaluation closed it, not a human").not.toBeNull();
      if (c.notEvaluated === null) {
        // This pass looked, so the close is a true clear.
        expect(pass.resolved).toContain(c.key);
        return;
      }
      expect(Number(row.notifyCount), "nobody saw it clear, so no resolution notice is owed").toBe(0);
      expect(pass.resolved, "and it is not reported as cleared").not.toContain(c.key);
      expect((pass as { closedUnconfirmed?: string[] }).closedUnconfirmed ?? []).toContain(c.key);
    });
  }
});

describe("the other arm's LIVE row stays open — not evaluated is not cleared", () => {
  for (const c of KIND_CASES.filter((k) => k.notEvaluated !== null)) {
    it(`${c.kind}`, async () => {
      const { pass, row } = await passOver(c, c.notEvaluated!, MIN);
      expect(row.resolvedAt, "confirmed a minute ago and not looked at: still open").toBeNull();
      expect(pass.resolved).not.toContain(c.key);
    });
  }
});

describe("an unconfirmed close owes no resolution notice", () => {
  it("the notice pass past the flap floor tells nothing about it", async () => {
    const c = KIND_CASES.find((k) => k.kind === "worker_down")!;
    const { db } = await passOver(c, c.notEvaluated!, 3 * HOUR);
    const told: string[] = [];
    const sink: AlertSink = {
      name: "spy",
      notify: async () => ({ ok: true }),
      notifyResolved: async (notices) => { told.push(...notices.map((n) => n.key)); return { ok: true }; },
    } as AlertSink;
    const later = await runAlertPass(db, { ...W, now: new Date(NOW.getTime() + 2 * HOUR), sinks: [sink] });
    expect(told, "a close nobody saw is not announced as resolved").not.toContain(c.key);
    expect(later.resolutionsTold).not.toContain(c.key);
  });

  it("CONTROL: a cleared close past the flap floor IS announced", async () => {
    const c = KIND_CASES.find((k) => k.kind === "worker_down")!;
    const { db } = await passOver(c, c.evaluatedClear, MIN);
    const told: string[] = [];
    const sink: AlertSink = {
      name: "spy",
      notify: async () => ({ ok: true }),
      notifyResolved: async (notices) => { told.push(...notices.map((n) => n.key)); return { ok: true }; },
    } as AlertSink;
    // The worker arm does not evaluate shard 0, so nothing re-opens the row before the notice.
    await runAlertPass(db, { ...W, now: new Date(NOW.getTime() + 2 * HOUR), sinks: [sink] });
    expect(told).toContain(c.key);
  });
});

describe("the edges of the false-open arm", () => {
  it("a row whose kind this build does not know closes by the clock, unannounced", async () => {
    const db = await makeTestDb();
    await seedLeader(db);
    await seedOpen(db, "retired_kind:7", "retired_kind" as AlertKind, 3 * HOUR);
    const pass = await runAlertPass(db, W);
    const row = await rowOf(db, "retired_kind:7");
    expect(row.resolvedAt, "nothing here can clear it, so only the clock can").not.toBeNull();
    expect(Number(row.notifyCount)).toBe(0);
    expect(pass.resolved).not.toContain("retired_kind:7");
  });

  it("a confirmation that lands during the pass stops the close — it is re-asked under the write", async () => {
    // The other arm confirms the row between this pass's read and its write. The close must match
    // nothing: the row is confirmed now, whatever this pass read a moment ago.
    const c = KIND_CASES.find((k) => k.kind === "worker_down")!;
    const db = await makeTestDb();
    await seedLeader(db);
    await seedOpen(db, c.key, c.kind, 3 * HOUR);
    const confirmFirst = new Proxy(db, {
      get(target, prop, recv) {
        if (prop === "update") {
          return (tbl: unknown) => {
            const b = (target.update as (t: unknown) => object)(tbl);
            const wrap = (x: object): unknown => new Proxy(x, {
              get(bt, bp) {
                if (bp === "then") {
                  return (ok: (v: unknown) => unknown, no: (e: unknown) => unknown) =>
                    target.execute(sql`update alert_state set last_seen_at = ${NOW.toISOString()}::timestamptz
                      where alert_key = ${c.key}`)
                      .then(() => (Reflect.get(bt, "then") as (a: unknown, b: unknown) => unknown).call(bt, ok, no));
                }
                const v = Reflect.get(bt, bp);
                if (typeof v !== "function") return v;
                // `update().set()` returns a NEW builder, so every thenable along the chain is wrapped.
                return (...a: unknown[]) => {
                  const r = (v as (...y: unknown[]) => unknown).apply(bt, a);
                  return r !== null && typeof r === "object" && typeof (r as { then?: unknown }).then === "function"
                    ? wrap(r as object) : r;
                };
              },
            });
            return wrap(b);
          };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const pass = await runAlertPass(confirmFirst as Db, W);
    expect((await rowOf(db, c.key)).resolvedAt, "confirmed under the write: still open").toBeNull();
    expect(pass.closedUnconfirmed ?? [], "and not reported closed").not.toContain(c.key);
  });
});
