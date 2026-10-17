import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import {
  alertPassRuns, alertState, platformSignals, writeHeartbeat,
  runAlertPass, type Alert, type AlertPassOptions, type AlertSink,
} from "../src/cloud.js";

/**
 * AN OPEN INCIDENT NOBODY WAS TOLD ABOUT STAYS DUE WHILE ITS RULE CANNOT LOOK AT IT.
 *
 * The 2026-09-23 `api_5xx_rate` firing opened, its first claim did not deliver, and the windows
 * after it were sampled ("not measured"), so the key never fired again and the claim loop, which
 * walked `firing` only, never asked about it again. These cases drive that shape and its edges.
 */
const NOW = new Date("2026-09-23T10:38:00.000Z");
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const at = (base: Date, ms: number): Date => new Date(base.getTime() + ms);
const KEY = "api_5xx_rate:vercel:ohmail-api";
type Db = Awaited<ReturnType<typeof makeTestDb>>;

function sink(name: string, accept: boolean, extra: Partial<AlertSink> = {}): AlertSink & { keys: string[] } {
  const keys: string[] = [];
  return {
    name, keys, ...extra,
    async notify(alerts: readonly Alert[]) { for (const a of alerts) keys.push(a.key); return accept; },
  };
}

/** A live leader and both arms run a minute ago, as of `now`: nothing else fires. */
async function alive(db: Db, now: Date): Promise<void> {
  await writeHeartbeat(db, {
    shardIndex: 0, instanceId: "wkr", shards: 1, mailboxes: 1, expected: 1, accounts: 1,
    quarantined: 0, degraded: false, aiCircuitOpenSince: null,
    lastCycleAt: at(now, -10 * SEC), startedAt: at(NOW, -HOUR),
  }, at(now, -10 * SEC));
  await db.delete(alertPassRuns);
  for (const driver of ["worker", "api"] as const) {
    await db.insert(alertPassRuns).values({
      driver, ranAt: at(now, -MIN), firing: 0, delivered: 0, failedSinks: 0, sinkFailureStreak: 0,
    });
  }
}

async function world(now: Date): Promise<Db> {
  const db = await makeTestDb();
  await alive(db, now);
  return db;
}

/** Three complete buckets ending at `now`, 60 of 1500 requests 5xx: the rule fires. */
async function failingWindow(db: Db, now: Date): Promise<void> {
  await db.delete(platformSignals);
  for (const m of [5, 10, 15]) {
    await db.insert(platformSignals).values({
      provider: "vercel", project: "ohmail-api", windowStart: at(now, -m * MIN),
      requests: 500, errors5xx: 20, truncated: false, fetchedAt: at(now, -m * MIN + MIN),
    } as never);
  }
}

/** One sampled bucket: the project is on the board and its window is NOT measured. */
async function sampledWindow(db: Db, now: Date): Promise<void> {
  await db.delete(platformSignals);
  await db.insert(platformSignals).values({
    provider: "vercel", project: "ohmail-api", windowStart: at(now, -5 * MIN),
    requests: 900, errors5xx: 40, truncated: true, sampleCause: "page_budget", fetchedAt: at(now, -4 * MIN),
  } as never);
}

async function rowOf(db: Db, key: string) {
  const [r] = await db.select().from(alertState).where(eq(alertState.alertKey, key));
  return r!;
}

const API: AlertPassOptions = { driver: "api", shards: [0], environment: "test" };

/** The 09-23 shape: pass 1 fires and its only sink refuses; pass 2 cannot measure the window. */
async function firedButUnpaged(): Promise<Db> {
  const db = await world(NOW);
  await failingWindow(db, NOW);
  const first = await runAlertPass(db, { ...API, now: NOW, sinks: [sink("down", false)] });
  expect(first.firing.map((a) => a.key)).toContain(KEY);
  const row = await rowOf(db, KEY);
  expect(Number(row.notifyCount), "the refused page left nobody told").toBe(0);
  expect(row.resolvedAt).toBeNull();
  return db;
}

describe("an unpaged open incident whose window went unmeasured is still delivered", () => {
  it("a later pass that cannot evaluate the key pages it", async () => {
    const db = await firedButUnpaged();
    const later = at(NOW, 5 * MIN);
    await sampledWindow(db, later);
    await alive(db, later);
    const pager = sink("pager", true);
    const pass = await runAlertPass(db, { ...API, now: later, sinks: [pager] });
    expect(pass.firing.map((a) => a.key), "the rule could not look").not.toContain(KEY);
    expect(pager.keys, "and the incident still reached a sink").toEqual([KEY]);
    expect(pass.notified.map((a) => a.key)).toEqual([KEY]);
    const row = await rowOf(db, KEY);
    expect(Number(row.notifyCount)).toBe(1);
    expect(row.resolvedAt, "delivered, not resolved: nobody saw it clear").toBeNull();
  });

  it("through a mail sink too: the carried page takes the kind's window", async () => {
    const db = await firedButUnpaged();
    const later = at(NOW, 5 * MIN);
    await sampledWindow(db, later);
    await alive(db, later);
    const mail = sink("mail", true, { channel: "mail" });
    await runAlertPass(db, { ...API, now: later, sinks: [mail] });
    expect(mail.keys).toEqual([KEY]);
    expect(Number((await rowOf(db, KEY)).notifyCount)).toBe(1);
  });

  it("the page carries the row's own words and says when it was last measured", async () => {
    const db = await firedButUnpaged();
    const later = at(NOW, 5 * MIN);
    await sampledWindow(db, later);
    await alive(db, later);
    const seen: Alert[] = [];
    const s: AlertSink = { name: "pager", async notify(a) { seen.push(...a); return true; } };
    await runAlertPass(db, { ...API, now: later, sinks: [s] });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.title).toBe("ohmail-api is serving 4.0% 5xx");
    expect(seen[0]!.severity).toBe("critical");
    expect(seen[0]!.detail).toMatch(/\(last measured 5m ago\)$/);
  });

  it("CONTROL: once a page was confirmed, an unevaluated pass does not page it again", async () => {
    const db = await firedButUnpaged();
    const t1 = at(NOW, 5 * MIN);
    await sampledWindow(db, t1);
    await alive(db, t1);
    await runAlertPass(db, { ...API, now: t1, sinks: [sink("pager", true)] });
    const t2 = at(NOW, 10 * MIN);
    await sampledWindow(db, t2);
    await alive(db, t2);
    const again = sink("pager", true);
    await runAlertPass(db, { ...API, now: t2, sinks: [again] });
    expect(again.keys).toEqual([]);
  });

  it("CONTROL: past the unconfirmed horizon the row closes unannounced instead of paging", async () => {
    const db = await firedButUnpaged();
    const late = at(NOW, 3 * HOUR);
    await sampledWindow(db, late);
    await alive(db, late);
    const pager = sink("pager", true);
    const pass = await runAlertPass(db, { ...API, now: late, sinks: [pager] });
    expect(pager.keys).toEqual([]);
    expect(pass.closedUnconfirmed).toContain(KEY);
  });

  it("CONTROL: a pass that measured the window and found it clear resolves, not pages", async () => {
    const db = await firedButUnpaged();
    const later = at(NOW, 20 * MIN);
    await db.delete(platformSignals);
    for (const m of [5, 10, 15]) {
      await db.insert(platformSignals).values({
        provider: "vercel", project: "ohmail-api", windowStart: at(later, -m * MIN),
        requests: 500, errors5xx: 0, truncated: false, fetchedAt: at(later, -m * MIN + MIN),
      } as never);
    }
    await alive(db, later);
    const pager = sink("pager", true);
    const pass = await runAlertPass(db, { ...API, now: later, sinks: [pager] });
    expect(pager.keys).toEqual([]);
    expect(pass.resolved).toContain(KEY);
  });

  it("CONTROL: an unpaged SIGNAL is never carried to a sink", async () => {
    const db = await world(NOW);
    await db.insert(alertState).values({
      alertKey: KEY, kind: "api_5xx_rate", severity: "warning", openedAt: at(NOW, -MIN),
      lastSeenAt: at(NOW, -MIN), notifyCount: 0, detail: "seeded", cls: "signal", title: "seeded", count: 1,
    } as never);
    await sampledWindow(db, NOW);
    const pager = sink("pager", true);
    await runAlertPass(db, { ...API, now: NOW, sinks: [pager] });
    expect(pager.keys).toEqual([]);
  });

  it("the arm that cannot evaluate a kind delivers what the other arm could not", async () => {
    // The API arm opened `worker_down:0` with no sink configured; the worker arm never evaluates
    // shards, and before this it left the row unpaged until the horizon closed it.
    const db = await world(NOW);
    await db.insert(alertState).values({
      alertKey: "worker_down:0", kind: "worker_down", severity: "critical", openedAt: at(NOW, -2 * MIN),
      lastSeenAt: at(NOW, -MIN), notifyCount: 0, detail: "seeded", cls: "incident", title: "seeded", count: 1,
    } as never);
    const pager = sink("pager", true);
    await runAlertPass(db, { driver: "worker", shards: [], environment: "test", now: NOW, sinks: [pager] });
    expect(pager.keys).toEqual(["worker_down:0"]);
  });
});
