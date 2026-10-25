import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import {
  alertPassRuns, alertState, platformSignals, evaluateAlertsWithScope, runAlertPass, newDeliveryStreak,
  pagerVerdictOf, refusingAlertSink, sinkHealthOf, UNDELIVERABLE_REPEAT_MS,
  type AlertSink, type ApiCronReading, type EvaluateOptions,
} from "../src/cloud.js";

/**
 * THE ALERTING'S OWN REACH (rules 16-19): a driver that can page nobody is paged by the other
 * one; one dead arm beside a live one is named by its own driver; a clocked API pass gone stale
 * and a platform-signals poller gone dark page instead of reading as "not measured". Each kind
 * is driven firing and clear here; the database-counted streak and the dark hand-off are in
 * `alert-driver-gaps.pg.test.ts`.
 */
const NOW = new Date("2026-10-18T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function passRow(db: Db, driver: "worker" | "api", over: Partial<{
  ranAt: Date; streak: number; sinks: number;
}> = {}): Promise<void> {
  await db.insert(alertPassRuns).values({
    driver, ranAt: over.ranAt ?? ago(MIN), firing: 0, delivered: 0, failedSinks: 0,
    sinkFailureStreak: over.streak ?? 0, sinksConfigured: over.sinks ?? 1,
  });
}

const keysOf = async (db: Db, kind: string, opts: EvaluateOptions) =>
  (await evaluateAlertsWithScope(db, { now: NOW, shards: [], ...opts })).alerts
    .filter((a) => a.kind === kind);

function spy(name: string, ok: boolean, got: string[][]): AlertSink {
  return {
    name,
    notify: async (alerts) => {
      got.push(alerts.map((a) => a.key));
      return ok ? { ok: true } : { ok: false, outcome: "refused", error: "HTTP 503" };
    },
  };
}

describe("alert_driver_undeliverable — the other driver pages for a driver that reaches nobody", () => {
  it("an api arm with no sink is a warning signal on an armed worker; the api pass says nothing of itself", async () => {
    const db = await makeTestDb();
    await passRow(db, "worker");
    await passRow(db, "api", { sinks: 0 });
    const asWorker = await keysOf(db, "alert_driver_undeliverable", { driver: "worker" });
    expect(asWorker.map((a) => a.key)).toEqual(["alert_driver_undeliverable:api"]);
    // This driver carries the other's unpaged findings, so "none" is lost redundancy, not silence.
    expect(asWorker[0]!.severity).toBe("warning");
    expect(asWorker[0]!.cls).toBe("signal");
    expect(asWorker[0]!.signature).toBe("none");
    expect(asWorker[0]!.detail).toContain("TF_ALERT_WEBHOOK_URL");
    expect(asWorker[0]!.detail).not.toContain("pages nobody");
    expect(asWorker[0]!.affectedAccounts).toBeNull();
    expect(await keysOf(db, "alert_driver_undeliverable", { driver: "api" })).toEqual([]);
    expect(await keysOf(db, "alert_driver_undeliverable", {}), "a driverless read is not an arm").toEqual([]);
  });

  it("a streak of three fires, two does not; no row says nothing", async () => {
    const db = await makeTestDb();
    expect(await keysOf(db, "alert_driver_undeliverable", { driver: "worker" }), "no row").toEqual([]);
    await passRow(db, "api", { streak: 2 });
    expect(await keysOf(db, "alert_driver_undeliverable", { driver: "worker" })).toEqual([]);
    await db.update(alertPassRuns).set({ sinkFailureStreak: 3 });
    const [a] = await keysOf(db, "alert_driver_undeliverable", { driver: "worker" });
    expect(a?.key).toBe("alert_driver_undeliverable:api");
    expect(a?.signature).toBe("refusing|2");
  });

  it("NO LOOP: a worker whose every arm refuses never pages about itself; the api's arms carry it", async () => {
    const db = await makeTestDb();
    const workerGot: string[][] = [];
    const apiGot: string[][] = [];
    const workerStreak = newDeliveryStreak();
    // Something to deliver on every pass: shard 7 has no leader.
    for (let i = 0; i < 3; i++) {
      const p = await runAlertPass(db, {
        now: new Date(NOW.getTime() + i * MIN), driver: "worker", shards: [7],
        sinks: [spy("webhook", false, workerGot)], deliveryStreak: workerStreak,
      });
      expect(p.firing.map((a) => a.kind), "the worker never names itself").not.toContain("alert_driver_undeliverable");
    }
    expect(workerGot.flat()).not.toContain("alert_driver_undeliverable:worker");
    const api = await runAlertPass(db, {
      now: new Date(NOW.getTime() + 3 * MIN), driver: "api", shards: [],
      sinks: [spy("telegram", true, apiGot)], deliveryStreak: newDeliveryStreak(),
    });
    expect(api.firing.map((a) => a.key)).toContain("alert_driver_undeliverable:worker");
    expect(apiGot.flat(), "delivered through the api's own arm").toContain("alert_driver_undeliverable:worker");
    expect(workerGot.flat(), "and never handed to the refusing arm it is about").not.toContain("alert_driver_undeliverable:worker");
    expect(api.firing.filter((a) => a.kind === "alert_driver_undeliverable"), "one page, not one per refusal").toHaveLength(1);
  });
});

describe("alert_sink_degraded — one arm refusing while another delivers, self-reported", () => {
  const streaks = (mail: number, telegram: number) => ({
    sinks: ["mail", "telegram"],
    streaks: {
      mail: { consecutiveFailures: mail, attempts: 5 },
      telegram: { consecutiveFailures: telegram, attempts: 5 },
    },
  });

  it("{mail: 3 failures, telegram: ok} fires alert_sink_degraded:worker:mail", async () => {
    const db = await makeTestDb();
    const [a, more] = await keysOf(db, "alert_sink_degraded", { driver: "worker", sinkStreaks: streaks(3, 0) });
    expect(a?.key).toBe("alert_sink_degraded:worker:mail");
    expect(a?.severity).toBe("warning");
    expect(more).toBeUndefined();
  });

  it("two failures do not; every arm down is not this kind's (that silence is the other driver's)", async () => {
    const db = await makeTestDb();
    expect(await keysOf(db, "alert_sink_degraded", { driver: "worker", sinkStreaks: streaks(2, 0) })).toEqual([]);
    expect(await keysOf(db, "alert_sink_degraded", { driver: "worker", sinkStreaks: streaks(3, 3) })).toEqual([]);
  });

  it("a surviving arm never attempted is no witness", async () => {
    const db = await makeTestDb();
    const s = { sinks: ["mail", "telegram"], streaks: { mail: { consecutiveFailures: 4, attempts: 4 } } };
    expect(await keysOf(db, "alert_sink_degraded", { driver: "worker", sinkStreaks: s })).toEqual([]);
  });

  it("absent streaks are unread with no_reader, never an evaluated clear", async () => {
    const db = await makeTestDb();
    const { scope } = await evaluateAlertsWithScope(db, { now: NOW, driver: "worker", shards: [] });
    expect(scope.unreadReasons.get("alert_sink_degraded")).toBe("no_reader");
  });

  it("runAlertPass reads its own delivery streak: a pass after the third refusal fires", async () => {
    const db = await makeTestDb();
    const streak = newDeliveryStreak();
    const sinks = [spy("mail", false, []), spy("telegram", true, [])];
    let last;
    for (let i = 0; i < 4; i++) {
      last = await runAlertPass(db, {
        now: new Date(NOW.getTime() + i * 2 * HOUR), driver: "api", shards: [7], sinks, deliveryStreak: streak,
      });
    }
    expect(last!.firing.map((a) => a.key)).toContain("alert_sink_degraded:api:mail");
  });
});

describe("api_cron_stale — a clocked API pass that stopped answering 2xx", () => {
  const reading = (target: string, everySeconds: number, okAgo: number | null, since = ago(HOUR)): ApiCronReading => ({
    since, targets: [{ target, everySeconds, lastOkAt: okAgo === null ? null : ago(okAgo).toISOString(), outcome: "http_401", consecutiveFailures: 9 }],
  });
  const stale = (db: Db, apiCron: ApiCronReading | null, driver: "worker" | "api" = "worker") =>
    keysOf(db, "api_cron_stale", { driver, apiCron });

  it("a minute target 20 minutes without a 2xx fires critical; 10 minutes does not", async () => {
    const db = await makeTestDb();
    const [a] = await stale(db, reading("scheduled_send", 60, 20 * MIN));
    expect(a?.key).toBe("api_cron_stale:scheduled_send");
    expect(a?.severity).toBe("critical");
    expect(a?.detail).toContain("http_401");
    expect(await stale(db, reading("scheduled_send", 60, 10 * MIN))).toEqual([]);
  });

  it("never answered: counted from when the schedule started", async () => {
    const db = await makeTestDb();
    expect((await stale(db, reading("scheduled_send", 60, null, ago(20 * MIN)))).map((a) => a.key))
      .toEqual(["api_cron_stale:scheduled_send"]);
    expect(await stale(db, reading("scheduled_send", 60, null, ago(5 * MIN)))).toEqual([]);
  });

  it("a daily target: 30 hours is inside twice its cadence, 50 is past it, and it is a warning", async () => {
    const db = await makeTestDb();
    expect(await stale(db, reading("sessions_reap", 86_400, 30 * HOUR))).toEqual([]);
    const [a] = await stale(db, reading("sessions_reap", 86_400, 50 * HOUR));
    expect(a?.severity).toBe("warning");
  });

  it("the worker's in-process 5xx poll pages critical in its own words, never the API secrets'", async () => {
    const db = await makeTestDb();
    const [a] = await stale(db, { since: ago(HOUR), targets: [{
      target: "platform_signals", everySeconds: 300, lastOkAt: ago(20 * MIN).toISOString(),
      outcome: "failed", consecutiveFailures: 4, inProcess: true,
    }] });
    expect(a?.key).toBe("api_cron_stale:platform_signals");
    expect(a?.severity).toBe("critical");
    expect(a?.detail).toContain("platform_signal_pass");
    expect(a?.detail).toContain("TF_SIGNAL_VERCEL_TOKEN");
    expect(a?.detail).not.toMatch(/TF_API_CRON_SECRET|TF_ALERT_SECRET/);
  });

  it("apiCron null is unread with no_reader; the api driver never evaluates it", async () => {
    const db = await makeTestDb();
    const { scope } = await evaluateAlertsWithScope(db, { now: NOW, driver: "worker", shards: [], apiCron: null });
    expect(scope.unreadReasons.get("api_cron_stale")).toBe("no_reader");
    expect(await stale(db, reading("scheduled_send", 60, 20 * MIN), "api")).toEqual([]);
  });
});

describe("signal_source_dark — the platform-signals poller stopped writing", () => {
  const signal = (db: Db, fetchedAgo: number) => db.insert(platformSignals).values({
    provider: "vercel", project: "ohmail-api", windowStart: ago(fetchedAgo + 5 * MIN),
    requests: 10, errors5xx: 0, truncated: false, fetchedAt: ago(fetchedAgo),
  } as never);

  it("newest fetched_at 40 minutes ago fires; 10 minutes does not", async () => {
    const db = await makeTestDb();
    await signal(db, 40 * MIN);
    const [a] = await keysOf(db, "signal_source_dark", { driver: "api" });
    expect(a?.key).toBe("signal_source_dark:vercel:ohmail-api");
    expect(a?.detail).toContain("api_cron_stale:platform_signals");
    await signal(db, 10 * MIN);
    expect(await keysOf(db, "signal_source_dark", { driver: "api" })).toEqual([]);
  });

  it("an empty table says nothing, and a pass over it opens nothing", async () => {
    const db = await makeTestDb();
    expect(await keysOf(db, "signal_source_dark", { driver: "worker" })).toEqual([]);
    const p = await runAlertPass(db, { now: NOW, driver: "worker", shards: [], sinks: [] });
    expect(p.firing.map((a) => a.kind)).not.toContain("signal_source_dark");
  });
});

describe("the last resort when every arm is down", () => {
  it("pagerVerdictOf: no arm is unarmed, every arm at three is dead, one fresh arm is ok", () => {
    expect(pagerVerdictOf([])).toBe("unarmed");
    expect(pagerVerdictOf([{ consecutiveFailures: 3 }, { consecutiveFailures: 7 }])).toBe("dead");
    expect(pagerVerdictOf([{ consecutiveFailures: 3 }, { consecutiveFailures: 0 }])).toBe("ok");
    expect(pagerVerdictOf([{ consecutiveFailures: 2 }])).toBe("ok");
  });

  it("alerts_undeliverable escalates again an hour after the last while the streak holds", async () => {
    const db = await makeTestDb();
    const streak = newDeliveryStreak();
    const sinks = [spy("webhook", false, [])];
    const at = (ms: number) => runAlertPass(db, {
      now: new Date(NOW.getTime() + ms), shards: [7], sinks, deliveryStreak: streak,
    });
    expect((await at(0)).escalate).toBeNull();
    expect((await at(MIN)).escalate).toBeNull();
    expect((await at(2 * MIN)).escalate, "the third refusal escalates").not.toBeNull();
    expect((await at(3 * MIN)).escalate, "once").toBeNull();
    expect((await at(2 * MIN + UNDELIVERABLE_REPEAT_MS - MIN)).escalate, "59 minutes later: not yet").toBeNull();
    expect((await at(2 * MIN + UNDELIVERABLE_REPEAT_MS)).escalate, "an hour later: again").not.toBeNull();
  });

  it("a sink that could not be built is a refusing arm, never a missing one", async () => {
    const arm = refusingAlertSink("mail", "the mail arm could not be built at boot");
    const out = await arm.notify([], { source: "api", environment: "production", now: NOW });
    expect(out).toEqual({ ok: false, outcome: "misconfigured", error: "the mail arm could not be built at boot" });
  });
});

// ── Review of #103: recovery, restarts, blips and composition ─────────────────────────────

const at = (ms: number): Date => new Date(NOW.getTime() + ms);
const streakOf = async (db: Db, driver: "worker" | "api"): Promise<number> =>
  Number((await db.select().from(alertPassRuns).where(eq(alertPassRuns.driver, driver)))[0]?.sinkFailureStreak ?? -1);
const openKeys = async (db: Db): Promise<string[]> =>
  (await db.select().from(alertState)).filter((r) => r.resolvedAt === null).map((r) => r.alertKey);

/** An arm whose answer the test switches; `told` collects resolution notices when it has that leg. */
function switchable(name: string, state: { ok: boolean }, got: string[][] = [], told?: string[]): AlertSink {
  return {
    name,
    notify: async (alerts) => {
      got.push(alerts.map((a) => a.key));
      return state.ok ? { ok: true } : { ok: false, outcome: "refused", error: "HTTP 503" };
    },
    ...(told ? {
      notifyResolved: async (n: readonly { key: string }[]) => {
        told.push(...n.map((x) => x.key));
        return state.ok ? { ok: true } : { ok: false, outcome: "refused", error: "HTTP 503" };
      },
    } : {}),
  };
}

describe("alert_driver_undeliverable clears once the pager recovers", () => {
  it("three refused worker passes, the api pages; the arm is fixed with nothing else firing: resolved within one re-page window", async () => {
    const db = await makeTestDb();
    const arm = { ok: false };
    const workerGot: string[][] = [];
    const worker = switchable("webhook", arm, workerGot);
    const api = spy("telegram", true, []);
    const wStreak = newDeliveryStreak();
    const aStreak = newDeliveryStreak();
    for (let i = 0; i < 3; i++) {
      await runAlertPass(db, { now: at(i * MIN), driver: "worker", shards: [7], sinks: [worker], deliveryStreak: wStreak });
    }
    const paged = await runAlertPass(db, { now: at(3 * MIN), driver: "api", shards: [], sinks: [api], deliveryStreak: aStreak });
    expect(paged.notified.map((a) => a.key)).toContain("alert_driver_undeliverable:worker");
    arm.ok = true;
    let resolvedAt: number | null = null;
    for (let m = 4; m <= 70 && resolvedAt === null; m++) {
      await runAlertPass(db, { now: at(m * MIN), driver: "worker", shards: [], sinks: [worker], deliveryStreak: wStreak });
      if (m % 2 !== 0) continue;
      const p = await runAlertPass(db, { now: at(m * MIN), driver: "api", shards: [], sinks: [api], deliveryStreak: aStreak });
      if (p.resolved.includes("alert_driver_undeliverable:worker")) resolvedAt = m;
    }
    expect(resolvedAt, "the repaired arm carried its own alarm and the api cleared it").not.toBeNull();
    expect(resolvedAt!).toBeLessThanOrEqual(3 + 60 + 2);
    expect(await streakOf(db, "worker")).toBe(0);
  });

  it("mail-only arms on both drivers (the managed shape): the probe goes past the daily mail window", async () => {
    const db = await makeTestDb();
    const arm = { ok: false };
    const mailOf = (state: { ok: boolean }): AlertSink => ({
      name: "mail", channel: "mail",
      notify: async () => (state.ok ? { ok: true } : { ok: false, outcome: "refused", error: "HTTP 401" }),
    });
    const worker = mailOf(arm);
    const api = mailOf({ ok: true });
    const wStreak = newDeliveryStreak();
    const aStreak = newDeliveryStreak();
    for (let i = 0; i < 3; i++) {
      await runAlertPass(db, { now: at(i * MIN), driver: "worker", shards: [7], sinks: [worker], deliveryStreak: wStreak });
    }
    await runAlertPass(db, { now: at(3 * MIN), driver: "api", shards: [], sinks: [api], deliveryStreak: aStreak });
    expect(await openKeys(db)).toContain("alert_driver_undeliverable:worker");
    arm.ok = true;
    let resolvedAt: number | null = null;
    for (let m = 4; m <= 70 && resolvedAt === null; m++) {
      await runAlertPass(db, { now: at(m * MIN), driver: "worker", shards: [], sinks: [worker], deliveryStreak: wStreak });
      if (m % 2 !== 0) continue;
      const p = await runAlertPass(db, { now: at(m * MIN), driver: "api", shards: [], sinks: [api], deliveryStreak: aStreak });
      if (p.resolved.includes("alert_driver_undeliverable:worker")) resolvedAt = m;
    }
    expect(resolvedAt).not.toBeNull();
  });

  it("a still-refusing arm is asked at most once per re-page window and pages nobody", async () => {
    const db = await makeTestDb();
    const workerGot: string[][] = [];
    const worker = switchable("webhook", { ok: false }, workerGot);
    const wStreak = newDeliveryStreak();
    for (let i = 0; i < 3; i++) {
      await runAlertPass(db, { now: at(i * MIN), driver: "worker", shards: [7], sinks: [worker], deliveryStreak: wStreak });
    }
    const api = spy("telegram", true, []);
    const aStreak = newDeliveryStreak();
    await runAlertPass(db, { now: at(3 * MIN), driver: "api", shards: [], sinks: [api], deliveryStreak: aStreak });
    workerGot.length = 0;
    for (let m = 4; m <= 64; m++) {
      await runAlertPass(db, { now: at(m * MIN), driver: "worker", shards: [], sinks: [worker], deliveryStreak: wStreak });
      if (m % 2 === 0) await runAlertPass(db, { now: at(m * MIN), driver: "api", shards: [], sinks: [api], deliveryStreak: aStreak });
    }
    const asks = workerGot.flat().filter((k) => k === "alert_driver_undeliverable:worker");
    expect(asks.length).toBeLessThanOrEqual(1);
    expect(await openKeys(db)).toContain("alert_driver_undeliverable:worker");
  });

  it("a delivered resolution notice resets the database streak; a refused one adds to it", async () => {
    const db = await makeTestDb();
    await passRow(db, "api", { streak: 3, ranAt: ago(2 * MIN) });
    const seedResolved = (key: string) => db.insert(alertState).values({
      alertKey: key, kind: "worker_down", severity: "critical", openedAt: ago(3 * HOUR),
      lastSeenAt: ago(2 * HOUR), resolvedAt: ago(2 * HOUR), notifyCount: 1, cls: "incident",
    } as never);
    await seedResolved("worker_down:7");
    const told: string[] = [];
    const refused = { ok: false };
    const p1 = await runAlertPass(db, {
      now: NOW, driver: "api", shards: [], sinks: [switchable("telegram", refused, [], told)], deliveryStreak: newDeliveryStreak(),
    });
    expect(p1.resolutionsTold).toEqual([]);
    expect(await streakOf(db, "api")).toBe(4);
    refused.ok = true;
    const p2 = await runAlertPass(db, {
      now: at(MIN), driver: "api", shards: [], sinks: [switchable("telegram", refused, [], told)], deliveryStreak: newDeliveryStreak(),
    });
    expect(p2.resolutionsTold).toEqual(["worker_down:7"]);
    expect(await streakOf(db, "api")).toBe(0);
  });

  it("a delivered digest resets the database streak", async () => {
    const db = await makeTestDb();
    await passRow(db, "api", { streak: 3, ranAt: ago(2 * MIN) });
    await db.insert(alertState).values({
      alertKey: "worker_down:7", kind: "worker_down", severity: "critical", openedAt: ago(3 * HOUR),
      lastSeenAt: ago(2 * HOUR), resolvedAt: ago(2 * HOUR), notifyCount: 1, cls: "incident",
    } as never);
    const mail: AlertSink = {
      name: "mail", channel: "mail",
      notify: async () => ({ ok: true }),
      notifyDigest: async () => ({ ok: true }),
    };
    const p = await runAlertPass(db, { now: NOW, driver: "api", shards: [], sinks: [mail], deliveryStreak: newDeliveryStreak() });
    expect(p.digest).not.toBeNull();
    expect(await streakOf(db, "api")).toBe(0);
  });
});

describe("alert_driver_undeliverable 'none' only where its premise holds", () => {
  it("an observer with no sink of its own fires nothing: both no-channel passes stay quiet", async () => {
    const db = await makeTestDb();
    for (let m = 0; m < 4; m++) {
      for (const driver of ["worker", "api"] as const) {
        const p = await runAlertPass(db, { now: at(m * MIN), driver, shards: [], sinks: [] });
        expect(p.firing.map((a) => a.kind), `${driver} at ${m}`).not.toContain("alert_driver_undeliverable");
      }
    }
    expect(await openKeys(db)).toEqual([]);
  });

  it("an armed observer records it as a signal: no page goes out", async () => {
    const db = await makeTestDb();
    const got: string[][] = [];
    await runAlertPass(db, { now: NOW, driver: "worker", shards: [], sinks: [] });
    const p = await runAlertPass(db, { now: at(MIN), driver: "api", shards: [], sinks: [spy("mail", true, got)] });
    expect(p.firing.map((a) => a.key)).toContain("alert_driver_undeliverable:worker");
    expect(got.flat()).not.toContain("alert_driver_undeliverable:worker");
  });
});

describe("api_cron_stale clears only on a 2xx, and a single missed run is not stale", () => {
  type T = ApiCronReading["targets"][number];
  const reading = (since: Date, ...targets: T[]): ApiCronReading => ({ since, targets });
  const target = (over: Partial<T> & { target: string; everySeconds: number }): T => ({
    lastOkAt: null, outcome: null, consecutiveFailures: 0, ...over,
  });

  it("a restart with the target still refusing keeps the open row and tells no resolution", async () => {
    const db = await makeTestDb();
    const told: string[] = [];
    const sinks = [switchable("telegram", { ok: true }, [], told)];
    const failing = target({
      target: "sessions_reap", everySeconds: 86_400, lastOkAt: ago(50 * HOUR).toISOString(),
      outcome: "http_401", consecutiveFailures: 2,
    });
    const opened = await runAlertPass(db, { now: NOW, driver: "worker", shards: [], sinks, apiCron: reading(ago(60 * HOUR), failing) });
    expect(opened.notified.map((a) => a.key)).toContain("api_cron_stale:sessions_reap");
    // The worker restarts: the schedule's memory is gone, no poke yet.
    const boot = at(5 * MIN);
    const fresh = await runAlertPass(db, {
      now: at(6 * MIN), driver: "worker", shards: [], sinks,
      apiCron: reading(boot, target({ target: "sessions_reap", everySeconds: 86_400 })),
    });
    expect(fresh.resolved).not.toContain("api_cron_stale:sessions_reap");
    // Its first poke after boot answers 401 again: the row stays confirmed, hours on.
    for (let h = 1; h <= 3; h++) {
      const p = await runAlertPass(db, {
        now: at(h * HOUR), driver: "worker", shards: [], sinks,
        apiCron: reading(boot, target({ target: "sessions_reap", everySeconds: 86_400, outcome: "http_401", consecutiveFailures: 1 })),
      });
      expect(p.resolved).not.toContain("api_cron_stale:sessions_reap");
      expect(p.closedUnconfirmed).not.toContain("api_cron_stale:sessions_reap");
    }
    expect(told).toEqual([]);
    expect(await openKeys(db)).toContain("api_cron_stale:sessions_reap");
    // A 2xx is the evidence that clears it.
    const ok = await runAlertPass(db, {
      now: at(4 * HOUR), driver: "worker", shards: [], sinks,
      apiCron: reading(boot, target({ target: "sessions_reap", everySeconds: 86_400, lastOkAt: at(4 * HOUR - MIN).toISOString(), outcome: "ok" })),
    });
    expect(ok.resolved).toContain("api_cron_stale:sessions_reap");
  });

  it("a key the schedule no longer drives is evaluated clear", async () => {
    const db = await makeTestDb();
    await db.insert(alertState).values({
      alertKey: "api_cron_stale:retired", kind: "api_cron_stale", severity: "warning", openedAt: ago(HOUR),
      lastSeenAt: ago(MIN), notifyCount: 1, cls: "incident",
    } as never);
    const p = await runAlertPass(db, {
      now: NOW, driver: "worker", shards: [], sinks: [],
      apiCron: reading(ago(MIN), target({ target: "scheduled_send", everySeconds: 60 })),
    });
    expect(p.resolved).toEqual(["api_cron_stale:retired"]);
  });

  it("one failed poke of an hourly or daily target is a blip: its retry lands past twice the cadence", async () => {
    const db = await makeTestDb();
    const stale = async (t: T) => (await keysOf(db, "api_cron_stale", { driver: "worker", apiCron: reading(ago(100 * HOUR), t) }))
      .map((a) => a.key);
    // One miss, its retry (cadence + jitter) not yet in.
    expect(await stale(target({ target: "unsubscribe_drain", everySeconds: 3600, lastOkAt: ago(2 * HOUR + 7 * MIN).toISOString(), outcome: "http_error", consecutiveFailures: 1 }))).toEqual([]);
    expect(await stale(target({ target: "sessions_reap", everySeconds: 86_400, lastOkAt: ago(48 * HOUR + 9 * MIN).toISOString(), outcome: "http_error", consecutiveFailures: 1 }))).toEqual([]);
    // The retry failed too.
    expect(await stale(target({ target: "unsubscribe_drain", everySeconds: 3600, lastOkAt: ago(2 * HOUR + 7 * MIN).toISOString(), outcome: "http_error", consecutiveFailures: 2 }))).toEqual(["api_cron_stale:unsubscribe_drain"]);
    // A schedule that stopped (or a poke that hangs) still pages, at three cadences.
    expect(await stale(target({ target: "unsubscribe_drain", everySeconds: 3600, lastOkAt: ago(3 * HOUR + MIN).toISOString(), outcome: "ok", consecutiveFailures: 0 }))).toEqual(["api_cron_stale:unsubscribe_drain"]);
    // The fast clocks keep the fifteen-minute floor either way.
    expect(await stale(target({ target: "scheduled_send", everySeconds: 60, lastOkAt: ago(16 * MIN).toISOString(), outcome: "http_401", consecutiveFailures: 1 }))).toEqual(["api_cron_stale:scheduled_send"]);
  });
});

describe("alert_sink_degraded clears only on an arm that delivered", () => {
  it("a restart with the arm still refusing leaves the row open and tells no resolution", async () => {
    const db = await makeTestDb();
    const told: string[] = [];
    const mail = switchable("mail", { ok: false });
    const telegram = switchable("telegram", { ok: true }, [], told);
    const warm = newDeliveryStreak();
    let p;
    for (let i = 0; i < 4; i++) {
      p = await runAlertPass(db, { now: at(i * 2 * HOUR), driver: "worker", shards: [7], sinks: [mail, telegram], deliveryStreak: warm });
    }
    expect(p!.firing.map((a) => a.key)).toContain("alert_sink_degraded:worker:mail");
    const t0 = 8 * HOUR;
    const cold = newDeliveryStreak();
    const restart = await runAlertPass(db, { now: at(t0), driver: "worker", shards: [7], sinks: [mail, telegram], deliveryStreak: cold });
    expect(restart.resolved).not.toContain("alert_sink_degraded:worker:mail");
    const later = await runAlertPass(db, { now: at(t0 + 61 * MIN), driver: "worker", shards: [7], sinks: [mail, telegram], deliveryStreak: cold });
    expect(later.resolved).not.toContain("alert_sink_degraded:worker:mail");
    expect(told).not.toContain("alert_sink_degraded:worker:mail");
  });

  it("evaluated clear once the arm delivers", async () => {
    const db = await makeTestDb();
    const s = (mail: { consecutiveFailures: number; attempts: number }) => ({
      sinks: ["mail", "telegram"], streaks: { mail, telegram: { consecutiveFailures: 0, attempts: 5 } },
    });
    const scopeOf = async (mail: { consecutiveFailures: number; attempts: number }) =>
      (await evaluateAlertsWithScope(db, { now: NOW, driver: "worker", shards: [], sinkStreaks: s(mail) })).scope;
    const { ALERT_KIND_ARMS } = await import("../src/cloud.js");
    const judged = (scope: Awaited<ReturnType<typeof scopeOf>>) =>
      ALERT_KIND_ARMS.alert_sink_degraded.evaluated("alert_sink_degraded:worker:mail", scope);
    expect(judged(await scopeOf({ consecutiveFailures: 0, attempts: 0 })), "never attempted").toBe(false);
    expect(judged(await scopeOf({ consecutiveFailures: 1, attempts: 1 })), "refusing, under the streak").toBe(false);
    expect(judged(await scopeOf({ consecutiveFailures: 0, attempts: 2 })), "delivered").toBe(true);
    expect(judged(await scopeOf({ consecutiveFailures: 4, attempts: 4 })), "firing").toBe(true);
  });
});

describe("an arm that could not be built is known dead, not unexercised", () => {
  it("/health reads it misconfigured at a full streak, and a host left with only it is dead", () => {
    const arm = refusingAlertSink("mail", "the mail arm could not be built at boot");
    const [h] = sinkHealthOf([arm], newDeliveryStreak());
    expect(h).toMatchObject({ name: "mail", outcome: "misconfigured" });
    expect(h!.consecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(pagerVerdictOf(sinkHealthOf([arm], newDeliveryStreak()))).toBe("dead");
    expect(pagerVerdictOf(sinkHealthOf([arm, spy("telegram", true, [])], newDeliveryStreak()))).toBe("ok");
  });

  it("a driver left with only that arm counts none: its streak records 0 and the other driver lists the warning signal", async () => {
    const db = await makeTestDb();
    const broken = refusingAlertSink("mail", "the mail arm could not be built at boot");
    const streak = newDeliveryStreak();
    let escalated = false;
    // Something to deliver on every pass (shard 7 has no leader): the broken arm is asked and refuses.
    for (let i = 0; i < 3; i++) {
      const p = await runAlertPass(db, { now: at(i * 2 * MIN), driver: "api", shards: [7], sinks: [broken], deliveryStreak: streak });
      if (p.escalate) escalated = true;
    }
    expect(await streakOf(db, "api"), "no usable arm: nothing it could be refused by").toBe(0);
    const [row] = await db.select().from(alertPassRuns).where(eq(alertPassRuns.driver, "api"));
    expect(row?.sinksConfigured, "an arm that could not be built is not counted").toBe(0);
    const [a] = await keysOf(db, "alert_driver_undeliverable", { driver: "worker", now: at(6 * MIN) });
    expect(a?.signature).toBe("none");
    expect(a?.severity).toBe("warning");
    expect(a?.cls).toBe("signal");
    expect(escalated, "the host's own alerts_undeliverable line is still the last resort").toBe(true);
  });

  it("beside a live arm it is named degraded at once", async () => {
    const db = await makeTestDb();
    const broken = refusingAlertSink("mail", "the mail arm could not be built at boot");
    const streak = newDeliveryStreak();
    streak.sinks = { telegram: { consecutiveFailures: 0, attempts: 2, lastOutcome: "ok", lastOkAt: ago(MIN).toISOString() } } as never;
    const p = await runAlertPass(db, {
      now: NOW, driver: "api", shards: [], sinks: [spy("telegram", true, []), broken], deliveryStreak: streak,
    });
    expect(p.firing.map((a) => a.key)).toContain("alert_sink_degraded:api:mail");
  });
});

// ── Review of #103, round 3: what one pass says about a driver's pager ──────────────────────

/** A mail arm: it takes pages and never a resolution notice (no mail sink has that leg). */
function mailArm(state: { ok: boolean }, got: string[][] = []): AlertSink {
  return {
    name: "mail", channel: "mail",
    notify: async (alerts) => {
      got.push(alerts.map((a) => a.key));
      return state.ok ? { ok: true } : { ok: false, outcome: "refused", error: "HTTP 401" };
    },
  };
}

/** An incident this driver paged once, resolved two hours ago: a resolution notice is owed. */
const owedNotice = (db: Db, key: string) => db.insert(alertState).values({
  alertKey: key, kind: "worker_down", severity: "critical", openedAt: ago(3 * HOUR),
  lastSeenAt: ago(2 * HOUR), resolvedAt: ago(2 * HOUR), notifyCount: 1, cls: "incident",
} as never);

const undeliverableSeenBy = (db: Db, observer: "worker" | "api", now: Date) =>
  keysOf(db, "alert_driver_undeliverable", { driver: observer, now });

describe("a pass counts as refused only when it asked every usable arm and every one refused", () => {
  it("an owed resolution notice only the dead webhook takes leaves the api's streak at 0; the worker pages nothing", async () => {
    const db = await makeTestDb();
    await owedNotice(db, "worker_down:3");
    const told: string[] = [];
    const mailGot: string[][] = [];
    const sinks = [switchable("webhook", { ok: false }, [], told), mailArm({ ok: true }, mailGot)];
    const streak = newDeliveryStreak();
    for (let m = 0; m < 5; m++) {
      await runAlertPass(db, { now: at(m * MIN), driver: "api", shards: [], sinks, deliveryStreak: streak });
      expect(await streakOf(db, "api"), `pass ${m}: the mail arm was never asked`).toBe(0);
    }
    expect(told, "the notice went to the webhook alone, on every pass").toHaveLength(5);
    expect(mailGot).toEqual([]);
    expect(await undeliverableSeenBy(db, "worker", at(5 * MIN))).toEqual([]);
  });

  it("a critical re-page the mail window holds goes to the dead webhook alone and moves neither streak", async () => {
    const db = await makeTestDb();
    const hookGot: string[][] = [];
    const mailGot: string[][] = [];
    const sinks = [switchable("webhook", { ok: false }, hookGot), mailArm({ ok: true }, mailGot)];
    const streak = newDeliveryStreak();
    let top = 0;
    let escalated = false;
    for (let m = 0; m <= 70; m++) {
      const p = await runAlertPass(db, { now: at(m * MIN), driver: "api", shards: [7], sinks, deliveryStreak: streak });
      top = Math.max(top, await streakOf(db, "api"), p.sinkFailureStreak);
      if (p.escalate) escalated = true;
    }
    expect(mailGot.flat().filter((k) => k === "worker_down:7"), "mailed once; the window holds the re-pages").toHaveLength(1);
    expect(hookGot.flat().filter((k) => k === "worker_down:7").length, "re-paged to the webhook alone").toBeGreaterThan(3);
    expect(top, "neither the database streak nor the in-memory one moved").toBe(0);
    expect(escalated, "no alerts_undeliverable while the mail arm delivers").toBe(false);
    expect(await undeliverableSeenBy(db, "worker", at(71 * MIN))).toEqual([]);
  });

  it("an incident whose mail verdict is the digest goes to the dead webhook alone and moves nothing", async () => {
    const db = await makeTestDb();
    // Open and never paged, of a kind only the worker evaluates: the api carries it on every pass.
    await db.insert(alertState).values({
      alertKey: "imap_admission_refused", kind: "imap_admission_refused", severity: "warning",
      openedAt: ago(5 * MIN), lastSeenAt: ago(MIN), notifyCount: 0, cls: "incident",
      title: "IMAP admissions refused", detail: "seeded", count: 4,
    } as never);
    const hookGot: string[][] = [];
    const mailGot: string[][] = [];
    const sinks = [switchable("webhook", { ok: false }, hookGot), mailArm({ ok: true }, mailGot)];
    const streak = newDeliveryStreak();
    for (let m = 0; m < 5; m++) {
      const p = await runAlertPass(db, { now: at(m * MIN), driver: "api", shards: [], sinks, deliveryStreak: streak });
      expect(p.sinkFailureStreak, `pass ${m}`).toBe(0);
      expect(p.escalate, `pass ${m}`).toBeNull();
      expect(await streakOf(db, "api"), `pass ${m}`).toBe(0);
    }
    expect(hookGot.flat().filter((k) => k === "imap_admission_refused")).toHaveLength(5);
    expect(mailGot.flat(), "the digest's verdict: never a mail page").not.toContain("imap_admission_refused");
    expect(await undeliverableSeenBy(db, "worker", at(5 * MIN))).toEqual([]);
  });

  it("both drivers a minute apart: the organizer's lone dead webhook is paged, the api's mail arm keeps it off the list", async () => {
    const db = await makeTestDb();
    const organizer = [switchable("webhook", { ok: false })];
    const apiMail: string[][] = [];
    const api = [switchable("webhook", { ok: false }), mailArm({ ok: true }, apiMail)];
    const wStreak = newDeliveryStreak();
    const aStreak = newDeliveryStreak();
    const opened = new Set<string>();
    for (let m = 0; m <= 75; m++) {
      await runAlertPass(db, { now: at(m * MIN), driver: "worker", shards: [7], sinks: organizer, deliveryStreak: wStreak });
      await runAlertPass(db, { now: at(m * MIN + 30_000), driver: "api", shards: [7], sinks: api, deliveryStreak: aStreak });
      for (const k of await openKeys(db)) opened.add(k);
    }
    expect([...opened], "every arm the organizer has refused: paged").toContain("alert_driver_undeliverable:worker");
    expect([...opened], "the api's dead arm is named beside its live one").toContain("alert_sink_degraded:api:webhook");
    expect([...opened], "and the api is never paged as reaching nobody").not.toContain("alert_driver_undeliverable:api");
    expect(apiMail.flat()).not.toContain("alert_driver_undeliverable:api");
  });

  it("the worker mirror: a dead Telegram beside a working mail arm is not a pager reaching nobody", async () => {
    const db = await makeTestDb();
    await owedNotice(db, "worker_down:3");
    const told: string[] = [];
    const sinks = [switchable("telegram", { ok: false }, [], told), mailArm({ ok: true })];
    const streak = newDeliveryStreak();
    // Pass 0 also pages worker_down:7 to both arms (mail takes it); passes 1-4 only owe the notice.
    for (let m = 0; m < 5; m++) {
      await runAlertPass(db, { now: at(m * MIN), driver: "worker", shards: [7], sinks, deliveryStreak: streak });
      expect(await streakOf(db, "worker"), `pass ${m}`).toBe(0);
    }
    expect(told.length, "the notice was asked of Telegram alone, on every pass").toBe(5);
    expect(await undeliverableSeenBy(db, "api", at(5 * MIN))).toEqual([]);
  });

  it("the twin: every arm refusing a mailed page fires after three passes, and the host escalates", async () => {
    const db = await makeTestDb();
    const sinks = [switchable("webhook", { ok: false }), mailArm({ ok: false })];
    const streak = newDeliveryStreak();
    const passes = [];
    for (let m = 0; m < 3; m++) {
      passes.push(await runAlertPass(db, { now: at(m * MIN), driver: "api", shards: [7], sinks, deliveryStreak: streak }));
      if (m < 2) expect(await undeliverableSeenBy(db, "worker", at(m * MIN + 30_000)), `after pass ${m}`).toEqual([]);
    }
    expect(passes.map((p) => p.sinkOutcomes.map((o) => o.sink).sort()), "both arms asked on every pass")
      .toEqual([["mail", "webhook"], ["mail", "webhook"], ["mail", "webhook"]]);
    expect(await streakOf(db, "api")).toBe(3);
    expect(passes[2]!.sinkFailureStreak).toBe(3);
    expect(passes[2]!.escalate, "the third full refusal escalates").not.toBeNull();
    const [a] = await undeliverableSeenBy(db, "worker", at(3 * MIN));
    expect(a?.key).toBe("alert_driver_undeliverable:api");
    expect(a?.severity).toBe("critical");
    expect(a?.signature).toBe("refusing|2");
  });
});

describe("a driver left with no usable arm counts none, never a refusal that outlives its arms", () => {
  const variants: Array<[string, () => AlertSink[]]> = [
    ["every arm removed", () => []],
    ["only an arm that no longer builds", () => [refusingAlertSink("webhook", "the webhook arm could not be built at boot")]],
  ];
  for (const [label, rest] of variants) {
    it(`${label}: the streak records 0 and the critical row becomes the 'none' signal`, async () => {
      const db = await makeTestDb();
      const wStreak = newDeliveryStreak();
      for (let i = 0; i < 3; i++) {
        await runAlertPass(db, {
          now: at(i * MIN), driver: "worker", shards: [7], sinks: [switchable("webhook", { ok: false })], deliveryStreak: wStreak,
        });
      }
      const apiGot: string[][] = [];
      const api = [spy("telegram", true, apiGot)];
      const aStreak = newDeliveryStreak();
      const paged = await runAlertPass(db, { now: at(3 * MIN), driver: "api", shards: [], sinks: api, deliveryStreak: aStreak });
      expect(paged.notified.map((a) => a.key)).toContain("alert_driver_undeliverable:worker");
      // The operator drops the broken channel, or it no longer builds: the organizer restarts with none.
      await runAlertPass(db, { now: at(4 * MIN), driver: "worker", shards: [7], sinks: rest(), deliveryStreak: newDeliveryStreak() });
      expect(await streakOf(db, "worker")).toBe(0);
      apiGot.length = 0;
      const after = await runAlertPass(db, { now: at(5 * MIN), driver: "api", shards: [], sinks: api, deliveryStreak: aStreak });
      const a = after.firing.find((x) => x.key === "alert_driver_undeliverable:worker");
      expect([a?.signature, a?.severity, a?.cls]).toEqual(["none", "warning", "signal"]);
      expect(apiGot.flat(), "a signal pages nobody").not.toContain("alert_driver_undeliverable:worker");
      const [row] = await db.select().from(alertState).where(eq(alertState.alertKey, "alert_driver_undeliverable:worker"));
      expect([row?.cls, row?.severity, row?.resolvedAt ?? null], "the incident ended; the row is the signal now")
        .toEqual(["signal", "warning", null]);
      // An observer that can push nothing itself says nothing, per the rule: the row clears.
      const mute = await runAlertPass(db, { now: at(6 * MIN), driver: "api", shards: [], sinks: [] });
      expect(mute.firing.map((x) => x.kind)).not.toContain("alert_driver_undeliverable");
      expect(mute.resolved).toContain("alert_driver_undeliverable:worker");
    });
  }
});
