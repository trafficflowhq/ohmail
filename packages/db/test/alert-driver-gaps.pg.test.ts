import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, sql as dsql } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { runMigrations } from "../src/admin.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { schema, alertDriverGaps, alertPassRuns } from "../src/schema.js";
import {
  recordAlertPass, alertDriverStatuses, pruneAlertDriverGaps, ALERT_DRIVER_GAP_RETENTION_DAYS,
} from "../src/alerts.js";
import { STAFF_SELECT_GRANTS } from "../src/staff-grants.js";
import type { Tx } from "../src/change-log.js";

/**
 * PER-DRIVER GAP HISTORY (cloud 0048), on real Postgres: two passes of one driver overlap in
 * production (the API arm's scheduler retry, the worker's interval), and PGlite has one session,
 * so the row lock that makes the day row consistent cannot be exercised anywhere else.
 */
const AVAILABLE = await realPgAvailable();
const NOW = new Date("2026-10-17T12:00:00.000Z");
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (ms: number): Date => new Date(NOW.getTime() + ms);
const TODAY = "2026-10-17";

describe.skipIf(!AVAILABLE)("alert_driver_gaps on real Postgres", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;
  let probe: ReturnType<typeof postgres>;

  const pass = (d: Tx, driver: "worker" | "api", now: Date): Promise<void> => recordAlertPass(d, {
    driver, now, firing: 0, delivered: 0, failedSinks: 0, sinkFailureStreak: 0, sinksConfigured: 1,
  });
  const dayRow = async (driver: string, day = TODAY) => {
    const [r] = await db.select().from(alertDriverGaps)
      .where(dsql`${alertDriverGaps.driver} = ${driver} and ${alertDriverGaps.day} = ${day}::date`);
    return r;
  };
  const ranAt = async (driver: string) => {
    const [r] = await db.select({ ranAt: alertPassRuns.ranAt }).from(alertPassRuns)
      .where(eq(alertPassRuns.driver, driver));
    return r ? new Date(r.ranAt as unknown as string).toISOString() : null;
  };

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    probe = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 }).catch(() => {});
    await probe?.end({ timeout: 5 }).catch(() => {});
  });

  beforeEach(async () => {
    await db.delete(alertDriverGaps);
    await db.delete(alertPassRuns);
  });

  it("each pass counts once and the day keeps the longest gap a pass ended", async () => {
    await pass(db, "worker", at(-10 * MIN));
    await pass(db, "worker", at(-9 * MIN));
    await pass(db, "worker", at(-2 * MIN));
    await pass(db, "worker", at(-MIN));
    const r = await dayRow("worker");
    expect(r?.passes).toBe(4);
    expect(r?.maxGapS).toBe(7 * 60);
    expect(new Date(r!.maxGapAt as unknown as string).toISOString()).toBe(at(-2 * MIN).toISOString());
  });

  it("an outage of both arms is recorded by the first pass after it", async () => {
    await pass(db, "worker", at(-3 * HOUR));
    await pass(db, "api", at(-3 * HOUR));
    await pass(db, "worker", NOW);
    await pass(db, "api", at(30 * SEC));
    expect((await dayRow("worker"))?.maxGapS).toBe(3 * 3600);
    expect((await dayRow("api"))?.maxGapS).toBe(3 * 3600 + 30);
  });

  it("two OVERLAPPING passes write one consistent day row: the waiter measures from the pass it waited on", async () => {
    await pass(db, "worker", at(-10 * MIN));
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    // Pass 1 (t-5m) stamps inside an open transaction and holds the run row's lock.
    const first = db.transaction(async (tx) => {
      await pass(tx as unknown as Tx, "worker", at(-5 * MIN));
      await held;
    });
    for (let i = 0; i < 100 && !(await rowStamped()); i++) await new Promise((r) => setTimeout(r, 20));
    // Pass 2 (t-4m) starts while pass 1 is uncommitted, and must wait for it.
    const second = pass(db, "worker", at(-4 * MIN));
    for (let i = 0; i < 100 && !(await waitingOnALock()); i++) await new Promise((r) => setTimeout(r, 20));
    expect(await waitingOnALock(), "pass 2 is blocked behind pass 1").toBe(true);
    release();
    await first;
    await second;
    const r = await dayRow("worker");
    expect(r?.passes).toBe(3);
    // 300 s (t-10m → t-5m) and 60 s (t-5m → t-4m). Measured from its own snapshot, pass 2 would
    // record 360 s — a gap that never happened.
    expect(r?.maxGapS).toBe(300);
    expect(await ranAt("worker")).toBe(at(-4 * MIN).toISOString());

    async function rowStamped(): Promise<boolean> {
      const [x] = await probe`select count(*)::int as n from pg_locks l join pg_stat_activity a using (pid)
        where a.datname = current_database() and l.locktype = 'transactionid' and a.state = 'idle in transaction'`;
      return Number(x!.n) > 0;
    }
    async function waitingOnALock(): Promise<boolean> {
      const [x] = await probe`select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`;
      return Number(x!.n) > 0;
    }
  });

  it("an OLDER pass that lands after a newer one writes nothing: no rewind, no extra pass, no gap", async () => {
    await pass(db, "api", at(-10 * MIN));
    await pass(db, "api", at(-2 * MIN));
    await pass(db, "api", at(-5 * MIN));
    expect(await ranAt("api")).toBe(at(-2 * MIN).toISOString());
    const r = await dayRow("api");
    expect(r?.passes).toBe(2);
    expect(r?.maxGapS).toBe(8 * 60);
  });

  it("the 30-day measure: the largest recorded gap in the window, or the live one if longer", async () => {
    await pass(db, "worker", at(-2 * MIN));
    await pass(db, "api", at(-3 * HOUR));
    await db.insert(alertDriverGaps).values([
      // Inside the window: counts.
      { driver: "worker", day: "2026-10-07", passes: 900, maxGapS: 7200, maxGapAt: at(-10 * DAY) },
      // Outside it: a longer gap that no longer counts.
      { driver: "worker", day: "2026-09-07", passes: 900, maxGapS: 99_999, maxGapAt: at(-40 * DAY) },
      { driver: "api", day: "2026-10-12", passes: 300, maxGapS: 600, maxGapAt: at(-5 * DAY) },
    ]);
    const [worker, api] = await alertDriverStatuses(db, NOW);
    expect(worker!.longestGap30dS).toBe(7200);
    // The API arm has been silent for three hours right now, longer than anything recorded.
    expect(api!.longestGap30dS).toBe(3 * 3600);
  });

  it("an arm that never ran says unknown, not zero", async () => {
    await pass(db, "worker", at(-MIN));
    const [worker, api] = await alertDriverStatuses(db, NOW);
    expect(worker!.longestGap30dS).toBe(60);
    expect(api!.ranAt).toBeNull();
    expect(api!.longestGap30dS).toBeNull();
  });

  it(`retention: rows older than ${ALERT_DRIVER_GAP_RETENTION_DAYS} days are pruned, younger ones kept`, async () => {
    await db.insert(alertDriverGaps).values([
      { driver: "worker", day: "2026-07-08", passes: 1, maxGapS: 1, maxGapAt: at(-101 * DAY) },
      { driver: "worker", day: "2026-07-10", passes: 1, maxGapS: 1, maxGapAt: at(-99 * DAY) },
    ]);
    expect(await pruneAlertDriverGaps(db, NOW)).toBe(1);
    const days = (await db.select({ day: alertDriverGaps.day }).from(alertDriverGaps)).map((r) => r.day);
    expect(days).toEqual(["2026-07-10"]);
  });

  it("privacy: the table carries no account_id and no key into any other table", async () => {
    const cols = await probe<Array<{ column_name: string }>>`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'alert_driver_gaps' order by column_name`;
    const names = cols.map((c) => c.column_name);
    expect(names).toEqual(["day", "driver", "max_gap_at", "max_gap_s", "passes"]);
    const fks = await probe`select conname from pg_constraint
      where conrelid = 'public.alert_driver_gaps'::regclass and contype = 'f'`;
    expect(fks).toHaveLength(0);
    // The staff role reads exactly these columns, and none of them names an account.
    expect([...STAFF_SELECT_GRANTS["public.alert_driver_gaps"]!].sort()).toEqual(names);
  });
});
