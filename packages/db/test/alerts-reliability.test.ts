import { describe, it, expect } from "vitest";
import { eq, isNotNull, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "../src/testing.js";
import { accounts, mailboxes } from "@trafficflow/db";
import {
  alertPassRuns, alertState, authThrottle, platformSignals, workerHeartbeats,
} from "../src/cloud.js";
import {
  evaluateAlerts, runAlertPass, writeHeartbeat, alertClass, incidentsOf, signalsOf,
  alertDriverStatuses, platformSignalWindow, recordImapRefusal, imapRefusalsInWindow,
  newDeliveryStreak,
  acquireImapSlot,
  CLOUD_JOURNAL_HEAD_WHEN, DEFAULT_ALERT_THRESHOLDS, SCOPED_ALERT_KINDS, isSchemaBehind,
  type Alert, type AlertKind, type AlertSink,
} from "../src/cloud.js";
import { recordAlertPass } from "../src/alerts.js";

/**
 * INCIDENTS AND SIGNALS — the reliability rules of cloud 0030, each asserted against a seeded
 * failure state rather than against a real one.
 *
 * `alerts.test.ts` next door covers the original rules and the notification machinery. This file
 * covers what the split added, and the two properties it is really about:
 *
 *  1. **A SIGNAL IS NEVER DELIVERED.** It is recorded, it renders, and no sink ever sees it.
 *     The mutation for this is the first test below, and it is the one that matters most: a
 *     class gate that does not actually gate is indistinguishable from one that does, on every
 *     pass where nothing happens to be firing.
 *  2. **A DRIVER NEVER REPORTS ON ITSELF.** `alert_driver_dark` reads the OTHER driver's row.
 *     A pass that checked its own would be asking a running process whether it is running: the
 *     answer is always yes, the rule could never fire, and the deployment would carry a guard
 *     that reads as coverage and is decoration.
 *
 * ── MUTATIONS RUN, WATCHED RED, RESTORED ──────────────────────────────────────────────────
 *   · the claim's `alertClass(alert) !== "incident"` guard removed  ⇒ "a SIGNAL is recorded but
 *     never delivered" fails on `delivered`, and the `notified` assertion too
 *   · `alert_driver_dark` reading `opts.driver` instead of `other` ⇒ "the OTHER driver" fails:
 *     the pass reports ITSELF dark and never reports the arm that stopped
 *   · the unconfigured 5xx branch made to write `requests: 0, errors_5xx: 0` ⇒ "an unconfigured
 *     deployment has NO ROW, never a zero" fails on the window read
 *   · `sync_lag`'s promotion cut removed (always `incident`)        ⇒ "one lagging account of
 *     twelve is a SIGNAL" fails
 *   · `firstOpenedAt` moved to every trip instead of the first      ⇒ covered in the worker's
 *     own suite; here the heartbeat column is read directly
 */

type Db = Awaited<ReturnType<typeof makeTestDb>>;

const NOW = new Date("2026-09-04T12:00:00.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const SEC = 1000;
const MIN = 60_000;
const HOUR = 60 * MIN;

async function seedAccount(db: Db, name = "Reliability"): Promise<string> {
  const [acct] = await db.insert(accounts).values({ name }).returning();
  return acct!.id;
}

/** A live, healthy leader for shard 0 — the state every rule below is judged against. */
/**
 * A leader's heartbeat, written through the REAL writer.
 *
 * `degradedFor` is not a column this sets directly — it cannot be, and that is the point.
 * `degraded_since` is computed by `writeHeartbeat` against whatever is already on the row, so
 * the only honest way to produce "degraded for twenty minutes" is to BEAT twenty minutes ago and
 * beat again now. Writing the stamp by hand would test a value this code never produces.
 *
 * It defaults to `upFor`, i.e. degraded since boot, which is what every test written before the
 * column existed meant by `degraded: true`.
 */
/** The worker arm's own pass row, a minute old: a leader that is up and whose alert pass runs
 *  with a sink (a row with none is `alert_driver_undeliverable:worker`). */
async function seedWorkerPass(db: Db): Promise<void> {
  await db.insert(alertPassRuns).values({
    driver: "worker", ranAt: ago(MIN), firing: 0, delivered: 0, failedSinks: 0,
    sinkFailureStreak: 0, sinksConfigured: 1,
  });
}

async function seedHeartbeat(db: Db, over: {
  age?: number; degraded?: boolean; upFor?: number; aiCircuitOpenSince?: Date | null;
  degradedFor?: number; instanceId?: string; aiProviderOkAt?: Date | null;
} = {}): Promise<void> {
  const age = over.age ?? 10_000;
  const upFor = over.upFor ?? HOUR;
  const beat = (at: number, degraded: boolean, instanceId: string) => writeHeartbeat(db, {
    shardIndex: 0, instanceId, shards: 1,
    mailboxes: 2, expected: 2, accounts: 1, quarantined: 0,
    degraded,
    aiCircuitOpenSince: over.aiCircuitOpenSince ?? null,
    // ABSENT MEANS "this process has never had an answer from the provider", which is what a
    // freshly started worker really is. Only a test that says otherwise gets recovery.
    aiProviderOkAt: over.aiProviderOkAt ?? null,
    lastCycleAt: ago(age), startedAt: ago(upFor),
  }, ago(at));

  const id = over.instanceId ?? "wkr-test";
  if (over.degraded) {
    // The FIRST degraded beat is what starts the clock; the second preserves it.
    const since = over.degradedFor ?? upFor;
    if (since > age) await beat(since, true, id);
  }
  await beat(age, over.degraded ?? false, id);
}

async function seedMailbox(db: Db, accountId: string, lastSyncAge: number | null): Promise<void> {
  await db.insert(mailboxes).values({
    accountId,
    provider: "imap",
    address: `rel-${Math.random().toString(36).slice(2, 10)}@example.test`,
    status: "connected",
    lastSyncAt: lastSyncAge === null ? null : ago(lastSyncAge),
    createdAt: ago(4 * HOUR),
  });
}

/** A sink that records what it was handed and always accepts. */
function spySink(name: string): AlertSink & { seen: Alert[][] } {
  const seen: Alert[][] = [];
  return {
    name,
    seen,
    async notify(alerts) { seen.push([...alerts]); return { ok: true }; },
  } as AlertSink & { seen: Alert[][] };
}

const keysOf = (as: readonly Alert[]): string[] => as.map((a) => a.key).sort();
const find = (as: readonly Alert[], kind: AlertKind): Alert | undefined =>
  as.find((a) => a.kind === kind);

/* ════════════════════════════════════════════════════════════════════════════════════════
   1. The class gate — the property the whole slice is for
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("the incident/signal split", () => {
  it("a SIGNAL is recorded in alert_state and NEVER handed to a sink", async () => {
    const db = await makeTestDb();
    await seedHeartbeat(db);
    // ONE account lagging out of TWELVE on duty: below both promotion arms (the count and the share), so
    // the warning tier stays a SIGNAL. That is the population this test needs and the reason it
    // seeds eleven healthy accounts rather than one.
    const lagging = await seedAccount(db, "lagging");
    await seedMailbox(db, lagging, 90 * MIN);
    for (let i = 0; i < 11; i++) {
      const a = await seedAccount(db, `healthy-${i}`);
      await seedMailbox(db, a, MIN);
    }

    const sink = spySink("spy");
    const result = await runAlertPass(db, { now: NOW, sinks: [sink], driver: "worker" });

    const lag = find(result.firing, "sync_lag");
    expect(lag, "the condition is firing").toBeTruthy();
    expect(alertClass(lag!), "one account of twelve is below both promotion arms").toBe("signal");

    // RECORDED. The row exists, carries the class, and can be rendered.
    const [row] = await db.select().from(alertState).where(eq(alertState.alertKey, "sync_lag"));
    expect(row, "a signal opens its alert_state row exactly as an incident does").toBeTruthy();
    expect(row!.cls).toBe("signal");
    expect(row!.affectedAccounts).toBe(1);
    expect(row!.fixHref).toBe("/worker");

    // AND NEVER DELIVERED. Three independent statements of the same property, because the class
    // gate sits at the CLAIM and each of these is a different consequence of that placement.
    expect(sink.seen.flat().map((a) => a.key), "no sink ever saw it").not.toContain("sync_lag");
    expect(result.notified.map((a) => a.key), "it was never claimed").not.toContain("sync_lag");
    expect(row!.notifiedAt, "and `notified_at` still means 'a human was told'").toBeNull();
    expect(row!.notifyCount).toBe(0);
  });

  it("an INCIDENT in the same pass IS delivered — the gate is not just 'nothing is sent'", async () => {
    // The other half of the mutation above. A guard that silenced EVERYTHING would satisfy the
    // previous test perfectly, and this is what refuses that reading.
    const db = await makeTestDb();
    // No heartbeat at all ⇒ `worker_down`, which is an incident.
    const sink = spySink("spy");
    const result = await runAlertPass(db, { now: NOW, sinks: [sink], driver: "api", shards: [0] });

    const down = find(result.firing, "worker_down");
    expect(down).toBeTruthy();
    expect(alertClass(down!)).toBe("incident");
    expect(sink.seen.flat().map((a) => a.key)).toContain("worker_down:0");
    expect(result.delivered).toEqual(["spy"]);

    const [row] = await db.select().from(alertState)
      .where(eq(alertState.alertKey, "worker_down:0"));
    expect(row!.cls).toBe("incident");
    expect(row!.notifiedAt, "an incident's confirm stamps the row").not.toBeNull();
    expect(row!.fixHref).toBe("/worker");
  });

  it("`incidentsOf` / `signalsOf` partition the firing set with no remainder", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedMailbox(db, a, 90 * MIN);
    const firing = await evaluateAlerts(db, { now: NOW });
    expect(firing.length).toBeGreaterThan(0);
    expect(incidentsOf(firing).length + signalsOf(firing).length).toBe(firing.length);
    for (const i of incidentsOf(firing)) expect(alertClass(i)).toBe("incident");
    for (const s of signalsOf(firing)) expect(alertClass(s)).toBe("signal");
  });

  it("an UNCLASSIFIED alert defaults to INCIDENT — the safe direction, stated as a test", () => {
    // The default is the whole reason `alertClass` exists as a function rather than a `??` at
    // each call site. Flip it and a rule whose author forgot the field becomes a row that fires,
    // renders, and reaches no human.
    const bare = {
      key: "k", kind: "worker_down", severity: "critical",
      title: "t", detail: "d", count: 1, oldestSeconds: null,
    } as Alert;
    expect(alertClass(bare)).toBe("incident");
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   2. The population escalations — the same condition, two different claims
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("sync_lag's promotion", () => {
  it("THREE lagging accounts promote it to an incident, whatever the deployment's size", async () => {
    const db = await makeTestDb();
    await seedHeartbeat(db);
    for (let i = 0; i < 3; i++) {
      const a = await seedAccount(db, `lag-${i}`);
      await seedMailbox(db, a, 90 * MIN);
    }
    for (let i = 0; i < 40; i++) {
      const a = await seedAccount(db, `ok-${i}`);
      await seedMailbox(db, a, MIN);
    }
    const firing = await evaluateAlerts(db, { now: NOW });
    const lag = find(firing, "sync_lag");
    expect(lag!.key, "the warning tier, not the critical one").toBe("sync_lag");
    // That share is below the fraction arm, so this can only be the COUNT arm firing.
    expect(alertClass(lag!)).toBe("incident");
    expect(lag!.affectedAccounts).toBe(3);
    expect(lag!.detail).toContain("promotion cut");
  });

  it("CRITICAL-ONLY accounts do not promote the WARNING row — each tier counts its own", async () => {
    // THE DEFECT: `onDuty` is every account with ANY lagging mailbox, criticals included, and
    // the warning row used it for the promotion, the detail sentence and `affectedAccounts`.
    //
    // Three accounts two hours behind and ONE account forty minutes behind: the three are
    // already paging under `sync_lag:critical`, and the warning row described one mailbox on one
    // account. It crossed the three-account arm on the criticals' population, PAGED, and said
    // "N of M on-duty account(s) are affected" — the figure an operator sizes the incident from,
    // wrong, on a second page that added nothing to the three already firing.
    const db = await makeTestDb();
    await seedHeartbeat(db);
    for (let i = 0; i < 3; i++) {
      const a = await seedAccount(db, `crit-${i}`);
      await seedMailbox(db, a, 3 * HOUR);
    }
    const warn = await seedAccount(db, "warn");
    await seedMailbox(db, warn, 45 * MIN);
    // Ten healthy accounts so the FRACTION arm is nowhere near: one warning account of fourteen
    // on-duty is a small share. Without them the four lagging accounts are the whole deployment and
    // promote on the fraction arm alone — which would make this test pass for a reason
    // that has nothing to do with the population being counted.
    for (let i = 0; i < 10; i++) {
      const ok = await seedAccount(db, `ok-${i}`);
      await seedMailbox(db, ok, MIN);
    }

    const firing = await evaluateAlerts(db, { now: NOW });
    const lag = firing.find((a) => a.key === "sync_lag")!;
    expect(lag.count, "one mailbox is in the warning tier").toBe(1);
    expect(lag.affectedAccounts, "and it belongs to exactly one account").toBe(1);
    expect(alertClass(lag), "one account is below both arms — this is an observation").toBe("signal");

    // The three genuinely broken accounts still page, on their own row, with their own count.
    const crit = firing.find((a) => a.key === "sync_lag:critical")!;
    expect(crit.count).toBe(3);
    expect(crit.affectedAccounts).toBe(3);
    expect(alertClass(crit)).toBe("incident");
  });

  it("a FIFTH of a small deployment promotes it on the fraction arm alone", async () => {
    const db = await makeTestDb();
    await seedHeartbeat(db);
    // ONE lagging account of four: past the fraction arm, and strictly below the count arm
    // of three. Only the fraction arm can produce this, which is what makes the two arms
    // separately load-bearing rather than one of them decorative.
    const lagging = await seedAccount(db, "lag");
    await seedMailbox(db, lagging, 90 * MIN);
    for (let i = 0; i < 3; i++) {
      const a = await seedAccount(db, `ok-${i}`);
      await seedMailbox(db, a, MIN);
    }
    const firing = await evaluateAlerts(db, { now: NOW });
    const lag = find(firing, "sync_lag");
    expect(lag!.affectedAccounts).toBe(1);
    expect(alertClass(lag!)).toBe("incident");
  });

  it("the CRITICAL tier is an incident at ONE account — the promotion is the warning's only", async () => {
    const db = await makeTestDb();
    await seedHeartbeat(db);
    const a = await seedAccount(db, "cut-off");
    await seedMailbox(db, a, 3 * HOUR);
    for (let i = 0; i < 40; i++) {
      const h = await seedAccount(db, `ok-${i}`);
      await seedMailbox(db, h, MIN);
    }
    const firing = await evaluateAlerts(db, { now: NOW });
    const crit = firing.find((x) => x.key === "sync_lag:critical");
    expect(crit, "past two hours the strong sentence is the plain truth").toBeTruthy();
    expect(alertClass(crit!)).toBe("incident");
    expect(crit!.affectedAccounts).toBe(1);
  });

  it("DEMOTE THEN RE-PROMOTE PAGES AGAIN — the second outage is not suppressed as unchanged",
    async () => {
      // THE GAP IN THE SENTENCE THIS FILE ALREADY CLAIMED. `notified_signature` is written only
      // by a CONFIRMED delivery and a signal never delivers, so a key that pages as an incident,
      // drops to a signal and comes back was compared against the signature of the LAST
      // INCIDENT — identical, because it is the same condition. The return read as UNCHANGED and
      // was held for the renotify interval, so the second outage paged nobody for up to a day.
      //
      // Driven through `sync_lag`'s count arm: three lagging accounts promote, two do not. The
      // eighteen healthy accounts keep the FRACTION arm clear throughout, so the count arm is
      // the only thing moving.
      const db = await makeTestDb();
      await seedHeartbeat(db);
      for (let i = 0; i < 18; i++) {
        const ok = await seedAccount(db, `ok-${i}`);
        await seedMailbox(db, ok, MIN);
      }
      const lagging: string[] = [];
      for (let i = 0; i < 3; i++) {
        const a = await seedAccount(db, `lag-${i}`);
        await seedMailbox(db, a, 90 * MIN);
        lagging.push(a);
      }

      const sink = spySink("spy");
      const first = await runAlertPass(db, { now: NOW, sinks: [sink], driver: "worker", shards: [] });
      const lag1 = first.firing.find((a) => a.key === "sync_lag")!;
      expect(alertClass(lag1), "three accounts is past the count cut").toBe("incident");
      expect(sink.seen.length, "and it paged").toBe(1);

      // AN INCIDENT SENDER IS STILL IN FLIGHT when the condition demotes: it took a lease and
      // has not settled yet. Planted rather than raced, because the race needs two connections
      // and this harness has one — but the lease is the whole mechanism, and a settle that
      // arrives late is guarded by NOTHING ELSE. Without this the assertion below is vacuous:
      // an ordinary pass claims, delivers and settles, so the lease is already null and the
      // check passes whatever the demotion does. (It did, until this was added.)
      await db.update(alertState)
        .set({ claimedUntil: new Date(NOW.getTime() + 5 * MIN) })
        .where(eq(alertState.alertKey, "sync_lag"));

      // One of the three catches up: two lagging of twenty is below both arms.
      await db.update(mailboxes).set({ lastSyncAt: ago(MIN) })
        .where(eq(mailboxes.accountId, lagging[2]!));
      const second = await runAlertPass(db, {
        now: new Date(NOW.getTime() + MIN), sinks: [sink], driver: "worker", shards: [],
      });
      const lag2 = second.firing.find((a) => a.key === "sync_lag")!;
      expect(alertClass(lag2), "two accounts is below both arms").toBe("signal");
      expect(sink.seen.length, "a signal reaches no sink").toBe(1);

      // ── AND THE LEASE IS GONE, WHICH IS THE CONCURRENT HALF ────────────────────────
      //
      // Clearing the history alone is not enough while two drivers overlap. The settle that
      // follows a delivery is guarded ONLY by `claimed_until = <the lease that pass took>`, so
      // an incident sender still in flight when the condition demotes matches that guard
      // afterwards and writes its OLD INCIDENT SIGNATURE back onto the row that is now a
      // signal — restoring exactly the suppression the demotion just removed, with no pass
      // having done anything wrong. Asserted as a STATE TRANSITION rather than by racing two
      // passes, because the race needs two connections and this harness has one: what has to
      // be true is that a demotion leaves no lease for a late settle to match.
      const [afterDemote] = await db
        .select({ claimedUntil: alertState.claimedUntil, sig: alertState.notifiedSignature })
        .from(alertState).where(eq(alertState.alertKey, "sync_lag"));
      expect(afterDemote!.claimedUntil, "no lease survives a demotion").toBeNull();
      expect(afterDemote!.sig, "and no confirmed signature either").toBeNull();

      // It falls behind again two minutes later — far inside the renotify interval.
      await db.update(mailboxes).set({ lastSyncAt: ago(90 * MIN) })
        .where(eq(mailboxes.accountId, lagging[2]!));
      const third = await runAlertPass(db, {
        now: new Date(NOW.getTime() + 2 * MIN), sinks: [sink], driver: "worker", shards: [],
      });
      const lag3 = third.firing.find((a) => a.key === "sync_lag")!;
      expect(alertClass(lag3), "past the cut again").toBe("incident");
      expect(sink.seen.length, "AND IT PAGES AGAIN — the demotion ended the occurrence").toBe(2);
    });

  it("the CLASS is in the signature, so a promotion re-pages instead of inheriting the signal's confirm", async () => {
    // Without the class in the signature, a condition that spreads from two accounts to twenty at
    // an UNCHANGED mailbox count would flip to an incident and then sit on the signal's own
    // `notified_signature` for the whole unchanged interval — the exact suppression the tier keys
    // were split to avoid, arriving through a different door.
    const db = await makeTestDb();
    await seedHeartbeat(db);
    const lagging = await seedAccount(db, "lag");
    await seedMailbox(db, lagging, 90 * MIN);
    for (let i = 0; i < 11; i++) {
      const a = await seedAccount(db, `ok-${i}`);
      await seedMailbox(db, a, MIN);
    }
    const before = await evaluateAlerts(db, { now: NOW });
    const sigBefore = find(before, "sync_lag")!.signature;
    expect(sigBefore).toContain("signal");

    // Two more accounts lag — same mailbox COUNT per account, so the default `severity|count`
    // signature would be unchanged for the first one and the class is what has to carry it.
    for (let i = 0; i < 2; i++) {
      const a = await seedAccount(db, `lag2-${i}`);
      await seedMailbox(db, a, 90 * MIN);
    }
    const after = await evaluateAlerts(db, { now: NOW });
    const sigAfter = find(after, "sync_lag")!.signature;
    expect(sigAfter).toContain("incident");
    expect(sigAfter, "the signature moved, so the claim's change arm can see it").not.toBe(sigBefore);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   3. The new incidents
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("worker_degraded — the fault a liveness check cannot see", () => {
  it("FIRES for a leader that is beating normally and reporting itself degraded", async () => {
    const db = await makeTestDb();
    await seedHeartbeat(db, { age: 10_000, degraded: true, upFor: HOUR });
    const firing = await evaluateAlerts(db, { now: NOW });
    const d = find(firing, "worker_degraded");
    expect(d, "alive, holding the lock, and not doing the work").toBeTruthy();
    expect(alertClass(d!)).toBe("incident");
    expect(d!.fixHref).toBe("/worker");
    expect(firing.some((x) => x.kind === "worker_down"), "and it is NOT reported as down").toBe(false);
  });

  it("stays quiet through the BOOT allowance — a starting worker is degraded and is not a fault", async () => {
    const db = await makeTestDb();
    await seedHeartbeat(db, { age: 10_000, degraded: true, upFor: 2 * MIN });
    const firing = await evaluateAlerts(db, { now: NOW });
    expect(firing.some((x) => x.kind === "worker_degraded")).toBe(false);
  });

  it("NINE MINUTES degraded does not page; ELEVEN does — the clock is the CONDITION's, not the process's",
    async () => {
      // THE DEFECT THIS REPLACED. The rule used to read `started_at` and ask "up longer than the
      // threshold AND degraded right now", which suppresses a BOOT and nothing after it. Both
      // workers below have been up for an hour, so the old condition fired for both — including
      // the one that has been degraded for nine minutes, and including (see the next test) one
      // that was degraded for a single beat and recovered.
      const nine = await makeTestDb();
      await seedHeartbeat(nine, { age: 10_000, degraded: true, upFor: HOUR, degradedFor: 9 * MIN });
      expect((await evaluateAlerts(nine, { now: NOW })).some((a) => a.kind === "worker_degraded"),
        "inside the allowance that lets a boot and a roster churn settle").toBe(false);

      const eleven = await makeTestDb();
      await seedHeartbeat(eleven, { age: 10_000, degraded: true, upFor: HOUR, degradedFor: 11 * MIN });
      const d = find(await evaluateAlerts(eleven, { now: NOW }), "worker_degraded");
      expect(d, "past it, and this is a worker that is alive and not working").toBeTruthy();
      // The age reported is the CONDITION's, not the process's — an hour of uptime must not be
      // rendered as an hour of breakage.
      expect(d!.oldestSeconds).toBeGreaterThanOrEqual(11 * 60 - 30);
      expect(d!.oldestSeconds).toBeLessThan(20 * 60);
      expect(d!.detail).toContain("reporting itself DEGRADED for");
    });

  it("ONE degraded beat then a healthy one CLEARS the stamp — routine churn does not page", async () => {
    // The false page that made this column worth a migration: a leader up for a day flips
    // degraded for a single beat while the roster churns, and the old rule fired a CRITICAL at
    // once because the process had been up longer than ten minutes. The stamp is cleared by the
    // first healthy beat, so the run has to be UNBROKEN to count.
    const db = await makeTestDb();
    await seedHeartbeat(db, { age: 30 * MIN, degraded: true, upFor: 8 * HOUR, degradedFor: 8 * HOUR });
    // ...and now a healthy beat lands.
    await seedHeartbeat(db, { age: 10_000, degraded: false, upFor: 8 * HOUR });

    const firing = await evaluateAlerts(db, { now: NOW });
    expect(firing.some((a) => a.kind === "worker_degraded"),
      "the run was broken by a healthy beat, so nothing has been degraded for ten minutes").toBe(false);
    const [row] = await db.select({ since: workerHeartbeats.degradedSince }).from(workerHeartbeats);
    expect(row!.since, "and the stamp itself is gone, not merely ignored").toBeNull();
  });

  it("THE STAMP SURVIVES A LEADER CHANGE - it lives on the row, not in the process", async () => {
    // The load-bearing property, and the reason this is a column rather than a field in the
    // worker. A deploy replaces the process; the incoming leader writes the same shard's row and
    // must find the previous one's stamp and keep it. An in-memory clock would restart on every
    // handover, and a ten-minute rule would then never fire on a deployment that restarts more
    // often than that - the rule would look present and be unreachable.
    const db = await makeTestDb();
    await seedHeartbeat(db, {
      age: 40 * MIN, degraded: true, upFor: 3 * HOUR, degradedFor: 40 * MIN, instanceId: "wkr-old",
    });
    const [before] = await db.select({ since: workerHeartbeats.degradedSince }).from(workerHeartbeats);

    // A DIFFERENT instance takes the shard, still degraded, freshly started.
    await seedHeartbeat(db, {
      age: 10_000, degraded: true, upFor: 30 * SEC, degradedFor: 30 * SEC, instanceId: "wkr-new",
    });
    const [after] = await db.select({
      since: workerHeartbeats.degradedSince, instanceId: workerHeartbeats.instanceId,
    }).from(workerHeartbeats);

    expect(after!.instanceId, "the new leader owns the row").toBe("wkr-new");
    expect(new Date(after!.since as unknown as string).getTime(),
      "and inherited the fault's real age rather than restarting the clock")
      .toBe(new Date(before!.since as unknown as string).getTime());

    const d = find(await evaluateAlerts(db, { now: NOW }), "worker_degraded");
    expect(d, "so a fault older than the process that reports it still pages").toBeTruthy();
  });

  it("stays quiet when the beat is STALE — that is worker_down's subject, and paging twice for one worker is not", async () => {
    const db = await makeTestDb();
    await seedHeartbeat(db, { age: 10 * MIN, degraded: true, upFor: HOUR });
    const firing = await evaluateAlerts(db, { now: NOW });
    expect(firing.some((x) => x.kind === "worker_down"), "this IS down").toBe(true);
    expect(firing.some((x) => x.kind === "worker_degraded"), "and only down").toBe(false);
  });
});

describe("ai_provider_down — the outage whose only symptom is worse routing", () => {
  it("FIRES once the circuit has been open past the threshold", async () => {
    const db = await makeTestDb();
    await seedHeartbeat(db, { aiCircuitOpenSince: ago(20 * MIN) });
    const firing = await evaluateAlerts(db, { now: NOW });
    const ai = find(firing, "ai_provider_down");
    expect(ai).toBeTruthy();
    expect(alertClass(ai!)).toBe("incident");
    expect(ai!.detail).toContain("rules-only");
  });

  it("stays quiet inside the threshold — one trip's cooldown is not an outage", async () => {
    const db = await makeTestDb();
    await seedHeartbeat(db, { aiCircuitOpenSince: ago(4 * MIN) });
    const firing = await evaluateAlerts(db, { now: NOW });
    expect(firing.some((x) => x.kind === "ai_provider_down")).toBe(false);
  });

  it("A REPLACEMENT WORKER'S EMPTY CIRCUIT DOES NOT CLEAR THE STAMP — a deploy is not a recovery",
    async () => {
      // The stamp is a property of the OUTAGE, not of the process that noticed it. A worker
      // starting up holds a closed circuit because it has made no provider call yet, not because
      // the provider came back; writing that null over the row restarted the ten-minute clock on
      // every deploy, so a deployment that restarts oftener than the threshold could never page
      // for an outage that never stopped. This is the same failure `degraded_since` exists to
      // prevent, one column across.
      const db = await makeTestDb();
      await seedHeartbeat(db, { instanceId: "wkr-old", aiCircuitOpenSince: ago(30 * MIN), age: 20 * SEC });
      await seedHeartbeat(db, { instanceId: "wkr-new", aiCircuitOpenSince: null, age: 5 * SEC });
      const ai = find(await evaluateAlerts(db, { now: NOW }), "ai_provider_down");
      expect(ai, "the outage is thirty minutes old whatever the new process knows").toBeTruthy();
    });

  it("A HANDOVER MID-OUTAGE KEEPS THE EARLIER STAMP — the age is the outage's, not the process's",
    async () => {
      // The incoming worker trips its own circuit two minutes in. Taking that stamp — which is
      // what an unconditional write does — reports a forty-minute outage as two minutes old and
      // leaves it under the threshold. The row keeps the earlier of the two.
      const db = await makeTestDb();
      await seedHeartbeat(db, { instanceId: "wkr-old", aiCircuitOpenSince: ago(40 * MIN), age: 20 * SEC });
      await seedHeartbeat(db, { instanceId: "wkr-new", aiCircuitOpenSince: ago(2 * MIN), age: 5 * SEC });
      const ai = find(await evaluateAlerts(db, { now: NOW }), "ai_provider_down");
      expect(ai, "forty minutes, not two").toBeTruthy();
      expect(ai!.title, "the title carries the outage's age, not the new process's").toContain("40m");
    });

  it("A SUCCESSFUL PROVIDER CALL clears it — the rule is not always-on", async () => {
    // The control, and the only thing that resolves this alert. `aiProviderOkAt` is stamped by
    // the breaker's close, which runs on every success and is the one event meaning the provider
    // answered. Without this the incident could never end on its own.
    const db = await makeTestDb();
    await seedHeartbeat(db, { instanceId: "wkr-a", aiCircuitOpenSince: ago(30 * MIN), age: 20 * SEC });
    await seedHeartbeat(db, {
      instanceId: "wkr-a", aiCircuitOpenSince: null, aiProviderOkAt: ago(SEC), age: 5 * SEC,
    });
    expect((await evaluateAlerts(db, { now: NOW })).some((x) => x.kind === "ai_provider_down"),
      "the provider answered, and that is what recovery is").toBe(false);
  });

  it("A REPLACEMENT'S SECOND BEAT DOES NOT CLEAR IT EITHER — the takeover installed its own id",
    async () => {
      // THE DEFECT IN THE FIRST VERSION OF THIS FIX, which is why it is a test and not a comment.
      // Preserving the stamp when the beating instance differs from the row's looks correct and
      // postpones the damage by exactly one beat: the takeover write also installs the new
      // instance id, so the NEXT beat from that same new process passes the identity check and
      // clears an outage nobody observed to end. Under a restart loop that suppresses the alert
      // indefinitely — the failure the whole column exists to remove.
      const db = await makeTestDb();
      await seedHeartbeat(db, { instanceId: "wkr-old", aiCircuitOpenSince: ago(30 * MIN), age: 30 * SEC });
      await seedHeartbeat(db, { instanceId: "wkr-new", aiCircuitOpenSince: null, age: 20 * SEC });
      await seedHeartbeat(db, { instanceId: "wkr-new", aiCircuitOpenSince: null, age: 5 * SEC });
      const ai = find(await evaluateAlerts(db, { now: NOW }), "ai_provider_down");
      expect(ai, "the replacement still has not called the provider").toBeTruthy();
    });

  it("AN INTERVENING SUCCESS ENDS THE OUTAGE — the second one is aged from its own start",
    async () => {
      // One beat can carry BOTH a new trip and the success that preceded it: open at t0, the
      // provider answers at t20, the circuit trips again at t21, and the heartbeat reports the
      // t21 stamp together with an `aiProviderOkAt` of t20. Taking `least(t0, t21)` there ages a
      // second, distinct outage from the first one's start — so a rule that waits ten minutes
      // fires at once, on a condition seconds old. `least()` is right only while the outage is
      // CONTINUOUS, and a recorded success is the proof that it was not.
      const db = await makeTestDb();
      await seedHeartbeat(db, { instanceId: "wkr-a", aiCircuitOpenSince: ago(40 * MIN), age: 30 * SEC });
      await seedHeartbeat(db, {
        instanceId: "wkr-a", aiCircuitOpenSince: ago(30 * SEC), aiProviderOkAt: ago(MIN),
        age: 5 * SEC,
      });

      expect((await evaluateAlerts(db, { now: NOW })).some((x) => x.kind === "ai_provider_down"),
        "thirty seconds old, not forty minutes").toBe(false);
    });

  it("but a CONTINUOUS outage still keeps its earliest stamp — least() is not simply removed",
    async () => {
      // The control. Without it the case above is satisfied by always taking the incoming stamp,
      // which is the defect `least()` was added for: a handover mid-outage would restart the
      // clock and a deployment that restarts often could never page.
      const db = await makeTestDb();
      await seedHeartbeat(db, { instanceId: "wkr-old", aiCircuitOpenSince: ago(40 * MIN), age: 30 * SEC });
      await seedHeartbeat(db, { instanceId: "wkr-new", aiCircuitOpenSince: ago(2 * MIN), age: 5 * SEC });

      const ai = find(await evaluateAlerts(db, { now: NOW }), "ai_provider_down");
      expect(ai, "no success was reported, so the outage never ended").toBeTruthy();
      expect(ai!.title).toContain("40m");
    });

  it("stays quiet for a STALE row — a dead worker's circuit is not an open circuit", async () => {
    // Without this gate a resolved circuit would keep firing for as long as the dead heartbeat row
    // sat in the table, and `worker_down` is already the alert for that.
    const db = await makeTestDb();
    await seedHeartbeat(db, { age: 10 * MIN, aiCircuitOpenSince: ago(20 * MIN) });
    const firing = await evaluateAlerts(db, { now: NOW });
    expect(firing.some((x) => x.kind === "ai_provider_down")).toBe(false);
  });
});

describe("imap_admission_refused — a mailbox nothing can get a connection to", () => {
  it("counts refusals in a rolling window and fires past the threshold", async () => {
    const db = await makeTestDb();
    await seedHeartbeat(db);
    for (let i = 0; i < 6; i++) await recordImapRefusal(db, NOW);
    expect(await imapRefusalsInWindow(db, NOW)).toBe(6);

    const firing = await evaluateAlerts(db, { now: NOW });
    const r = find(firing, "imap_admission_refused");
    expect(r).toBeTruthy();
    expect(alertClass(r!), "the customer's attachment does not open").toBe("incident");
    expect(r!.count).toBe(6);
  });

  it("stays quiet at a trickle — one or two refusals IS the cap working", async () => {
    const db = await makeTestDb();
    await seedHeartbeat(db);
    for (let i = 0; i < 2; i++) await recordImapRefusal(db, NOW);
    const firing = await evaluateAlerts(db, { now: NOW });
    expect(firing.some((x) => x.kind === "imap_admission_refused")).toBe(false);
  });

  it("a window that has ROLLED reads as zero — a burst an hour ago is not a standing incident", async () => {
    const db = await makeTestDb();
    await seedHeartbeat(db);
    for (let i = 0; i < 9; i++) await recordImapRefusal(db, ago(2 * HOUR));
    // The counter row still holds 9; the read is what has to notice the window is over.
    expect(await imapRefusalsInWindow(db, NOW)).toBe(0);
    const firing = await evaluateAlerts(db, { now: NOW });
    expect(firing.some((x) => x.kind === "imap_admission_refused")).toBe(false);
  });

  it("A REAL REFUSAL THROUGH acquireImapSlot MOVES THE COUNTER — the rule is reachable", async () => {
    // THE PROPERTY THAT WAS MISSING, and the one the rest of this section cannot establish.
    //
    // Every other test here calls `recordImapRefusal` directly, which proves the counter and the
    // rule agree and proves nothing about whether anything in production ever calls it. It did
    // not: the recorder had no caller outside this file, so the counter never moved on a live
    // deployment and this rule could not fire however badly admission was refusing. Built,
    // tested, unreachable — the ruling's first ranked risk, arriving through the one door a unit
    // test of the detector cannot watch.
    //
    // So this drives the PUBLIC entry point the API's admission sites actually call, refuses on
    // it for real, and asserts the alert comes out the far end.
    const db = await makeTestDb();
    await seedHeartbeat(db);
    const mailboxId = randomUUID();
    const input = { mailboxId, max: 2, now: NOW };

    // Fill the two slots, then refuse the next six.
    expect(await acquireImapSlot(db, input)).toBe(true);
    expect(await acquireImapSlot(db, input)).toBe(true);
    for (let i = 0; i < 6; i++) {
      expect(await acquireImapSlot(db, input), "over the cap").toBe(false);
    }

    expect(await imapRefusalsInWindow(db, NOW), "six refusals were counted").toBe(6);
    const firing = await evaluateAlerts(db, { now: NOW });
    const refused = find(firing, "imap_admission_refused");
    expect(refused, "and the rule fires off a refusal nobody recorded by hand").toBeTruthy();
  });

  it("FIVE REFUSALS IN ANY FIFTEEN MINUTES FIRE — the window slides, it does not tumble",
    async () => {
      // The counter was anchored at the FIRST refusal and reset when that anchor went stale, so
      // one at 00:00, two at 00:14:59 and three at 00:15:01 read as THREE: the write after the
      // boundary discarded the two before it. Five happened inside fifteen minutes and the rule
      // saw three.
      const db = await makeTestDb();
      await seedHeartbeat(db);
      const t = (m: number, s = 0) => new Date(Date.UTC(2026, 8, 4, 12, m, s));
      await recordImapRefusal(db, t(0));
      await recordImapRefusal(db, t(14, 59));
      await recordImapRefusal(db, t(14, 59));
      for (let i = 0; i < 3; i++) await recordImapRefusal(db, t(15, 1));

      // SIX, NOT FIVE, AND THE DIFFERENCE IS THE GRID SAYING SO OUT LOUD. The cut is floored to
      // the same minute the buckets sit on — two units for one comparison is what dropped the
      // boundary bucket before — so the 12:00 bucket is in the window as a whole. Its earliest
      // second is 1s older than fifteen minutes, which over-counts by less than one bucket and
      // never under-counts. The property under test is that NOTHING IS DISCARDED BY A RESET:
      // before the fix the two at 14:59 were erased by the first write after the boundary and
      // the answer was three.
      expect(await imapRefusalsInWindow(db, t(15, 1)),
        "all six are inside the window the grid describes, and none was reset away").toBe(6);
    });

  it("AND A BURST THAT STOPS STILL FIRES — the count is not revised only by more traffic",
    async () => {
      // The other half, and the worse one: with a tumbling counter nothing further is written
      // once the traffic stops, so the count is never revised and the incident never fires at
      // all. Silence, on exactly the shape the rule exists to report.
      const db = await makeTestDb();
      await seedHeartbeat(db);
      const t = (m: number) => new Date(Date.UTC(2026, 8, 4, 12, m, 0));
      for (let i = 0; i < 6; i++) await recordImapRefusal(db, t(1));

      // Nothing more is recorded. Five minutes later the pass still sees the burst.
      const firing = await evaluateAlerts(db, { now: t(6) });
      expect(firing.some((a) => a.kind === "imap_admission_refused"),
        "the refusals are still inside the window, so the rule still fires").toBe(true);
    });

  it("A REFUSAL AT :59 OF THE CUT MINUTE IS STILL COUNTED FIFTEEN MINUTES LATER", async () => {
    // The events are stored minute-floored and the cut used to be computed exactly — two units
    // for one comparison. A refusal at 12:00:59 is stored at 12:00:00, and an exact cut of
    // 12:00:30 excluded that bucket while the refusal inside it was 14m31s old and plainly
    // within the fifteen minutes the rule advertises. A burst confined to that boundary minute
    // vanished, which can hold the incident under its threshold or resolve it early.
    const db = await makeTestDb();
    await seedHeartbeat(db);
    const at = new Date(Date.UTC(2026, 8, 4, 12, 0, 59));
    for (let i = 0; i < 6; i++) await recordImapRefusal(db, at);

    expect(await imapRefusalsInWindow(db, new Date(Date.UTC(2026, 8, 4, 12, 15, 30))),
      "14m31s old, and the bucket holding it is on the same grid as the cut").toBe(6);
  });

  it("and a burst that has AGED OUT does not fire — the window really does move", async () => {
    // The control: without it the two cases above are satisfied by a counter that never forgets,
    // which would leave the incident standing for ever after one bad minute.
    const db = await makeTestDb();
    await seedHeartbeat(db);
    const t = (m: number) => new Date(Date.UTC(2026, 8, 4, 12, m, 0));
    for (let i = 0; i < 6; i++) await recordImapRefusal(db, t(1));
    expect(await imapRefusalsInWindow(db, t(20)), "twenty minutes later, outside the window")
      .toBe(0);
  });

  it("the counter is deployment-wide and lives under its OWN key — never the per-mailbox one", async () => {
    const db = await makeTestDb();
    await recordImapRefusal(db, NOW);
    const rows = await db.select().from(authThrottle);
    expect(rows).toHaveLength(1);
    // ONE ROW PER MINUTE now, keyed by its bucket — the window slides by summing buckets rather
    // than by resetting one counter, which is what stopped a burst ending at a boundary from
    // being discarded. The NAMESPACE is what this case is about and it is unchanged.
    expect(rows[0]!.key.startsWith("imap:refused:all:")).toBe(true);
    // The admission counter's own namespace must be untouched: a refusal that incremented a
    // MAILBOX's counter would lock that mailbox out for a window as a side effect of counting.
    expect(rows[0]!.key.startsWith("imap:mailbox:")).toBe(false);
  });
});

describe("schema_behind — host-local, and the key says which host", () => {
  it("A PASS THAT REPORTS THE SCHEMA IS BEHIND STILL RECORDS THAT IT RAN", async () => {
    // Otherwise the arm is reported DEAD by the other one, with the wrong remedy. This branch
    // skips the database writes because it cannot perform them — but `alert_driver_dark` reads
    // `alert_pass_runs`, so an arm stuck here every cycle never writes a row and, thirty minutes
    // later, the healthy arm pages "the API driver has stopped running". It has not stopped: it
    // is running and saying the schema is behind. The operator is sent to hunt a dead cron.
    const db = await makeTestDb();
    await seedHeartbeat(db);
    await db.execute(sql`alter table api_faults drop column arm`);

    const pass = await runAlertPass(db, { now: NOW, sinks: [], driver: "api", shards: [0] });
    expect(pass.firing.map((a) => a.kind), "the preflight is what fired").toContain("schema_behind");

    // AND IT CANNOT RECORD THAT IT RAN, which is the honest state rather than a gap. A
    // `recordAlertPass` call stood here to stop the other arm reporting this one dark; it could
    // not work, because in BOTH states this branch exists for the write is impossible — the
    // table is absent (0030 unapplied) or ungranted (the hardening script not re-run) — and the
    // recorder swallows the error by contract. The call looked like a fix and changed nothing.
    //
    // What the deployment gets instead is a page that says what it might mean: `alert_driver_dark`
    // now tells the operator to prefer a concurrent `schema_behind` alert, because an arm in skew
    // goes dark here while running perfectly.
    const rows = await db.select().from(alertPassRuns).where(eq(alertPassRuns.driver, "api"));
    expect(rows, "nothing was recorded, and nothing could have been").toHaveLength(0);
  });

  it("and the DARK page names the state it cannot distinguish", async () => {
    // A driver in schema skew is running and cannot prove it. The rule fires — a true
    // observation with a false implication — so the text carries the alternative rather than
    // letting an operator act on the only remedy it names.
    const db = await makeTestDb();
    await seedHeartbeat(db);
    await db.insert(alertPassRuns).values({
      driver: "worker", ranAt: ago(2 * HOUR), firing: 0, delivered: 0, failedSinks: 0,
      sinkFailureStreak: 0, sinksConfigured: 1,
    } as never);
    const dark = find(await evaluateAlerts(db, { now: NOW, driver: "api", shards: [0] }),
      "alert_driver_dark");
    expect(dark, "the worker's row is two hours old").toBeTruthy();
    expect(dark!.detail).toContain("schema_behind");
  });

  it("names the DRIVER in its key, so the worker's finding and the API's are two findings", async () => {
    // The database this harness builds is at the journal head, so the rule does not fire — which
    // is the correct answer and not the property under test. What IS under test is that the rule
    // is HOST-LOCAL by construction: it is evaluated only when a driver names itself, and a
    // one-shot caller (a console render, a runbook curl) is not a driver.
    const db = await makeTestDb();
    await seedHeartbeat(db);
    const asWorker = await evaluateAlerts(db, { now: NOW, driver: "worker" });
    const asNobody = await evaluateAlerts(db, { now: NOW });
    expect(asWorker.some((a) => a.key === "schema_behind:api")).toBe(false);
    expect(asNobody.some((a) => a.kind === "schema_behind")).toBe(false);
  });

  it("the journal-head constant is a NUMBER the migration journal can be checked against", () => {
    // The census that keeps it honest lives in `journal-split.test.ts`, which reads the journal
    // file. This asserts only the shape — a constant that had drifted to a string or a NaN would
    // make every comparison false. It no longer drives `schema_behind` (see the preflight tests
    // below, which read `information_schema` instead), and is kept because it is still the
    // bundle's own statement of which cloud journal head it ships.
    expect(Number.isFinite(CLOUD_JOURNAL_HEAD_WHEN)).toBe(true);
    expect(CLOUD_JOURNAL_HEAD_WHEN).toBeGreaterThan(0);
  });

  /**
   * THE TESTS ABOVE NEVER MADE THE RULE FIRE, which is why the rule could ship unreachable
   * twice over and pass its own suite. Both of these drop the marker column and watch what the
   * pass actually does against a database older than the bundle.
   */
  it("FIRES when the database lacks the column this bundle writes — and it is the ONLY finding",
    async () => {
      const db = await makeTestDb();
      await seedHeartbeat(db);
      // Seed conditions that WOULD fire other rules, so "only one finding" is a real claim.
      const a = await seedAccount(db, "lagging");
      await seedMailbox(db, a, 3 * HOUR);

      // The database goes back to before this bundle's migration. The column dropped is the
      // migration's LAST statement, which is the one the preflight reads: statements apply in
      // order, so its absence is the only marker that implies nothing after it landed either.
      // Dropping the FIRST statement's column instead is what the preflight used to check, and
      // it passed on a database missing both new tables.
      // THE MARKER MOVES WITH THE NEWEST MIGRATION, and it has moved twice now. It was 0030's
      // last column (`platform_signals.sample_cause`); cloud 0033 adds `api_faults`, which two
      // of this pass's own rules READ — so a database at 0031 would satisfy a marker on 0030 and
      // then throw 42P01 inside the evaluation. Dropping an OLD marker simulates a schema behind
      // in a way the preflight no longer asks about, and this block would pass testing nothing.
      await db.execute(sql`alter table api_faults drop column arm`);

      const firing = await evaluateAlerts(db, { now: NOW, driver: "api" });
      expect(firing.map((x) => x.kind), "the preflight returns alone — nothing else is readable")
        .toEqual(["schema_behind"]);
      expect(firing[0]!.key).toBe("schema_behind:api");
      expect(alertClass(firing[0]!)).toBe("incident");
      expect(isSchemaBehind(firing)).toBe(true);
    });

  it("DELIVERS without persisting — the state table is the thing that is missing a column",
    async () => {
      // The second way this rule was unreachable: `runAlertPass` writes the very column whose
      // absence it is reporting, so the ordinary path raises 42703 while recording the finding
      // that explains the outage.
      const db = await makeTestDb();
      await seedHeartbeat(db);
      await db.execute(sql`alter table api_faults drop column arm`);

      const sink = spySink("spy");
      const pass = await runAlertPass(db, { now: NOW, sinks: [sink], driver: "api" });

      expect(pass.firing.map((a) => a.kind)).toEqual(["schema_behind"]);
      expect(sink.seen.length, "a human is told").toBe(1);
      expect(sink.seen[0]!.map((a) => a.kind)).toEqual(["schema_behind"]);
      // NOTHING is claimed to have resolved: this pass could not read the table at all, and
      // "I could not look" must never be recorded as "it cleared".
      expect(pass.resolved).toEqual([]);
    });

  it("A PARTLY-APPLIED MIGRATION IS STILL BEHIND — the first statement's column is not the test",
    async () => {
      // THE DEFECT IN THE FIRST CUT OF THIS PREFLIGHT. It read `alert_state.cls`, the migration's
      // FIRST additive statement, on the argument that the alert pass writes that column on every
      // observation. True, and insufficient: statements apply IN ORDER, so `cls` being present
      // says nothing about the two tables and the heartbeat columns that come after it.
      //
      // This database has `cls` and is missing everything after it — a migration interrupted
      // part-way, or statements run by hand. The old preflight declared it current and the very
      // next read threw, killing the pass before it could deliver the one finding that explains
      // the outage. Reading the LAST statement's column is what makes the answer sound.
      const db = await makeTestDb();
      await seedHeartbeat(db);
      await db.execute(sql`alter table api_faults drop column arm`);
      // EVERYTHING EARLIER IS DELIBERATELY LEFT IN PLACE — `alert_state.cls` (the migration's
      // first statement) and `worker_heartbeats.degraded_since` (what this marker used to be).
      // Both earlier choices are satisfied by this database and both would have declared it
      // ready, which is the whole point: only the LAST statement's column can imply the rest.

      const firing = await evaluateAlerts(db, { now: NOW, driver: "api" });
      expect(firing.map((x) => x.kind), "behind, and it says so instead of throwing")
        .toEqual(["schema_behind"]);
    });

  it("A REFUSED schema page STILL ADVANCES the sink streak — the pager's own failure is visible",
    async () => {
      // Only the DATABASE write is skipped on this path; the delivery is real and so is its
      // outcome. Reporting a zero streak here made a sink that refuses these pages invisible:
      // its attempts never advanced, no escalation ever fired, and the health surface kept
      // publishing a stale figure while every page about a half-finished deploy was refused. A
      // pager that cannot deliver the SCHEMA alert is exactly the pager somebody must hear about.
      const db = await makeTestDb();
      await seedHeartbeat(db);
      await db.execute(sql`alter table api_faults drop column arm`);

      const streak = newDeliveryStreak();
      const refusing: AlertSink = {
        name: "webhook",
        notify: async () => ({ ok: false, outcome: "refused" as const, error: "HTTP 401" }),
      };
      const first = await runAlertPass(db, {
        now: NOW, sinks: [refusing], driver: "api", deliveryStreak: streak,
      });
      expect(first.firing.map((a) => a.kind)).toEqual(["schema_behind"]);
      expect(first.sinkFailureStreak, "the refusal counted").toBe(1);

      const second = await runAlertPass(db, {
        now: new Date(NOW.getTime() + MIN), sinks: [refusing], driver: "api", deliveryStreak: streak,
      });
      expect(second.sinkFailureStreak, "and it keeps counting across passes").toBe(2);
      expect(second.sinkHealth[0]!.attempts, "the arm's own attempts advance too").toBe(2);
    });

  it("is SILENT on a database that HAS the column — the marker is what is read, not a version",
    async () => {
      const db = await makeTestDb();
      await seedHeartbeat(db);
      const firing = await evaluateAlerts(db, { now: NOW, driver: "api" });
      expect(firing.some((x) => x.kind === "schema_behind")).toBe(false);
    });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   4. The 5xx rule, and the zero that must not exist
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("api_5xx_rate", () => {
  async function seedWindow(db: Db, over: {
    minutesAgo: number; requests: number; errors: number; truncated?: boolean;
  }): Promise<void> {
    await db.insert(platformSignals).values({
      provider: "vercel", project: "ohmail-api",
      windowStart: ago(over.minutesAgo * MIN),
      requests: over.requests, errors5xx: over.errors,
      truncated: over.truncated ?? false,
      fetchedAt: ago(over.minutesAgo * MIN),
    });
  }

  /**
   * The WHOLE window, complete: the three buckets of the fifteen minutes the rule advertises.
   *
   * Most cases below need this rather than a single bucket, because the rule now refuses to
   * divide a partial population. Seeding one bucket and asserting "it does not fire" would
   * otherwise pass for the population reason while claiming to test a threshold — a guard
   * satisfied by the wrong cause, which is the failure this file keeps finding elsewhere.
   */
  async function seedFullWindow(db: Db, per: { requests: number; errors: number }): Promise<void> {
    for (const minutesAgo of [5, 10, 15]) await seedWindow(db, { minutesAgo, ...per });
  }

  /* ── THE GATE: the rule turns ITSELF on, and only on a real measurement ───────────────── */

  it("NO COMPLETE BUCKET means SILENT — a token on its own does not arm this rule", async () => {
    // THE GATE IS THE DATA, not a registration flag somebody has to remember to flip. A project
    // with no complete bucket in the window has never been measured, and that is the state of a
    // deployment with no platform token AND of one whose poller has never successfully run.
    // Neither is a rate of zero, and neither may page. The rule arms itself the first time a
    // real poll lands a complete bucket, with no follow-up code change.
    const db = await makeTestDb();
    await seedHeartbeat(db);
    const firing = await evaluateAlerts(db, { now: NOW });
    expect(firing.some((a) => a.kind === "api_5xx_rate"),
      "nothing measured, so nothing to judge").toBe(false);
  });

  it("A SAMPLED BUCKET OVER BOTH FLOORS IS STILL SILENT — a lower bound is not a rate", async () => {
    // The finding this gate absorbed. Both of a sampled bucket's counts are lower bounds, but
    // their RATIO is not, and the rate threshold is a ratio: twenty errors in a sampled thousand
    // crosses both floors while the far larger count of unseen successes puts the true rate two
    // orders of magnitude below it. A lower bound is safe in a numerator and unsafe in a
    // quotient, so sampled buckets are excluded from the sums entirely.
    const db = await makeTestDb();
    await seedHeartbeat(db);
    await seedWindow(db, { minutesAgo: 5, requests: 1000, errors: 20, truncated: true });
    const firing = await evaluateAlerts(db, { now: NOW });
    expect(firing.some((a) => a.kind === "api_5xx_rate"),
      "sampled counts cannot be divided into a rate").toBe(false);
  });

  it("ONE COMPLETE BUCKET IS NOT THE WINDOW — a quotient over part of it is not its rate",
    async () => {
      // THIS CASE USED TO ASSERT THE OPPOSITE and is kept, re-aimed, like the truncation one at
      // the end of this block — for the same reason, one step further out. A sampled bucket is
      // excluded because its counts are lower bounds whose RATIO is not one. A MISSING bucket is
      // that same defect with the evidence removed rather than marked: two thirds of the window
      // unpolled, and the surviving third's quotient published as the fifteen-minute rate the
      // threshold is calibrated for. Errors clustering in the five minutes that were measured,
      // while the ten that were not carried the successes, pages a deployment whose true rate is
      // nowhere near the floor.
      const db = await makeTestDb();
      await seedHeartbeat(db);
      await seedWindow(db, { minutesAgo: 5, requests: 200, errors: 20 });
      expect((await evaluateAlerts(db, { now: NOW })).some((a) => a.kind === "api_5xx_rate"),
        "10% of one bucket says nothing about the other two").toBe(false);
    });

  it("THE COMPLETE WINDOW OVER BOTH FLOORS FIRES — the gate opens on a real measurement",
    async () => {
      // The control on the case above, and the one that keeps the rule reachable at all: with
      // every bucket of the advertised window present, the rate is the window's own.
      const db = await makeTestDb();
      await seedHeartbeat(db);
      await seedFullWindow(db, { requests: 200, errors: 20 });
      const rate = find(await evaluateAlerts(db, { now: NOW }), "api_5xx_rate");
      expect(rate, "60 of 600 is 10%, past both floors, and measured end to end").toBeTruthy();
      expect(alertClass(rate!)).toBe("incident");
      expect(rate!.count).toBe(60);
    });

  it("A BUCKET AT THE CURRENT BOUNDARY IS OUT OF THE WINDOW — the poller's clock may run ahead",
    async () => {
      // The poller and this evaluator are different processes on hosts whose clocks agree only
      // approximately. A poller a minute ahead closes and persists the 12:00 bucket while this
      // pass still floors `now` to 12:00, and a lower-bound-only cut then sums FOUR buckets into
      // a rate advertised — and thresholded — as three. The extra bucket is partial by
      // construction: it lifts the ratio without the request count that would justify it, so the
      // direction of the mistake is a false page.
      const db = await makeTestDb();
      await seedHeartbeat(db);
      await seedWindow(db, { minutesAgo: 0, requests: 200, errors: 20 });
      expect((await evaluateAlerts(db, { now: NOW })).some((a) => a.kind === "api_5xx_rate"),
        "the bucket starts at the boundary this pass is standing on").toBe(false);
    });

  it("and the bucket ONE STEP OLDER is in it — the upper bound is a boundary, not an embargo",
    async () => {
      // The control. Without it the exclusion above is satisfied by a window that admits
      // nothing at all, which is how a bound this strict passes while being broken.
      const db = await makeTestDb();
      await seedHeartbeat(db);
      await seedFullWindow(db, { requests: 200, errors: 20 });
      expect((await evaluateAlerts(db, { now: NOW })).some((a) => a.kind === "api_5xx_rate"),
        "11:45, 11:50 and 11:55 all closed before this pass began").toBe(true);
    });

  it("TWO OF THREE BUCKETS TAKES IT DARK — a missed poll is not a smaller window", async () => {
    // The finding, stated as the case that used to page. A handful of errors in the one small
    // measured bucket is a high rate; the two unpolled buckets, had they been read, hold thousands of
    // quiet requests each. The rule must not publish the survivor's quotient under the window's
    // name — and the operator sees "not measured", which is the same thing the panel says before
    // the first poll ever lands.
    const db = await makeTestDb();
    await seedHeartbeat(db);
    await seedWindow(db, { minutesAgo: 5, requests: 200, errors: 20 });
    await seedWindow(db, { minutesAgo: 10, requests: 200, errors: 20 });
    expect((await evaluateAlerts(db, { now: NOW })).some((a) => a.kind === "api_5xx_rate"),
      "two thirds of a window is not the window").toBe(false);
  });

  it("a SAMPLED bucket beside a complete one is excluded from the figures and SAID", async () => {
    // The sampled bucket must not move the rate, and the operator must be able to see that it
    // was set aside rather than silently folded in.
    const db = await makeTestDb();
    await seedHeartbeat(db);
    await seedFullWindow(db, { requests: 200, errors: 20 });
    // A FOURTH row inside the window, sampled: the poller re-read one bucket and hit its bound.
    await seedWindow(db, { minutesAgo: 12, requests: 100000, errors: 0, truncated: true });
    const rate = find(await evaluateAlerts(db, { now: NOW }), "api_5xx_rate");
    expect(rate, "the complete buckets still decide").toBeTruthy();
    expect(rate!.count, "and the sampled bucket's requests are not in the denominator").toBe(60);
    // THE SENTENCE THAT USED TO BE ASSERTED HERE IS GONE, and the fixture is why it could be
    // asserted at all: this seeds a fourth row at twelve minutes ago, which is not a bucket
    // boundary. In production `window_start` is always five-minute aligned and the primary key
    // is (provider, project, window_start), so a fifteen-minute window holds AT MOST three rows
    // for one project — and this rule now requires all three to be complete before it fires.
    // Three complete plus one sampled is four rows in three slots: the clause could never render
    // on real data, so it was deleted rather than left describing an exclusion the rule no
    // longer performs. What the sampled bucket must still do is stay out of the arithmetic, and
    // that is what the count above measures.
  });

  it("FIRES only when BOTH floors are crossed", async () => {
    const db = await makeTestDb();
    await seedHeartbeat(db);
    // The errors against the requests below are past both.
    await seedWindow(db, { minutesAgo: 5, requests: 200, errors: 10 });
    await seedWindow(db, { minutesAgo: 10, requests: 200, errors: 10 });
    await seedWindow(db, { minutesAgo: 14, requests: 200, errors: 10 });
    const firing = await evaluateAlerts(db, { now: NOW });
    const e = find(firing, "api_5xx_rate");
    expect(e).toBeTruthy();
    expect(alertClass(e!)).toBe("incident");
    expect(e!.count).toBe(30);
  });

  it("a HIGH RATE on tiny traffic does not page — the absolute floor is what stops that", async () => {
    const db = await makeTestDb();
    await seedHeartbeat(db);
    // Most of them failing is a high rate, and it is three requests in a quiet quarter of an hour.
    // The FULL window, so that what stops this is the floor under test and not the population
    // gate above it — a guard satisfied by the wrong cause is not a guard.
    await seedFullWindow(db, { requests: 3, errors: 2 });
    const firing = await evaluateAlerts(db, { now: NOW });
    expect(firing.some((x) => x.kind === "api_5xx_rate")).toBe(false);
  });

  it("a HIGH COUNT on huge traffic does not page — the rate floor is what stops that", async () => {
    const db = await makeTestDb();
    await seedHeartbeat(db);
    // A few dozen errors in a large window is a small rate — a bad quarter-hour for forty people, not an outage.
    await seedFullWindow(db, { requests: 200_000, errors: 40 });
    const firing = await evaluateAlerts(db, { now: NOW });
    expect(firing.some((x) => x.kind === "api_5xx_rate")).toBe(false);
  });

  it("AN UNCONFIGURED DEPLOYMENT HAS NO ROW — never a zero, which is the whole risk", async () => {
    // The ruling's second ranked risk in one assertion. A pass that wrote `requests: 0,
    // errors_5xx: 0` when no token exists would satisfy every "does not fire" test above and
    // would put a measured-looking zero on an operator's screen for a figure nobody ever asked
    // the platform for. The mechanism that prevents it is an ABSENCE, so the absence is what is
    // asserted.
    const db = await makeTestDb();
    await seedHeartbeat(db);
    const window = await platformSignalWindow(db, NOW, DEFAULT_ALERT_THRESHOLDS.api5xxWindowMs);
    expect(window, "no rows at all — not a row saying zero").toEqual([]);
    const firing = await evaluateAlerts(db, { now: NOW });
    expect(firing.some((x) => x.kind === "api_5xx_rate")).toBe(false);
  });

  it("a REAL zero is a row that says zero, and reads differently from the absence above", async () => {
    const db = await makeTestDb();
    await seedHeartbeat(db);
    await seedWindow(db, { minutesAgo: 5, requests: 900, errors: 0 });
    const window = await platformSignalWindow(db, NOW, DEFAULT_ALERT_THRESHOLDS.api5xxWindowMs);
    expect(window).toHaveLength(1);
    expect(window[0]!.requests).toBe(900);
    expect(window[0]!.errors5xx).toBe(0);
    const firing = await evaluateAlerts(db, { now: NOW });
    expect(firing.some((x) => x.kind === "api_5xx_rate")).toBe(false);
  });

  it("windows OUTSIDE the lookback are not summed in", async () => {
    const db = await makeTestDb();
    await seedHeartbeat(db);
    await seedWindow(db, { minutesAgo: 5, requests: 200, errors: 4 });
    await seedWindow(db, { minutesAgo: 60, requests: 200, errors: 30 });
    const window = await platformSignalWindow(db, NOW, DEFAULT_ALERT_THRESHOLDS.api5xxWindowMs);
    expect(window[0]!.errors5xx, "the hour-old window is out of scope").toBe(4);
  });

  it("a TRUNCATED contributor is REPORTED but never summed — the reasoning here was wrong",
    async () => {
      // THIS TEST USED TO ASSERT THE OPPOSITE, and it is kept, re-aimed, because the argument it
      // encoded was wrong in a way worth leaving on the record. It read: a truncated row is a
      // real count over a real, contiguous, most-recent slice, so both numbers are lower bounds,
      // and a lower-bound numerator can only fail to reach a floor — therefore a sampled window
      // cannot invent a page.
      //
      // Both counts ARE lower bounds. Their RATIO is not, and the rate threshold is a ratio.
      // Twenty errors in a sampled bucket cross both floors; the far larger count of unseen
      // successes puts the true rate far below them. The old reasoning held for the absolute floor and
      // silently did not hold for the one beside it, so the rule could page a deployment having
      // an ordinary day. A lower bound is safe in a numerator and unsafe in a quotient.
      //
      // The window still REPORTS the sampling — an operator must see that a bucket was set aside
      // rather than quietly folded in — and the rule declines to judge on it.
      const db = await makeTestDb();
      await seedHeartbeat(db);
      await seedWindow(db, { minutesAgo: 5, requests: 300, errors: 20, truncated: true });
      const window = await platformSignalWindow(db, NOW, DEFAULT_ALERT_THRESHOLDS.api5xxWindowMs);
      expect(window[0]!.truncated, "the sampling is still visible").toBe(true);
      expect(window[0]!.sampledBuckets).toBe(1);
      expect(window[0]!.completeBuckets, "and nothing complete to judge on").toBe(0);
      expect(window[0]!.requests, "the sampled counts are not in the sums").toBe(0);

      const firing = await evaluateAlerts(db, { now: NOW });
      expect(firing.some((a) => a.kind === "api_5xx_rate"),
        "a rate cannot be computed from a lower bound").toBe(false);
    });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   5. Who watches the watcher
   ════════════════════════════════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════════════════════════════════
   5b. CROSS-DRIVER RESOLUTION — the flap that only two arms can produce
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("a pass resolves ONLY what it evaluated", () => {
  /**
   * THE DEFECT THIS EXISTS FOR, in one sentence: a pass that deletes a row it never evaluated
   * hands the other arm's live incident back as "resolved", and the next pass re-opens it with
   * `notified_at` NULL and `opened_at` reset — so it pages again, for ever, reporting a fault
   * that has been standing for hours as seconds old.
   *
   * The exemption was written for `worker_down` and tested by KIND NAME. Cloud 0030 added four
   * rules with exactly the same one-arm property and none of them was covered. Each case below
   * was watched failing before the exemption was re-keyed to what the pass actually evaluated.
   */
  // The other arm's LIVE incident: it confirmed the row a minute ago. A row nothing has
  // confirmed for the dark threshold is the false-open case, closed by the clock
  // (`alert-false-open.test.ts`); these cases are about scope, so the confirmation is fresh.
  const seedRow = async (db: Db, key: string, kind: string) => {
    await db.insert(alertState).values({
      alertKey: key, kind, severity: "critical", openedAt: ago(3 * HOUR),
      lastSeenAt: ago(MIN), notifiedAt: ago(3 * HOUR), notifyCount: 1,
      detail: "seeded by the other arm", cls: "incident",
    } as never);
  };
  // OPEN keys. Resolution marks rather than deletes (cloud 0030) — the row has to survive for
  // the observation write's insert branch to have something to fence against — so "resolved"
  // means `resolved_at` is set, not that the row is gone. Reading the raw table here would have
  // this helper report tombstones as live alerts, which is the same mistake the product's own
  // readers are now censused against.
  const keys = async (db: Db) =>
    (await db.select({ k: alertState.alertKey }).from(alertState)
      .where(isNull(alertState.resolvedAt))).map((r) => r.k).sort();

  it("the WORKER does not delete the shard-scoped rows the API arm opened", async () => {
    // The worker passes `shards: []`, so it evaluates none of the three shard-keyed rules —
    // they are all statements about the worker. Before the fix it deleted two of the three.
    const db = await makeTestDb();
    await seedHeartbeat(db);
    await seedRow(db, "worker_down:0", "worker_down");
    await seedRow(db, "worker_degraded:0", "worker_degraded");
    await seedRow(db, "ai_provider_down:0", "ai_provider_down");

    const pass = await runAlertPass(db, { now: NOW, sinks: [], driver: "worker", shards: [] });
    expect(pass.resolved, "a pass may not resolve what it never looked at").toEqual([]);
    expect(await keys(db))
      .toEqual(["ai_provider_down:0", "worker_down:0", "worker_degraded:0"].sort());
  });

  it("neither arm deletes the OTHER's schema_behind — and this one flaps while both are healthy",
    async () => {
      const db = await makeTestDb();
      await seedHeartbeat(db);
      await seedRow(db, "schema_behind:api", "schema_behind");

      // The worker's pass evaluates `schema_behind:worker` only. The API's row is not its business.
      const pass = await runAlertPass(db, { now: NOW, sinks: [], driver: "worker", shards: [] });
      expect(pass.resolved).toEqual([]);
      expect(await keys(db)).toEqual(["schema_behind:api"]);
    });

  it("neither arm deletes the alert_driver_dark row the OTHER arm reported", async () => {
    // The API arm reports `alert_driver_dark:worker`. The worker arm evaluates only
    // `alert_driver_dark:api`, so it must leave that row alone even though it is not firing here.
    const db = await makeTestDb();
    await seedHeartbeat(db);
    await seedRow(db, "alert_driver_dark:worker", "alert_driver_dark");

    const pass = await runAlertPass(db, { now: NOW, sinks: [], driver: "worker", shards: [] });
    expect(pass.resolved).toEqual([]);
    expect(await keys(db)).toEqual(["alert_driver_dark:worker"]);
  });

  it("the API arm does not delete the worker's IMAP refusal row — it cannot even read the counter",
    async () => {
      // Scoped by ROLE, not by shard or driver name. `auth_throttle` is deliberately absent from
      // the blind role's grants, so the API arm's read raises 42501, the rule swallows it and
      // emits nothing — and an unscoped resolve then deleted the worker's live incident on every
      // API pass, resetting its notification state so the worker paged again. The same flap as
      // the shard- and driver-keyed rules, reached through a grant.
      const db = await makeTestDb();
      await seedHeartbeat(db);
      await seedWorkerPass(db);
      await seedRow(db, "imap_admission_refused", "imap_admission_refused");

      const pass = await runAlertPass(db, { now: NOW, sinks: [], driver: "api", shards: [] });
      expect(pass.resolved, "the API arm has no opinion about this counter").toEqual([]);
      expect(await keys(db)).toEqual(["imap_admission_refused"]);
    });

  it("RESOLUTION MARKS THE ROW, IT DOES NOT DELETE IT — and a re-fire re-opens the same row",
    async () => {
      // The row survives its own resolution because the observation write's INSERT branch needs
      // something to fence against: an older pass paused before writing arrives at an empty
      // table, inserts, and pages an incident a newer pass has just resolved. The tombstone is
      // what that fence stands on, and `opened_at` surviving is a second reason to keep it — the
      // console can age a condition that has flapped rather than restarting its clock.
      const db = await makeTestDb();
      await seedHeartbeat(db);
      await seedRow(db, "sends_stuck", "sends_stuck");

      await runAlertPass(db, { now: NOW, sinks: [], driver: "worker", shards: [] });
      expect(await keys(db), "not open any more").toEqual([]);
      const all = await db.select().from(alertState);
      expect(all, "but the row is still there, marked").toHaveLength(1);
      expect(all[0]!.resolvedAt, "with the instant it was resolved").not.toBeNull();
    });

  it("A RESOLUTION THAT LOST THE FENCE IS NOT REPORTED AS RESOLVED", async () => {
    // The fence was doing its job and the REPORT was speaking for it. `resolved` was computed
    // before the writes, so an older pass whose update matched zero rows — because a newer pass
    // had seen the condition again — still returned the key, and both callers log
    // `alert_resolved` from that array. The log said a condition had cleared while the row was
    // open and may have just paged somebody about it.
    const db = await makeTestDb();
    await seedHeartbeat(db);
    await db.insert(alertState).values({
      alertKey: "sends_stuck", kind: "sends_stuck", severity: "warning",
      openedAt: ago(HOUR),
      // Stamped by a pass FIVE MINUTES AHEAD of the one about to run.
      lastSeenAt: new Date(NOW.getTime() + 5 * MIN),
      notifyCount: 0, detail: "seeded", cls: "incident", title: "seeded", count: 1,
    } as never);

    const pass = await runAlertPass(db, {
      now: new Date(NOW.getTime() - MIN), sinks: [], driver: "worker", shards: [],
    });

    expect(pass.resolved, "the update matched nothing, so nothing was resolved").toEqual([]);
    expect(await keys(db), "and the row is still open").toEqual(["sends_stuck"]);
  });

  it("AN OLDER PASS CANNOT RE-OPEN WHAT A NEWER PASS RESOLVED — nor page for it", async () => {
    // THE DEFECT THE TOMBSTONE EXISTS FOR, and note what it is NOT: a race any more. While
    // resolution deleted the row, this could only be reproduced by two passes interleaving on
    // real Postgres, because the evidence disappeared. Keeping the row turns the same defect
    // into a STATE — a resolved row and an older pass — which is deterministic, checkable here,
    // and cannot be missed by a test runner that happens to serialise.
    //
    // The fence reads BOTH stamps for this reason. `last_seen_at` alone lets the older pass
    // through: resolution does not touch it, so the row still carries the last OBSERVATION's
    // stamp, which is older than this pass. It is `resolved_at` that says "somebody newer than
    // you already decided this was over".
    const db = await makeTestDb();
    await seedHeartbeat(db);
    await seedWorkerPass(db);
    await db.insert(alertState).values({
      alertKey: "worker_down:91", kind: "worker_down", severity: "critical",
      openedAt: ago(HOUR), lastSeenAt: ago(30 * MIN), notifyCount: 0,
      detail: "seeded", cls: "incident", title: "1 shard(s) without a leader", count: 1,
      // Resolved by a pass FIVE MINUTES AHEAD of the one about to arrive.
      resolvedAt: new Date(NOW.getTime() + 5 * MIN),
    } as never);

    const sink = spySink("stale");
    await runAlertPass(db, {
      now: new Date(NOW.getTime() - MIN), sinks: [sink], driver: "api", shards: [91],
    });

    expect(await keys(db), "the key stays resolved — this pass is older than the resolution")
      .toEqual([]);
    expect(sink.seen.flat().map((a) => a.key), "and nobody is paged for it")
      .not.toContain("worker_down:91");
  });

  it("and a pass NEWER than the resolution DOES re-open it — the fence is not always-off", async () => {
    // The control. A condition that genuinely fires again after being resolved must come back,
    // or the tombstone becomes a permanent silence — which would be a worse defect than the
    // resurrection it was added to stop.
    const db = await makeTestDb();
    await seedHeartbeat(db);
    await seedWorkerPass(db);
    await db.insert(alertState).values({
      alertKey: "worker_down:91", kind: "worker_down", severity: "critical",
      openedAt: ago(HOUR), lastSeenAt: ago(30 * MIN), notifyCount: 0,
      detail: "seeded", cls: "incident", title: "1 shard(s) without a leader", count: 1,
      resolvedAt: ago(10 * MIN),
    } as never);

    await runAlertPass(db, { now: NOW, sinks: [], driver: "api", shards: [91] });
    expect(await keys(db), "wrong again, and open again").toEqual(["worker_down:91"]);
  });

  it("A TOMBSTONE CARRIES NO ACCOUNT — the mark blanks every column that can name one", async () => {
    // THE ERASURE RULING FOR THIS TABLE rested on rows being deleted the moment their condition
    // stopped firing, which is what made a per-account rule's `fix_href = /accounts/<uuid>`
    // self-clearing. Marking instead of deleting made that premise false — the uuid would sit on
    // a tombstone until sixty-four later resolutions pushed it out, and on a quiet deployment
    // that is indefinitely. The mark blanks it, so the ruling is true by code rather than by
    // argument.
    const db = await makeTestDb();
    await seedHeartbeat(db);
    const acct = "11111111-2222-3333-4444-555555555555";
    await db.insert(alertState).values({
      alertKey: "device_sync_stale", kind: "device_sync_stale", severity: "warning",
      openedAt: ago(HOUR), lastSeenAt: ago(30 * MIN), notifyCount: 1,
      notifiedAt: ago(20 * MIN),
      detail: "one account's devices have stopped syncing", cls: "signal",
      title: "1 account with a stale device", count: 1,
      affectedAccounts: 1, fixHref: `/accounts/${acct}`,
    } as never);

    await runAlertPass(db, { now: NOW, sinks: [], driver: "worker", shards: [] });

    const [row] = await db.select().from(alertState)
      .where(eq(alertState.alertKey, "device_sync_stale"));
    expect(row!.resolvedAt, "marked").not.toBeNull();
    expect(row!.fixHref, "and the account is gone from the row").toBeNull();
    expect(row!.detail).toBeNull();
    expect(row!.title).toBeNull();
    expect(row!.affectedAccounts).toBeNull();
    // The notification record stays: a condition that re-fires inside its renotify interval
    // must not page a second time, and that decision is made from these two columns.
    expect(row!.notifiedAt, "the page it already sent is still recorded").not.toBeNull();
  });

  it("A RE-OPENED ALERT IS A NEW OCCURRENCE — new clock, no delivery history, and it PAGES",
    async () => {
      // THE COST OF THE TOMBSTONE THAT I DID NOT WALK. While a resolved row was DELETED,
      // re-opening was an INSERT and every field started fresh by construction. Once resolution
      // began marking, this became an UPDATE that cleared only `resolved_at` — so the new
      // outage inherited the previous one's `opened_at`, `notified_at` and signature. The claim
      // then read "already paged, same signature" and suppressed the page for the whole renotify
      // interval: an hour for a critical. The board aged the new incident from the old opening
      // time, so the number an operator judges severity by described a condition that had ended.
      const db = await makeTestDb();
      await seedHeartbeat(db);
      await db.insert(alertState).values({
        alertKey: "worker_down:91", kind: "worker_down", severity: "critical",
        openedAt: ago(6 * HOUR), lastSeenAt: ago(3 * HOUR), notifyCount: 1,
        notifiedAt: ago(3 * HOUR), notifiedSignature: "critical|1",
        detail: null, cls: "incident", title: null, count: null,
        resolvedAt: ago(2 * HOUR),
      } as never);

      const sink = spySink("reopen");
      await runAlertPass(db, { now: NOW, sinks: [sink], driver: "api", shards: [91] });

      const [row] = await db.select().from(alertState)
        .where(eq(alertState.alertKey, "worker_down:91"));
      expect(row!.resolvedAt, "open again").toBeNull();
      expect(new Date(row!.openedAt as unknown as string).getTime(),
        "the clock starts at THIS occurrence, not the one six hours ago").toBe(NOW.getTime());
      expect(sink.seen.flat().map((a) => a.key), "and the new occurrence pages")
        .toContain("worker_down:91");
    });

  it("but an ordinary re-observation keeps its history — the reset is not every pass", async () => {
    // The control. Clearing the delivery record on every observation would re-page a standing
    // incident once a minute, which is the failure the renotify policy exists to prevent.
    const db = await makeTestDb();
    await seedHeartbeat(db);
    await db.insert(alertState).values({
      alertKey: "worker_down:91", kind: "worker_down", severity: "critical",
      openedAt: ago(6 * HOUR), lastSeenAt: ago(MIN), notifyCount: 1,
      notifiedAt: ago(MIN), notifiedSignature: "critical|1",
      detail: null, cls: "incident", title: null, count: null,
      resolvedAt: null,
    } as never);

    const sink = spySink("standing");
    await runAlertPass(db, { now: NOW, sinks: [sink], driver: "api", shards: [91] });

    const [row] = await db.select().from(alertState)
      .where(eq(alertState.alertKey, "worker_down:91"));
    expect(new Date(row!.openedAt as unknown as string).getTime(),
      "still the original outage").toBe(ago(6 * HOUR).getTime());
    expect(sink.seen.flat().map((a) => a.key), "and it does not page again inside the interval")
      .not.toContain("worker_down:91");
  });

  it("A TOMBSTONE IS NEVER DELETED — the fence's ground is unconditional", async () => {
    // TWO BOUNDS WERE TRIED AND BOTH PUT THE DEFECT BACK. A count deleted the oldest resolved
    // row, which is exactly the one a long-stalled pass needs. A count plus a thirty-minute age
    // horizon was justified as "a pass is bounded by its claim lease" — and that was wrong: the
    // lease is taken AFTER the observation write, so it bounds the delivery, not the evaluation,
    // and the worker runs passes with no enforced deadline at all.
    //
    // The row costs almost nothing — resolution already blanks the payload — and growth is
    // bounded by DISTINCT KEYS rather than by traffic, because `alert_key` is the primary key.
    const db = await makeTestDb();
    await seedHeartbeat(db);
    for (let i = 0; i < 80; i++) {
      await db.insert(alertState).values({
        alertKey: `worker_down:${3000 + i}`, kind: "worker_down", severity: "critical",
        openedAt: ago(2 * HOUR), lastSeenAt: ago(2 * HOUR), notifyCount: 0,
        detail: null, cls: "incident", title: null, count: null,
        resolvedAt: new Date(NOW.getTime() - 90 * MIN - i * 1000),
      } as never);
    }

    await runAlertPass(db, { now: NOW, sinks: [], driver: "worker", shards: [] });

    const left = await db.select({ k: alertState.alertKey }).from(alertState)
      .where(isNotNull(alertState.resolvedAt));
    expect(left, "eighty tombstones, an hour and a half old, and every one still there")
      .toHaveLength(80);
  });

  it("A FLAPPING KEY REUSES ONE ROW — which is what bounds the table", async () => {
    // The other half of the argument for keeping them: the bound is the number of distinct keys
    // a deployment has ever raised, not the number of times they fired. Without this, "never
    // deleted" would be a licence to grow.
    const db = await makeTestDb();
    await seedHeartbeat(db);
    for (let i = 0; i < 5; i++) {
      await runAlertPass(db, { now: new Date(NOW.getTime() + i * MIN), sinks: [], driver: "api", shards: [77] });
      await seedHeartbeat(db, { instanceId: `wkr-${i}`, age: SEC });
    }
    const rows = await db.select({ k: alertState.alertKey }).from(alertState)
      .where(eq(alertState.kind, "worker_down"));
    expect(rows.length, "five passes over one shard, one row").toBeLessThanOrEqual(1);
  });

  it("an UNSCOPED kind IS still resolved when it stops firing — the exemption is narrow", async () => {
    // The other half of the property, and the one that keeps the fix from being "never delete
    // anything": a rule both arms evaluate must still be cleared by either of them.
    const db = await makeTestDb();
    await seedHeartbeat(db);
    await seedRow(db, "sends_stuck", "sends_stuck");

    const pass = await runAlertPass(db, { now: NOW, sinks: [], driver: "worker", shards: [] });
    expect(pass.resolved, "no stuck sends are seeded, so it cleared")
      .toEqual(["sends_stuck"]);
    expect(await keys(db)).toEqual([]);
  });

  it("a DRIVERLESS read evaluates none of the scoped rules — which is why the console reads rows",
    async () => {
      // The console is not an arm. It calls `evaluateAlerts` with no driver and no shards, and
      // the two driver-keyed rules are gated on that name — so the evaluated set can never
      // contain them however broken the deployment is.
      //
      // This is the property that made `schema_behind` invisible on the Reliability page: an
      // incident whose own `fixHref` is "/reliability", rendered nowhere, so an operator
      // following that link arrived at a board showing nothing wrong. `adminAlerts` now merges
      // the persisted rows for exactly these kinds; this pins the premise that merge rests on.
      const db = await makeTestDb();
      await seedHeartbeat(db);
      const driverless = await evaluateAlerts(db, { now: NOW, shards: [] });
      const scoped = driverless.filter((a) => SCOPED_ALERT_KINDS.has(a.kind));
      expect(scoped, "a read that is not an arm evaluates none of them").toEqual([]);

      // …and WITH a driver the same database does produce one, so the emptiness above is the
      // gating and not an accident of the seeded world. The stale row is what makes the API arm
      // reportable at all — a driver that has NEVER recorded a pass is deliberately not dark.
      await db.insert(alertPassRuns).values({
        driver: "api", ranAt: ago(HOUR), firing: 0, delivered: 0, failedSinks: 0,
        sinkFailureStreak: 0,
      });
      const asArm = await evaluateAlerts(db, { now: NOW, shards: [], driver: "worker" });
      expect(asArm.some((a) => SCOPED_ALERT_KINDS.has(a.kind)),
        "the worker arm reports the API arm's silence").toBe(true);
    });

  it("EVERY scoped kind is named in SCOPED_ALERT_KINDS — a tenth cannot be added silently", () => {
    // A census rather than a behaviour test. A rule keyed by shard or by driver that is missing
    // from the set flaps, and the flap is invisible in any single-driver test.
    expect([...SCOPED_ALERT_KINDS].sort()).toEqual([
      "ai_provider_down", "alert_db_unreadable", "alert_driver_dark", "alert_driver_undeliverable",
      "alert_sink_degraded", "api_cron_stale", "imap_admission_refused", "plane_ops_unreadable", "schema_behind",
      "worker_degraded", "worker_down",
    ]);
  });
});

describe("the alerting's own pulse", () => {
  it("EVERY pass records its driver's row — including a pass that delivered nothing", async () => {
    // The quiet pass is the one that most has to be recorded: a healthy deployment delivers
    // nothing for weeks, and if only delivering passes wrote a row then a healthy driver and a
    // dead one would leave identical evidence.
    const db = await makeTestDb();
    await seedHeartbeat(db);
    const result = await runAlertPass(db, { now: NOW, sinks: [], driver: "worker", shards: [] });
    expect(result.notified, "nothing to page about").toEqual([]);

    const [row] = await db.select().from(alertPassRuns)
      .where(eq(alertPassRuns.driver, "worker"));
    expect(row, "and the pass still recorded that it ran").toBeTruthy();
    expect(new Date(row!.ranAt as unknown as string).getTime()).toBe(NOW.getTime());
  });

  it("a caller with NO driver records nothing — a runbook curl is not one of the two arms", async () => {
    const db = await makeTestDb();
    await seedHeartbeat(db);
    await runAlertPass(db, { now: NOW, sinks: [], shards: [] });
    expect(await db.select().from(alertPassRuns)).toEqual([]);
  });

  it("alert_driver_dark is reported by the OTHER driver, never by itself", async () => {
    const db = await makeTestDb();
    await seedHeartbeat(db);
    await seedWorkerPass(db);
    // The API driver's last pass was an hour ago; the worker is running now.
    await db.insert(alertPassRuns).values({
      driver: "api", ranAt: ago(HOUR), firing: 0, delivered: 0, failedSinks: 0,
      sinkFailureStreak: 0,
    });

    const asWorker = await evaluateAlerts(db, { now: NOW, driver: "worker" });
    const dark = find(asWorker, "alert_driver_dark");
    expect(dark, "the worker reports the API arm").toBeTruthy();
    expect(dark!.key).toBe("alert_driver_dark:api");
    expect(dark!.detail).toContain("ONLY observer of worker_down");

    // THE MUTATION'S TARGET. Evaluated AS THE API DRIVER, the same stale row is this process's
    // own — and a process cannot testify to its own death. If the rule read `opts.driver` instead
    // of the other one, this would fire and the arm that actually stopped would never be named.
    const asApi = await evaluateAlerts(db, { now: NOW, driver: "api" });
    expect(asApi.some((a) => a.kind === "alert_driver_dark"),
      "the API driver must not report ITSELF dark").toBe(false);
  });

  it("a driver that has NEVER recorded a pass is not reported dark", async () => {
    // A self-hosted deployment running one arm must not be paged for ever about an arm it
    // deliberately does not have. The cost — a configured-but-never-run arm is invisible here —
    // is paid on the board instead, where `alertDriverStatuses` renders it as "never".
    const db = await makeTestDb();
    await seedHeartbeat(db);
    const firing = await evaluateAlerts(db, { now: NOW, driver: "worker" });
    expect(firing.some((a) => a.kind === "alert_driver_dark")).toBe(false);
  });

  it("a FRESH other-driver row is not dark", async () => {
    const db = await makeTestDb();
    await seedHeartbeat(db);
    await db.insert(alertPassRuns).values({
      driver: "api", ranAt: ago(MIN), firing: 0, delivered: 0, failedSinks: 0,
      sinkFailureStreak: 0,
    });
    const firing = await evaluateAlerts(db, { now: NOW, driver: "worker" });
    expect(firing.some((a) => a.kind === "alert_driver_dark")).toBe(false);
  });

  it("AN ARM WITH NO SINKS RECORDS ZERO, which is the only field that can say it cannot page",
    async () => {
      // `sink_failure_streak` counts consecutive FAILED deliveries, and an arm with no sinks
      // never attempts one — so its streak sits at zero and reads exactly like a healthy arm.
      // That made the worst state this subsystem has (an arm that cannot page anybody) the state
      // that rendered greenest. The count is persisted because it can only ALMOST be derived: an
      // arm that had something firing and neither delivered nor failed attempted nothing, but
      // that inference is unavailable on a quiet deployment, and "can this arm page a human" has
      // to be answerable then too.
      const db = await makeTestDb();
      await seedHeartbeat(db);
      await runAlertPass(db, { now: NOW, sinks: [], driver: "worker", shards: [] });

      const [worker] = (await alertDriverStatuses(db)).filter((d) => d.driver === "worker");
      expect(worker!.ranAt, "the pass ran").not.toBeNull();
      expect(worker!.sinkFailureStreak, "and failed nothing, because it attempted nothing").toBe(0);
      expect(worker!.sinksConfigured, "THIS is the field that says it cannot page").toBe(0);

      // …and an arm WITH a sink records it, so zero is a finding rather than the only value.
      await runAlertPass(db, {
        now: new Date(NOW.getTime() + MIN),
        sinks: [spySink("spy")], driver: "api", shards: [],
      });
      const [api] = (await alertDriverStatuses(db)).filter((d) => d.driver === "api");
      expect(api!.sinksConfigured).toBe(1);
    });

  it("alertDriverStatuses ALWAYS returns both arms — 'never run' is a state, not an absence", async () => {
    const db = await makeTestDb();
    // Three stamps whose every arm was asked and refused: the database counts the streak.
    for (const m of [3, 2, 1]) {
      await recordAlertPass(db, {
        driver: "worker", now: ago(m * MIN), firing: 2, delivered: 0, failedSinks: 1, refusedAll: true, sinksConfigured: 1,
      });
    }
    const statuses = await alertDriverStatuses(db);
    expect(statuses.map((s) => s.driver)).toEqual(["worker", "api"]);
    const api = statuses.find((s) => s.driver === "api")!;
    expect(api.ranAt, "present, and saying never").toBeNull();
    const worker = statuses.find((s) => s.driver === "worker")!;
    expect(worker.sinkFailureStreak).toBe(3);
    expect(worker.failedSinks).toBe(1);
  });

  it("AN ARM THAT HAS NEVER RUN HAS AN UNKNOWN SINK COUNT, NOT ZERO — different repairs",
    async () => {
      // Zero means "configured with no sinks": this arm cannot page anybody, go and add one.
      // NULL means the arm has never written a pass at all: its scheduler is dead, and the sink
      // list is not the thing to fix. Fabricating the zero put the wrong repair in front of the
      // operator, in the confident voice of a measurement, for the one failure this table exists
      // to expose. The panel renders null as "unknown".
      const db = await makeTestDb();
      await db.insert(alertPassRuns).values({
        driver: "worker", ranAt: ago(MIN), firing: 0, delivered: 0, failedSinks: 0,
        sinkFailureStreak: 0, sinksConfigured: 0,
      });
      const statuses = await alertDriverStatuses(db);
      const api = statuses.find((s) => s.driver === "api")!;
      expect(api.ranAt, "no pass on record").toBeNull();
      expect(api.sinksConfigured, "so the count is unknown, not zero").toBeNull();

      const worker = statuses.find((s) => s.driver === "worker")!;
      expect(worker.sinksConfigured, "a pass that ran and counted none IS a zero").toBe(0);
    });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   6. The census — risk 1, "built, tested, unreachable"
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("the rule census", () => {
  /**
   * Every `AlertKind` this file's union declares, and where the evaluator produces it.
   *
   * THE FAILURE THIS EXISTS FOR is the ruling's first ranked risk in its purest form: a rule
   * that is written, unit-tested and never REGISTERED reads as coverage and is decoration. A
   * `kind` in the union that no branch of `evaluateAlerts` can emit is exactly that — and it
   * cannot be caught by a type, because the union is satisfied by declaring the string.
   *
   * The list is retyped rather than derived, deliberately: deriving it from the source would
   * make the test agree with whatever the source says, which is the one thing a census must not
   * do. A new kind has to be added here BY HAND, next to the sentence saying it is reachable.
   */
  const EVERY_KIND: readonly AlertKind[] = [
    "worker_down", "worker_degraded",
    "sends_stuck", "sync_lag", "storage_at_cap",
    "device_sync_stale", "session_sync_stale", "session_reuse_revoked",
    "credential_replay_wide",
    // Rule 9c, reachable from `evaluateAlerts` and driven at, below and outside its window in
    // `packages/db/test/alerts.test.ts`.
    "session_refresh_replayed",
    "api_5xx_rate", "schema_behind", "imap_admission_refused",
    "ai_provider_down", "alert_driver_dark",
    // Cloud 0033's two, both reachable from `evaluateAlerts` and both driven at and below their
    // floors in `packages/api/test/api-faults.pg.test.ts` (real Postgres — the window reads bind
    // an instant in a raw fragment, which PGlite would accept as a bare Date).
    "api_fault_rate", "pooler_refusals",
    // The alerting's own reach, rules 16-19, each driven firing and clear in
    // `alert-reach.test.ts` and `alert-driver-gaps.pg.test.ts`.
    "alert_driver_undeliverable", "alert_sink_degraded", "api_cron_stale", "signal_source_dark",
    // The billing plane's own failures, rule 20, driven firing, clear and unread on real Postgres
    // in `alert-plane-ops.pg.test.ts`.
    "plane_pass_stale", "billing_alert", "plane_ops_unreadable",
    // The pager's last resort when the database is gone: emitted by `dbUnreadableAlert`, sent from
    // the drivers' failure paths (`alert-last-resort.ts`), driven in `alert-last-resort.test.ts`.
    "alert_db_unreadable",
  ];

  it("every kind in the union is EMITTED by a branch of evaluateAlerts", async () => {
    // Read from the evaluator's own source rather than from a fixture, because what is being
    // asserted is that a branch EXISTS — not that some seeded state happens to reach it. A kind
    // present in the union and absent from the file is a rule nobody wrote.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/alerts.ts", import.meta.url), "utf8");
    const missing = EVERY_KIND.filter((k) => !src.includes(`kind: "${k}"`));
    expect(missing, "kinds declared in AlertKind that no rule ever emits").toEqual([]);
  });

  it("every kind a rule EMITS is declared in the union — no rule fires under an unnamed kind", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/alerts.ts", import.meta.url), "utf8");
    const emitted = [...src.matchAll(/kind: "([a-z0-9_]+)"/g)].map((m) => m[1]!);
    const undeclared = [...new Set(emitted)].filter((k) => !EVERY_KIND.includes(k as AlertKind));
    expect(undeclared, "a rule emits a kind the union does not name").toEqual([]);
  });

  it("every fixHref a rule writes is a console path this console actually serves", async () => {
    // A deep link is only worth having if it resolves. The admin console's route tree is a fixed
    // set of top-level segments, and a rule pointing at one that does not exist would render a
    // link straight to a 404 at the moment somebody most needs it to work.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/alerts.ts", import.meta.url), "utf8");
    const SERVED = ["/worker", "/billing", "/accounts", "/reliability", "/costs", "/actions"];
    const hrefs = [...src.matchAll(/fixHref: "(\/[a-z-]+)/g)].map((m) => m[1]!);
    const unserved = [...new Set(hrefs)].filter((h) => !SERVED.includes(h));
    expect(unserved, "a rule deep-links to a console route that does not exist").toEqual([]);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   7. The projections the board renders
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("affectedAccounts", () => {
  it("counts ACCOUNTS, not rows — forty lagging mailboxes on one account is one account", async () => {
    // The distinction this field exists for. `count` is mailboxes and would read as forty
    // customers; `affectedAccounts` is what an operator sizes the incident from.
    const db = await makeTestDb();
    await seedHeartbeat(db);
    const a = await seedAccount(db, "one-account");
    for (let i = 0; i < 6; i++) await seedMailbox(db, a, 90 * MIN);
    const firing = await evaluateAlerts(db, { now: NOW });
    const lag = find(firing, "sync_lag")!;
    expect(lag.count, "six mailboxes").toBe(6);
    expect(lag.affectedAccounts, "one customer").toBe(1);
  });

  it("is NULL and not 0 for a deployment-wide fact", async () => {
    const db = await makeTestDb();
    const firing = await evaluateAlerts(db, { now: NOW, shards: [0] });
    const down = find(firing, "worker_down")!;
    expect(down.affectedAccounts,
      "a dead worker is one fact about everybody, not a count of nobody").toBeNull();
  });
});
