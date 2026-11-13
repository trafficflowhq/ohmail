import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { runMigrations } from "../src/admin.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { schema, alertState, alertPassRuns, workerHeartbeats } from "../src/schema.js";
import {
  runAlertPass, writeHeartbeat, refreshHeartbeat, alertDriverStatuses, listOpenAlerts, type Alert, type AlertSink,
} from "../src/alerts.js";
import { readOrganizerStanding } from "../src/organizer-cycle.js";

/**
 * THE EXTERNAL DEAD-MAN'S SWITCH — the pass driven by something that is not the worker.
 *
 * ## The outage this file is the regression test for
 *
 * On 2026-08-01 the sync worker died and stayed dead for over two hours and nothing told
 * anyone. The `worker_down` alert existed, was correct, and could not fire: `runAlertPass`
 * ran inside the worker process, and a dead process reports nothing. The only evidence of a
 * total outage was an absence — no heartbeat updates, no logs — and it was found by a human
 * noticing a mailbox said "Not synced yet".
 *
 * So the pass now runs somewhere else as well, and this file proves the three properties
 * that has to have. It is a `.pg.test.ts` and not a PGlite one because two of them are
 * concurrency claims about what Postgres does when two sessions write one row, and PGlite
 * has one session by construction — it cannot express the bug, let alone catch it.
 *
 *  1. **It fires on a dead worker and clears on a live one.** Staleness of the heartbeat ROW
 *     is the signal, and the row survives the process that wrote it.
 *  2. **Two drivers page ONCE.** The worker's own pass and the external one overlap by
 *     design — the external one exists precisely to keep running when the worker does not,
 *     which means it runs alongside it whenever the worker is fine. `alert_state`'s
 *     notify-once semantics were enforced by the assumption of a single writer; the claim
 *     is what makes them true with two.
 *  3. **The worker must not resolve what only the external pass can see.** The worker
 *     evaluates with `shards: []`, so `worker_down` is never in its firing set — and
 *     "not firing" must not be read as "fixed".
 *
 * Shard 77 throughout, so nothing here collides with `alerts.pg.test.ts` (shard 99) or with
 * the shipped shard 0 that other files assert on.
 */

const AVAILABLE = await realPgAvailable();
const NOW = new Date("2026-08-01T12:00:00.000Z");
const MIN = 60_000;
const SHARD = 77;
const KEY = `worker_down:${SHARD}`;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const plus = (ms: number): Date => new Date(NOW.getTime() + ms);

interface Spy extends AlertSink {
  /** Every batch this sink was handed, flattened to alert keys. */
  readonly keys: string[];
}

function spy(name: string, accept = true): Spy {
  const keys: string[] = [];
  return {
    name,
    keys,
    async notify(alerts: readonly Alert[]) {
      for (const a of alerts) keys.push(a.key);
      return accept;
    },
  };
}

describe.skipIf(!AVAILABLE)("the external dead-man's switch, on real Postgres", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;

  /** A leader pulse for shard 77, stamped at `at`. */
  const beat = async (at: Date): Promise<void> => {
    await writeHeartbeat(db, {
      shardIndex: SHARD, instanceId: "wkr-deadman", shards: 1, mailboxes: 2, expected: 2,
      accounts: 1, quarantined: 0, degraded: false, lastCycleAt: at, startedAt: ago(60 * MIN),
    }, at);
  };

  const rowFor = async (key: string): Promise<typeof alertState.$inferSelect | undefined> => {
    const [row] = await db.select().from(alertState).where(eq(alertState.alertKey, key));
    return row;
  };

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    // `max: 4` — the concurrency tests need two passes genuinely in flight at once. With one
    // connection they would serialise in the driver and the test would pass without ever
    // exercising the row lock that is the thing under test.
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 60_000);

  beforeEach(async () => {
    await db.delete(alertState);
    await db.delete(alertPassRuns);
  });

  it("a live heartbeat is quiet, a STALE one pages, and a restored one resolves", async () => {
    await beat(NOW);
    const quiet = await runAlertPass(db, { now: NOW, shards: [SHARD], sinks: [spy("quiet")] });
    expect(quiet.firing.map((a) => a.key)).not.toContain(KEY);

    // The worker dies. Nothing announces it — the row simply stops advancing, which is
    // exactly what a `Crashed` Railway service looks like from the database.
    const dead = spy("pager");
    const outage = await runAlertPass(db, {
      now: plus(10 * MIN), shards: [SHARD], sinks: [dead], source: "api",
    });

    expect(outage.firing.map((a) => a.key)).toContain(KEY);
    expect(outage.notified.map((a) => a.key)).toContain(KEY);
    expect(dead.keys, "the alert has to reach a sink, not merely be computed").toContain(KEY);
    expect(outage.delivered).toContain("pager");

    const opened = await rowFor(KEY);
    expect(opened!.notifiedAt).not.toBeNull();
    expect(opened!.notifyCount).toBe(1);
    // The "Account isolation is absolute, and it binds staff too" invariant — heartbeat and alert metadata only. An operator page carries an age and a
    // rule name and can never carry an address, a subject or a body.
    expect(opened!.detail).toContain("No mailbox is syncing");
    expect(opened!.detail).toContain("wkr-deadman");

    // A standby takes over and starts beating again.
    await beat(plus(10 * MIN));
    const recovered = await runAlertPass(db, {
      now: plus(10 * MIN + 1000), shards: [SHARD], sinks: [spy("after")],
    });
    expect(recovered.resolved).toContain(KEY);
    // ── THE CLAIM THIS ASSERTION CARRIED HAS BEEN SUPERSEDED, DELIBERATELY ─────────────
    //
    // It read "alert_state is what is wrong NOW, never a graveyard", and that sentence was the
    // argument for resolving by DELETE. The argument lost to a defect it could not see: an
    // INSERT cannot be fenced against a row that is not there, so an older pass paused before
    // its observation write arrived at an empty table and recreated — and paged — an incident a
    // newer pass had just resolved. The row now survives its own resolution so the fence has
    // something to stand on, and the graveyard is bounded by count.
    //
    // The property is unchanged where it matters and is now asserted where it is true: nothing
    // is OPEN. That is what every reader means by this table, and `selectOpenAlerts` is the only
    // way any of them reads it.
    const after = await rowFor(KEY);
    expect(after, "the row survives, as evidence for the fence").toBeTruthy();
    expect(after!.resolvedAt, "marked resolved, not open").not.toBeNull();
    // SCOPED TO THIS KEY, because this suite shares one Postgres with every other pg file and
    // other rules are legitimately open in it. Asserting the whole table is empty would be a
    // claim about other tests' fixtures, which is how a green here would start depending on
    // execution order.
    expect((await listOpenAlerts(db)).map((a) => a.alertKey), "and this key is not open")
      .not.toContain(KEY);
  });

  /**
   * WHAT A SIGNED-IN APP IS TOLD, FROM THE SAME ROW AND THE SAME TWO CLOCKS AS THE PAGER. On 12
   * November 2026 the worker was gone for 26 hours; this alert fired and every app still read
   * "Connected · Synced". True in both directions: behind when the pulse or the passes stop, and back
   * only once a pass has finished again.
   */
  it("the apps' signal: behind when the pulse or the passes stop, since the last finished pass, and back when one finishes", async () => {
    const HOUR = 60 * MIN;
    const iso = (d: Date): string => d.toISOString();
    const pulse = { shardIndex: SHARD, shards: 1, mailboxes: 2, expected: 2, accounts: 1, quarantined: 0, degraded: false, aiCircuitOpenSince: null };
    // The read is the newest across shards: nothing else may stand beside this shard's row.
    await db.delete(workerHeartbeats);
    expect(await readOrganizerStanding(db, NOW)).toEqual({ lastCycleAt: null, behind: true, since: null });

    // A leader's first start: no pass yet, measured from its start, so it is given its first passes.
    await writeHeartbeat(db, { ...pulse, instanceId: "wkr-first", lastCycleAt: null, startedAt: ago(MIN) }, NOW);
    expect(await readOrganizerStanding(db, NOW)).toEqual({ lastCycleAt: null, behind: false, since: null });
    // …then a pass finishes, and passes keep finishing.
    const lastPass = plus(MIN);
    await writeHeartbeat(db, { ...pulse, instanceId: "wkr-first", lastCycleAt: lastPass, startedAt: ago(MIN) }, lastPass);
    expect(await readOrganizerStanding(db, plus(2 * MIN))).toEqual({ lastCycleAt: iso(lastPass), behind: false, since: iso(lastPass) });

    // The pulse stops (the worker is gone, or waits for its database): two minutes of grace, then behind.
    expect((await readOrganizerStanding(db, plus(3 * MIN))).behind).toBe(false);
    expect(await readOrganizerStanding(db, plus(3 * MIN + 1))).toEqual({ lastCycleAt: iso(lastPass), behind: true, since: iso(lastPass) });

    // A long pass in flight is not a stall: the pulse is fresh and the last pass finished 16 minutes
    // ago (a pass gives every mailbox a turn, and a backlog makes it long while new mail still lands).
    await refreshHeartbeat(db, { ...pulse, instanceId: "wkr-first", lastCycleAt: lastPass }, plus(17 * MIN));
    expect(await readOrganizerStanding(db, plus(17 * MIN))).toEqual({ lastCycleAt: iso(lastPass), behind: false, since: iso(lastPass) });
    // Alive and doing no work: the pulse is fresh and no pass has finished for half an hour, the
    // age at which the pager calls a mailbox lagging.
    await refreshHeartbeat(db, { ...pulse, instanceId: "wkr-first", lastCycleAt: lastPass }, plus(31 * MIN));
    expect((await readOrganizerStanding(db, plus(31 * MIN))).behind).toBe(false);
    await refreshHeartbeat(db, { ...pulse, instanceId: "wkr-first", lastCycleAt: lastPass }, plus(31 * MIN + 1));
    expect(await readOrganizerStanding(db, plus(31 * MIN + 1))).toEqual({ lastCycleAt: iso(lastPass), behind: true, since: iso(lastPass) });

    // The worker returns 26 hours later. Its first pulses know no pass of their own; the row keeps the
    // last one that finished, so "nothing fetched since" stays true while it catches up.
    const back = plus(26 * HOUR);
    await writeHeartbeat(db, { ...pulse, instanceId: "wkr-back", lastCycleAt: null, startedAt: back }, back);
    await refreshHeartbeat(db, { ...pulse, instanceId: "wkr-back", lastCycleAt: null }, new Date(back.getTime() + 10_000));
    expect(await readOrganizerStanding(db, new Date(back.getTime() + 10_000)))
      .toEqual({ lastCycleAt: iso(lastPass), behind: true, since: iso(lastPass) });

    // …and back: its first finished pass.
    const firstPass = new Date(back.getTime() + MIN);
    await writeHeartbeat(db, { ...pulse, instanceId: "wkr-back", lastCycleAt: firstPass, startedAt: back }, firstPass);
    expect(await readOrganizerStanding(db, firstPass)).toEqual({ lastCycleAt: iso(firstPass), behind: false, since: iso(firstPass) });
  });

  it("TWO DRIVERS, ONE PAGE — a pass cannot notify while another is still delivering", async () => {
    await beat(ago(10 * MIN));

    // The interleaving that produces a duplicate page in production, made deterministic:
    // the worker's pass has claimed and is inside its webhook POST when the external pass
    // starts. Under the old read-then-stamp bookkeeping the external pass read
    // `notified_at IS NULL` — the worker had not stamped yet — and paged the same fault a
    // second time, from a second host, with a different `source`.
    const firstKeys: string[] = [];
    let entered!: () => void;
    const inDelivery = new Promise<void>((r) => { entered = r; });
    let release!: (ok: boolean) => void;
    const gate = new Promise<boolean>((r) => { release = r; });
    const slowWebhook: AlertSink = {
      name: "slow-webhook",
      notify(alerts) {
        for (const a of alerts) firstKeys.push(a.key);
        entered();
        return gate;
      },
    };

    const blocked = runAlertPass(db, {
      now: NOW, shards: [SHARD], sinks: [slowWebhook], source: "worker",
    });
    await inDelivery;

    const external = spy("external-webhook");
    const second = await runAlertPass(db, {
      now: NOW, shards: [SHARD], sinks: [external], source: "api",
    });

    expect(second.firing.map((a) => a.key), "the fault is still true").toContain(KEY);
    expect(second.notified.map((a) => a.key)).not.toContain(KEY);
    expect(external.keys, "the second driver must not page a fault already being paged").toEqual([]);

    release(true);
    const first = await blocked;
    expect(first.notified.map((a) => a.key)).toContain(KEY);
    expect(firstKeys).toContain(KEY);

    const row = await rowFor(KEY);
    expect(row!.notifyCount, "exactly one page for one fault").toBe(1);
    expect(new Date(row!.notifiedAt!).getTime()).toBe(NOW.getTime());
  });

  it("two passes launched at the same instant claim through the ROW LOCK, not through luck", async () => {
    await beat(ago(10 * MIN));
    const a = spy("a");
    const b = spy("b");

    const [ra, rb] = await Promise.all([
      runAlertPass(db, { now: NOW, shards: [SHARD], sinks: [a], source: "worker" }),
      runAlertPass(db, { now: NOW, shards: [SHARD], sinks: [b], source: "api" }),
    ]);

    const notified = [...ra.notified, ...rb.notified].filter((x) => x.key === KEY);
    expect(notified, "one fault, one notification, whichever driver won").toHaveLength(1);
    expect([...a.keys, ...b.keys].filter((k) => k === KEY)).toHaveLength(1);
    expect((await rowFor(KEY))!.notifyCount).toBe(1);
  });

  it("A PASS KILLED MID-DELIVERY does not swallow the page — the claim is a LEASE", async () => {
    await beat(ago(10 * MIN));
    const TTL = 30_000;

    // The Vercel function hits `maxDuration`, or the worker is SIGKILLed, while `deliver` is
    // waiting on a webhook. Nothing confirms and nothing releases. If the claim were a plain
    // stamp, this alert would look notified for the full one-hour repeat interval having
    // reached nobody — the failure this entire slice exists to remove, reproduced inside it.
    let entered!: () => void;
    const inDelivery = new Promise<void>((r) => { entered = r; });
    let abandonRelease!: (ok: boolean) => void;
    const abandoned: AlertSink = {
      name: "killed",
      notify: () => {
        entered();
        return new Promise<boolean>((r) => { abandonRelease = r; });
      },
    };
    const killed = runAlertPass(db, {
      now: NOW, shards: [SHARD], sinks: [abandoned], claimTtlMs: TTL,
    });
    await inDelivery;

    // INSIDE the lease, a second driver still must not double-page.
    const during = spy("during");
    const inside = await runAlertPass(db, {
      now: plus(TTL - 1000), shards: [SHARD], sinks: [during], claimTtlMs: TTL,
    });
    expect(inside.notified.map((x) => x.key)).not.toContain(KEY);
    expect(during.keys).toEqual([]);

    // AFTER it, the page nobody received is retried.
    const retry = spy("retry");
    const after = await runAlertPass(db, {
      now: plus(TTL + 1000), shards: [SHARD], sinks: [retry], claimTtlMs: TTL,
    });
    expect(after.notified.map((x) => x.key)).toContain(KEY);
    expect(retry.keys, "a lease that expired must page again, not stay silent").toContain(KEY);
    const confirmed = await rowFor(KEY);
    expect(new Date(confirmed!.notifiedAt!).getTime()).toBe(plus(TTL + 1000).getTime());

    // Now let the killed pass finally come back with a delivery failure. Its release is
    // guarded by the lease value it wrote, which no longer exists, so it must not be able to
    // undo the notification a LATER pass confirmed.
    abandonRelease(false);
    await killed;
    const settled = await rowFor(KEY);
    expect(
      new Date(settled!.notifiedAt!).getTime(),
      "a late pass must only ever be able to undo its OWN claim",
    ).toBe(plus(TTL + 1000).getTime());
    expect(settled!.notifyCount).toBe(1);
  });

  it("the WORKER's pass must not RESOLVE the one rule it refuses to evaluate", async () => {
    await beat(ago(10 * MIN));
    const external = spy("external");
    const opened = await runAlertPass(db, {
      now: NOW, shards: [SHARD], sinks: [external], source: "api",
    });
    expect(opened.notified.map((a) => a.key)).toContain(KEY);

    // The worker's pass, verbatim from `apps/worker/src/index.ts`: `shards: []`, because a
    // process reporting that it is alive is not evidence of anything. `worker_down` is
    // therefore never in its firing set — and an unscoped resolve would read that as "fixed"
    // and DELETE the row the external observer just opened.
    const workerSink = spy("worker");
    const worker = await runAlertPass(db, {
      now: plus(MIN), shards: [], sinks: [workerSink], source: "worker",
    });
    expect(worker.resolved).not.toContain(KEY);

    const survived = await rowFor(KEY);
    expect(survived, "the worker deleting this row is what makes worker_down flap").toBeDefined();
    expect(
      new Date(survived!.openedAt).getTime(),
      "opened_at answers 'how long has this been broken' and must survive every other pass",
    ).toBe(NOW.getTime());

    // The payoff: because the row survived, the next external pass sees an alert that has
    // already been paged. Without the scoping it would re-open with `notified_at` NULL and
    // page again — every two minutes, for as long as the worker stays dead.
    const again = spy("again");
    const third = await runAlertPass(db, {
      now: plus(2 * MIN), shards: [SHARD], sinks: [again], source: "api",
    });
    expect(third.firing.map((a) => a.key)).toContain(KEY);
    expect(third.notified.map((a) => a.key)).not.toContain(KEY);
    // Scoped for the same reason as above: `again.keys` can legitimately carry another rule's
    // key from a fixture this file did not seed. The property is about THIS key.
    expect(again.keys, "a dead worker is one page per repeat interval, not one per pass")
      .not.toContain(KEY);
    expect((await rowFor(KEY))!.notifyCount).toBe(1);
  });

  /**
   * `alert_pass_runs` (cloud 0030) — the upsert PGlite cannot prove.
   *
   * The write is `.insert(alertPassRuns).values(...).onConflictDoUpdate({ target: driver, ... })`,
   * and the one property worth a real Postgres session is that `ON CONFLICT DO UPDATE` really is
   * an UPDATE and not a second row: PGlite has one connection by construction and cannot show two
   * concurrent inserts racing the same constraint, which is exactly the shape of two drivers'
   * passes landing at once.
   */
  it("two drivers' passes land in TWO rows, keyed by their own name — no cross-talk", async () => {
    await beat(ago(10 * MIN));
    const [worker, api] = await Promise.all([
      runAlertPass(db, { now: NOW, shards: [SHARD], sinks: [spy("w")], driver: "worker" }),
      runAlertPass(db, { now: NOW, shards: [SHARD], sinks: [spy("a")], driver: "api" }),
    ]);
    void worker; void api;

    const rows = await db.select().from(alertPassRuns);
    expect(rows.map((r) => r.driver).sort()).toEqual(["api", "worker"]);
    // Each row is its OWN write, not a shared one clobbered by the other's values — the PK is
    // the driver word, so a bug here would show as one row, not two.
    for (const r of rows) expect(new Date(r.ranAt).getTime()).toBe(NOW.getTime());

    const statuses = await alertDriverStatuses(db);
    expect(statuses.map((s) => s.driver)).toEqual(["worker", "api"]);
    expect(statuses.every((s) => s.ranAt !== null)).toBe(true);
  });

  it("a SECOND pass from the SAME driver UPSERTS its row — one row per driver, ever", async () => {
    await beat(ago(10 * MIN));
    await runAlertPass(db, { now: NOW, shards: [SHARD], sinks: [spy("first")], driver: "worker" });
    // A later pass, different counts, same driver: this must UPDATE the one row, not insert a
    // second one under the same primary key (which real Postgres would refuse outright if the
    // code ever regressed to a bare `.insert` without `onConflictDoUpdate`).
    await runAlertPass(db, {
      now: plus(MIN), shards: [SHARD], sinks: [spy("second"), spy("third")], driver: "worker",
    });

    const rows = await db.select().from(alertPassRuns).where(eq(alertPassRuns.driver, "worker"));
    expect(rows, "one row per driver, by construction of the PK").toHaveLength(1);
    expect(new Date(rows[0]!.ranAt).getTime(), "the row reflects the LATEST pass").toBe(
      plus(MIN).getTime(),
    );
  });
});
