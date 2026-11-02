import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { inArray, like, or } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { runMigrations } from "../src/admin.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { schema, alertState, workerHeartbeats } from "../src/schema.js";
import { runAlertPass, writeHeartbeat, type PostJson } from "../src/alerts.js";
import { resendAlertSink } from "../src/alert-mail.js";

/**
 * TWO DRIVERS, TWO KEYS OF ONE PAGE KIND, ONE MAIL. The worker and the API host each see a
 * different dead shard (`worker_down:61`, `worker_down:62`) at the same instant; the kind's mail
 * window is one row, and the row lock is what makes one of them hold. PGlite has one session and
 * cannot express this. The race is forced, not hoped for: an outside transaction holds the
 * policy row while both passes start, then lets go.
 */

const AVAILABLE = await realPgAvailable();
const NOW = new Date("2026-12-01T12:00:00.000Z");
const MIN = 60_000;
const SHARDS = [61, 62] as const;
const POLICY_KEY = "mail:worker_down";

describe.skipIf(!AVAILABLE)("the mail window under two drivers, on real Postgres", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 5, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 60_000);

  const cleanup = async (): Promise<void> => {
    await db.delete(alertState).where(or(
      inArray(alertState.alertKey, SHARDS.map((s) => `worker_down:${s}`)), like(alertState.alertKey, "mail:%"),
    ));
    await db.delete(workerHeartbeats).where(inArray(workerHeartbeats.shardIndex, [...SHARDS]));
  };
  afterEach(cleanup);
  afterAll(async () => { await cleanup(); await sql?.end(); });

  /** A mail arm whose POSTs are recorded; only the two shards' firing pages are counted. */
  function arm(): { sink: NonNullable<ReturnType<typeof resendAlertSink>>; pages: () => number } {
    const bodies: string[] = [];
    const post: PostJson = async (_u, body) => { bodies.push(body); return { status: 200 }; };
    const sink = resendAlertSink({ apiKey: "alert-sink-race-key-fixture-token", from: "a@ohmail.example", to: "o@ohmail.example" }, post)!;
    // A page names the shard in its body; the digest (also posted once) is a different subject.
    const firing = (b: string): boolean => / alerts? firing"/.test(b) && /shard 6[12]\b/.test(b);
    return { sink, pages: () => bodies.filter(firing).length };
  }

  async function race(order: "worker-first" | "api-first"): Promise<{ worker: number; api: number }> {
    await cleanup();
    for (const shard of SHARDS) {
      await writeHeartbeat(db, {
        shardIndex: shard, instanceId: `wkr-race-${shard}`, shards: 1, mailboxes: 1, expected: 1,
        accounts: 1, quarantined: 0, degraded: false, aiCircuitOpenSince: null,
        lastCycleAt: new Date(NOW.getTime() - 10 * MIN),
        startedAt: new Date(NOW.getTime() - 60 * MIN),
      }, new Date(NOW.getTime() - 10 * MIN));
    }
    // The window's row, born resolved, exactly as a pass makes it; then held from outside.
    await db.insert(alertState).values({
      alertKey: POLICY_KEY, kind: "mail_policy", severity: "warning", cls: "signal",
      resolvedAt: new Date(0), notifyCount: 0,
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const locked = new Promise<void>((r) => { held = r; });
    const holder = sql.begin(async (tx) => {
      await tx`select 1 from alert_state where alert_key = ${POLICY_KEY} for update`;
      held();
      await gate;
    });
    await locked;

    const worker = arm();
    const api = arm();
    const runWorker = () => runAlertPass(db, { now: NOW, shards: [SHARDS[0]], sinks: [worker.sink], source: "worker" });
    const runApi = () => runAlertPass(db, { now: NOW, shards: [SHARDS[1]], sinks: [api.sink], source: "api" });
    const passes = order === "worker-first" ? Promise.all([runWorker(), runApi()]) : Promise.all([runApi(), runWorker()]);
    // Long enough for both passes to reach the policy row; then the outside lock goes.
    await new Promise((r) => setTimeout(r, 750));
    release();
    await holder;
    const results = await passes;
    const firing = results.flatMap((r) => r.firing.map((a) => a.key)).filter((k) => k.startsWith("worker_down:6"));
    expect(firing.sort(), "the control: both drivers saw their own dead shard").toEqual(["worker_down:61", "worker_down:62"]);
    return { worker: worker.pages(), api: api.pages() };
  }

  it("worker first: exactly one POST between the two drivers", async () => {
    const r = await race("worker-first");
    expect(r.worker + r.api).toBe(1);
  });

  it("api first: exactly one POST between the two drivers", async () => {
    const r = await race("api-first");
    expect(r.worker + r.api).toBe(1);
  });
});
