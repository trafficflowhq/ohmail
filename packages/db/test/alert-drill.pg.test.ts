import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { runMigrations } from "../src/admin.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { schema } from "../src/schema.js";
import {
  alertDrills, drillKinds, startDrillRun, takeQueuedDrill, ALERT_DRILL_LOCK_CLASS,
} from "../src/cloud.js";
import { ACK_BASE, MIN, REAL_KEY, cleanup, pagedThenDrill, unpagedThenDrill } from "./_alert-drill-scenario.js";

/**
 * ALERT DRILLS on real Postgres: risk 3 on the store production runs, and the two races PGlite's
 * single session cannot express — two workers claiming one queued run, and two runs started at
 * once. Each race is forced: an outside transaction holds what both contenders need until both
 * are waiting on it, then lets go.
 */

const AVAILABLE = await realPgAvailable();
const NOW = new Date("2026-12-01T12:00:00.000Z");
const at = (ms: number): Date => new Date(NOW.getTime() + ms);

describe.skipIf(!AVAILABLE)("alert drills on real Postgres", () => {
  let sql: ReturnType<typeof postgres>;
  let probe: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 6, onnotice: () => {} });
    probe = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 120_000);

  afterEach(async () => { await cleanup(db); });
  afterAll(async () => {
    if (db) await cleanup(db);
    await sql?.end({ timeout: 5 }).catch(() => {});
    await probe?.end({ timeout: 5 }).catch(() => {});
  });

  /** Sessions of this database waiting on a lock, heavyweight or advisory. */
  const waiters = async (): Promise<number> => {
    const [x] = await probe`select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`;
    return Number(x!.n);
  };
  const untilWaiting = async (n: number): Promise<number> => {
    for (let i = 0; i < 250 && (await waiters()) < n; i++) await new Promise((r) => setTimeout(r, 20));
    return waiters();
  };

  it("RISK 3: an unpaged real incident is mailed on the next pass after a drill; the drill leaves no trace on the pager", async () => {
    const r = await unpagedThenDrill(db, NOW);
    expect(r.first.firing.map((a) => a.key)).toContain(REAL_KEY);
    expect(r.realAfterRefusal).toBeNull();
    expect(r.windowAfterRefusal).toBeNull();
    expect(r.acceptedByDrill).toBe(1);
    expect(r.after).toBe(r.before);
    expect(r.second.notified.map((a) => a.key)).toContain(REAL_KEY);
  }, 30_000);

  it("RISK 3, the reverse: after a real page a drill is still delivered and the window does not move", async () => {
    const r = await pagedThenDrill(db, NOW);
    expect(r.windowBefore).toBe(NOW.toISOString());
    expect(r.arm.accepted.length).toBe(r.pagesBefore + 1);
    expect(r.realAfter).toBe(r.realBefore);
    expect(r.windowAfter).toBe(r.windowBefore);
  }, 30_000);

  it("two workers claim one queued run at once: one takes it, the other finds nothing", async () => {
    await cleanup(db);
    const run = await startDrillRun(db, {
      kinds: drillKinds(), drivers: ["worker"], apiSinkNames: [], ackBase: ACK_BASE, now: NOW,
    });
    if (run.state !== "started") throw new Error("not started");
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const locked = new Promise<void>((r) => { held = r; });
    const holder = sql.begin(async (tx) => {
      await tx`select 1 from alert_drills where run_id = ${run.runId} and sink = '*' for update`;
      held();
      await gate;
    });
    await locked;
    const both = Promise.allSettled([
      takeQueuedDrill(db, { sinkNames: ["mail"], now: at(MIN) }),
      takeQueuedDrill(db, { sinkNames: ["mail"], now: at(MIN) }),
    ]);
    try {
      expect(await untilWaiting(2), "both claims wait on the held rows").toBe(2);
    } finally {
      release();
      await holder;
    }
    const states = (await both).map((s) => (s.status === "fulfilled" ? s.value.state : `threw ${String((s.reason as { code?: string })?.code ?? s.reason)}`));
    expect(states.sort()).toEqual(["claimed", "none"]);
    const rows = await db.select().from(alertDrills);
    expect(rows.filter((r) => r.sink === "mail")).toHaveLength(drillKinds().length);
  }, 30_000);

  it("two runs started at once: exactly one starts, the other is told when", async () => {
    await cleanup(db);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const locked = new Promise<void>((r) => { held = r; });
    // The throttle's own lock, held from outside until both starts wait on it.
    const holder = sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${ALERT_DRILL_LOCK_CLASS}::int4, 0)`;
      held();
      await gate;
    });
    await locked;
    const start = () => startDrillRun(db, {
      kinds: ["worker_down"], drivers: ["api"], apiSinkNames: ["mail"], ackBase: ACK_BASE, now: NOW,
    });
    const both = Promise.all([start(), start()]);
    try {
      expect(await untilWaiting(2), "both starts wait on the throttle's lock").toBe(2);
    } finally {
      release();
      await holder;
    }
    const states = (await both).map((s) => s.state).sort();
    expect(states).toEqual(["started", "too_soon"]);
    const runs = await sql`select count(distinct run_id)::int as n from alert_drills`;
    expect(runs[0]!.n).toBe(1);
  }, 30_000);

  it("the table holds its ten columns and no foreign key: no account_id, no join to one", async () => {
    const cols = await sql<Array<{ c: string }>>`select column_name as c from information_schema.columns
      where table_schema = 'public' and table_name = 'alert_drills' order by column_name`;
    expect(cols.map((r) => r.c)).toEqual([
      "ack_base", "ack_token_hash", "acked_at", "driver", "fired_at", "kind", "outcome", "requested_at", "run_id", "sink",
    ]);
    const [fks] = await sql<Array<{ n: number }>>`select count(*)::int as n from pg_constraint
      where conrelid = 'public.alert_drills'::regclass and contype = 'f'`;
    expect(fks!.n).toBe(0);
  });
});
