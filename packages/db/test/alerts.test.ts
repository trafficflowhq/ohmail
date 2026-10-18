import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import { accounts, drafts, mailboxes, outboundSends } from "@trafficflow/db";
import { alertState, workerHeartbeats } from "../src/cloud.js";
import {
  evaluateAlerts, runAlertPass, writeHeartbeat, refreshHeartbeat, clearHeartbeat, firingToLog,
  webhookAlertSink, listStuckSends, listOpenAlerts,
  DEFAULT_ALERT_THRESHOLDS, DEFAULT_CLAIM_TTL_MS, humanAge,
  type Alert, type AlertSink,
} from "../src/alerts.js";

/**
 * THE POINT OF THE WHOLE SLICE, ASSERTED WITHOUT WAITING FOR A REAL FAILURE.
 *
 * The failure this exists to prevent, from the Stripe review: a webhook fails on every retry
 * until Stripe gives up after ~3 days; the customer has paid; the credits never landed; every
 * test is green; nobody finds out. The last clause is the one this file removes — the failure
 * states are SEEDED here, and the alert is asserted to fire, so "nobody finds out" is a
 * property the suite can refute in 200ms instead of a thing you learn from a support ticket.
 *
 * Every rule in this file gets the same treatment: put the database into the broken
 * state, run the evaluator, assert the alert. Nothing here sleeps, nothing here opens a
 * socket (the webhook sink's transport is injected), and nothing here depends on a real
 * worker being up.
 */

type Db = Awaited<ReturnType<typeof makeTestDb>>;

/**
 * FIVE at-cap accounts, each over its cap by a fixed amount — a population that does not move.
 *
 * Five and not one, because `storageCapWideAccounts` is the cut at which the rule stops being a
 * SIGNAL and becomes an INCIDENT, and `runAlertPass` delivers incidents only. At one account the
 * rule fires and is recorded and never notified, which would make this case pass by finding
 * nothing.
 */
const AT_CAP = Array.from({ length: 5 }, (_, i) => ({
  accountId: `8f1f1b7e-0000-4000-8000-00000000000${i + 1}`,
  bytes: 6_000 + i, storageBytesLimit: 5_000,
}));

const NOW = new Date("2026-07-31T12:00:00.000Z");

interface Doors { query: (...a: unknown[]) => Promise<unknown>; exec: (...a: unknown[]) => Promise<unknown> }
type Client = Doors & { transaction: (cb: (tx: Doors) => Promise<unknown>) => Promise<unknown> };
/** Every statement text the PGlite client runs from here on, a transaction's included. */
function recordStatements(db: unknown): string[] {
  const client = (db as { $client: Client }).$client;
  const seen: string[] = [];
  const instrument = <T extends Doors>(t: T): T => {
    for (const door of ["query", "exec"] as const) {
      const inner = t[door].bind(t);
      t[door] = (...a: unknown[]) => { if (typeof a[0] === "string") seen.push(a[0]); return inner(...(a as [])); };
    }
    return t;
  };
  instrument(client);
  const innerTx = client.transaction.bind(client);
  client.transaction = (cb) => innerTx((tx) => cb(instrument(tx)));
  return seen;
}
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;

async function seedAccount(db: Db, name = "Alerts"): Promise<string> {
  const [acct] = await db.insert(accounts).values({ name }).returning();
  return acct!.id;
}

/** A live leader for shard 0, beating `age` ago. The happy path for rule 1. */
async function seedHeartbeat(db: Db, age: number, shardIndex = 0): Promise<void> {
  await writeHeartbeat(db, {
    shardIndex, instanceId: "wkr-test", shards: 1,
    mailboxes: 2, expected: 2, accounts: 1, quarantined: 0, degraded: false,
    lastCycleAt: ago(age), startedAt: ago(HOUR),
  }, ago(age));
}

/** A mailbox whose last successful sync was `age` ago. */
async function seedMailbox(
  db: Db, accountId: string, opts: { lastSyncAge: number | null; status?: string },
): Promise<string> {
  const [mb] = await db.insert(mailboxes).values({
    accountId,
    provider: "imap",
    address: `ops-${Math.random().toString(36).slice(2, 8)}@example.test`,
    status: opts.status ?? "connected",
    lastSyncAt: opts.lastSyncAge === null ? null : ago(opts.lastSyncAge),
    createdAt: ago(2 * HOUR),
  }).returning();
  return mb!.id;
}

/** An `outbound_sends` reservation created `age` ago and never resolved. */
async function seedPendingSend(db: Db, accountId: string, age: number): Promise<string> {
  const mailboxId = await seedMailbox(db, accountId, { lastSyncAge: 0 });
  const [draft] = await db.insert(drafts).values({ accountId, mailboxId }).returning();
  const [send] = await db.insert(outboundSends).values({
    accountId,
    idempotencyKey: `idem-${Math.random().toString(36).slice(2, 10)}`,
    draftId: draft!.id,
    mintedMessageId: `<${Math.random().toString(36).slice(2)}@app.ohmail.app>`,
    status: "pending",
    createdAt: ago(age),
  }).returning();
  return send!.id;
}

/**
 * A STUCK SEND, recorded `age` ago — this file's vehicle for the pass machinery.
 *
 * It fires `sends_stuck` from one row, with no threshold subtlety at the ages these cases use,
 * and it RESOLVES by moving the row's own status, which is what the resolve case needs. It
 * replaced a failed Stripe apply: that row belongs to whoever operates metering now, and none of
 * the cases below was ever about it.
 */
async function seedFiringRow(db: Db, accountId: string, age: number, key: string): Promise<void> {
  const mailboxId = await seedMailbox(db, accountId, { lastSyncAge: 0 });
  const [draft] = await db.insert(drafts).values({ accountId, mailboxId }).returning();
  await db.insert(outboundSends).values({
    accountId,
    idempotencyKey: `idem-${key}`,
    draftId: draft!.id,
    mintedMessageId: `<${key}@app.ohmail.app>`,
    status: "pending",
    createdAt: ago(age),
  });
}

/** A sink that records what it was handed and can be told to refuse. */
function spySink(name: string, accept = true): AlertSink & { seen: Alert[][] } {
  const seen: Alert[][] = [];
  return {
    name,
    seen,
    async notify(alerts) { seen.push([...alerts]); return accept; },
  };
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   Rule by rule
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("evaluateAlerts — the original rules, against seeded failure states", () => {
  it("a healthy world fires nothing", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db, 20_000);
    await seedMailbox(db, a, { lastSyncAge: 60_000 });
    expect(await evaluateAlerts(db, { now: NOW })).toEqual([]);
  });

  it("NO LEADER HEARTBEAT AT ALL fires worker_down — a worker that never started is down", async () => {
    const db = await makeTestDb();
    const alerts = await evaluateAlerts(db, { now: NOW });
    const down = alerts.find((x) => x.kind === "worker_down");
    expect(down, "an empty worker_heartbeats table must fire, not pass").toBeDefined();
    expect(down!.key).toBe("worker_down:0");
    expect(down!.severity).toBe("critical");
    expect(down!.detail).toMatch(/has ever written a heartbeat/);
  });

  it("a heartbeat older than 2 minutes fires; 119 seconds does not", async () => {
    const db = await makeTestDb();
    await seedHeartbeat(db, 119_000);
    expect((await evaluateAlerts(db, { now: NOW })).some((x) => x.kind === "worker_down")).toBe(false);

    await seedHeartbeat(db, 121_000);
    const fired = (await evaluateAlerts(db, { now: NOW })).find((x) => x.kind === "worker_down");
    expect(fired).toBeDefined();
    expect(fired!.oldestSeconds).toBe(121);
  });

  it("clearHeartbeat makes a shard report down IMMEDIATELY — a clean shutdown is not 'alive for 2 more minutes'", async () => {
    const db = await makeTestDb();
    await seedHeartbeat(db, 5_000);
    expect((await evaluateAlerts(db, { now: NOW })).some((x) => x.kind === "worker_down")).toBe(false);
    await clearHeartbeat(db, { shardIndex: 0, instanceId: "wkr-test" }, NOW);
    expect((await evaluateAlerts(db, { now: NOW })).some((x) => x.kind === "worker_down")).toBe(true);
  });

  it("each configured shard is checked independently", async () => {
    const db = await makeTestDb();
    await seedHeartbeat(db, 10_000, 0);
    const alerts = await evaluateAlerts(db, { now: NOW, shards: [0, 1] });
    expect(alerts.map((x) => x.key)).toContain("worker_down:1");
    expect(alerts.map((x) => x.key)).not.toContain("worker_down:0");
  });

  it("a send pending past 15 minutes fires; one at 11 — inside the reconciler's window — does not", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db, 10_000);
    await seedPendingSend(db, a, 11 * MIN);
    expect((await evaluateAlerts(db, { now: NOW })).some((x) => x.kind === "sends_stuck")).toBe(false);

    await seedPendingSend(db, a, 16 * MIN);
    const alert = (await evaluateAlerts(db, { now: NOW })).find((x) => x.kind === "sends_stuck");
    expect(alert).toBeDefined();
    expect(alert!.count).toBe(1);
    expect(alert!.detail).toMatch(/never auto-resent/);
    // The sentence has to say what the rule now MEANS, or an operator reads a fifteen-minute
    // page as "a sender died" and goes looking for the wrong thing.
    expect(alert!.detail).toMatch(/reconciling pass/);
  });

  it("a RESOLVED send is not stuck — only 'pending' counts", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db, 10_000);
    const id = await seedPendingSend(db, a, 30 * MIN);
    await db.update(outboundSends).set({ status: "sent" }).where(eq(outboundSends.id, id));
    expect((await evaluateAlerts(db, { now: NOW })).some((x) => x.kind === "sends_stuck")).toBe(false);
  });

  it("a mailbox KISSING the threshold does not page — the healthy scan's own tail is not a fault", async () => {
    // The flap this rule shipped with, measured live (2026-08-24): every on-duty mailbox was
    // minutes fresh, yet "1 mailbox behind by more than 15m" kept mailing the operator —
    // the serialized scan's healthy tail reaches the 15-minute threshold itself, so paging at
    // the threshold is paging on the scheduler's own period. A mailbox at 16 minutes that the
    // next scan returns to minutes must produce ZERO alerts.
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db, 10_000);
    await seedMailbox(db, a, { lastSyncAge: 16 * MIN });
    expect((await evaluateAlerts(db, { now: NOW })).some((x) => x.kind === "sync_lag"),
      "the boundary kiss is the scheduler's tail, not an incident").toBe(false);
  });

  it("an enabled mailbox SUSTAINED past threshold+period fires; a DISABLED one never does", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db, 10_000);
    // The billing-downgrade path: disabled mailboxes are SUPPOSED not to sync.
    await seedMailbox(db, a, { lastSyncAge: 5 * HOUR, status: "disabled" });
    expect((await evaluateAlerts(db, { now: NOW })).some((x) => x.kind === "sync_lag")).toBe(false);

    // 35 minutes: past syncLagMs + syncLagSustainMs (30m) — no scan advanced it for a full
    // further period, which is the wedge the rule exists for.
    await seedMailbox(db, a, { lastSyncAge: 35 * MIN });
    // A host that parks nobody measured duty; an unstated reader drops the delivery claim.
    const alert = (await evaluateAlerts(db, { now: NOW, parkedAccounts: null })).find((x) => x.kind === "sync_lag");
    expect(alert).toBeDefined();
    expect(alert!.count).toBe(1);
    // Warning at this tier, and the copy says what is TRUE at 35 minutes: delayed, not dead.
    expect(alert!.severity).toBe("warning");
    expect(alert!.detail).toContain("delivery to them is delayed");
    expect(alert!.detail).not.toContain("not receiving mail");
  });

  it("HOURS behind is the critical tier's own row, and only it says 'not receiving mail'", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db, 10_000);
    await seedMailbox(db, a, { lastSyncAge: 3 * HOUR });
    const alerts = await evaluateAlerts(db, { now: NOW, parkedAccounts: null });
    const critical = alerts.find((x) => x.key === "sync_lag:critical");
    expect(critical, "hours behind is no scheduler artifact").toBeDefined();
    expect(critical!.severity).toBe("critical");
    expect(critical!.detail).toContain("not receiving mail");
    // …and with EVERY lagging mailbox past the critical cut, there is no warning-tier row to
    // dilute it — the tiers partition the population, they do not double-count it.
    expect(alerts.some((x) => x.key === "sync_lag")).toBe(false);
  });

  it("MIXED tiers: each row counts its own mailboxes and says what is true of them", async () => {
    // The grouped form re-smuggled the overclaim: one 3-hour mailbox beside a 35-minute one
    // made "their owners are not receiving mail" cover both. Two rows now, one per tier.
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db, 10_000);
    await seedMailbox(db, a, { lastSyncAge: 3 * HOUR });
    await seedMailbox(db, a, { lastSyncAge: 35 * MIN });
    const alerts = await evaluateAlerts(db, { now: NOW, parkedAccounts: null });
    const warning = alerts.find((x) => x.key === "sync_lag")!;
    const critical = alerts.find((x) => x.key === "sync_lag:critical")!;
    expect(warning.count, "the 35-minute mailbox").toBe(1);
    expect(warning.severity).toBe("warning");
    expect(warning.detail).toContain("delivery to them is delayed");
    expect(warning.detail).not.toContain("not receiving mail");
    // The warning row's age is ITS population's worst, not the critical mailbox's 3 hours.
    expect(warning.oldestSeconds).toBe(35 * 60);
    expect(critical.count, "the 3-hour mailbox").toBe(1);
    expect(critical.severity).toBe("critical");
    expect(critical.detail).toContain("not receiving mail");
  });

  it("crossing the critical tier pages immediately — a NEW key, not the muted repeat schedule", async () => {
    // A same-key severity flip sat on the warning's `notified_at` for up to the repeat
    // interval (and a failed first critical delivery re-muted it — two review rounds). The
    // critical tier is its own key, so crossing it opens a NEW row whose NULL stamp the
    // ordinary claim pages at once.
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db, 10_000);
    const mb = await seedMailbox(db, a, { lastSyncAge: 35 * MIN });
    const seen: string[][] = [];
    const spy = { name: "spy", async notify(alerts: Alert[]) { seen.push(alerts.map((x) => `${x.key}:${x.severity}`)); return true; } };

    const first = await runAlertPass(db, { now: NOW, sinks: [spy], shards: [] });
    expect(first.notified.map((x) => x.key)).toContain("sync_lag");

    // Five minutes later — deep inside the repeat interval — the mailbox crosses the critical
    // tier. The warning stays muted; the critical row is new and pages NOW.
    await db.update(mailboxes).set({ lastSyncAt: ago(3 * HOUR) }).where(eq(mailboxes.id, mb));
    const later = new Date(NOW.getTime() + 5 * MIN);
    const second = await runAlertPass(db, { now: later, sinks: [spy], shards: [] });
    expect(second.notified.map((x) => x.key), "the tier crossing is the page").toContain("sync_lag:critical");
    expect(seen.flat()).toContain("sync_lag:critical:critical");

    // …and a THIRD pass at the same tier is muted — one page per tier per repeat interval.
    const third = await runAlertPass(db, { now: new Date(later.getTime() + MIN), sinks: [spy], shards: [] });
    expect(third.notified.map((x) => x.key)).not.toContain("sync_lag:critical");
  });

  it("a FAILED first critical delivery retries on the very next pass — nothing consumes the crossing", async () => {
    // A review finding's shape: the sink rejects the first critical page. With a same-key flip the
    // restore path put the warning's stamp under a row already marked critical and the next
    // pass saw no escalation. With its own key the restore puts back NULL, and NULL is due.
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db, 10_000);
    await seedMailbox(db, a, { lastSyncAge: 3 * HOUR });
    let fail = true;
    const flaky = { name: "flaky", async notify() { return !fail; } };

    const first = await runAlertPass(db, { now: NOW, sinks: [flaky], shards: [] });
    expect(first.notified.map((x) => x.key)).toContain("sync_lag:critical");
    expect(first.delivered).toEqual([]);

    fail = false;
    const second = await runAlertPass(db, { now: new Date(NOW.getTime() + MIN), sinks: [flaky], shards: [] });
    expect(second.notified.map((x) => x.key), "an undelivered critical page must not go quiet").toContain("sync_lag:critical");
    expect(second.delivered).toEqual(["flaky"]);
  });

  it("a QUARANTINED mailbox is in scope — its owner is not receiving mail either", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db, 10_000);
    await seedMailbox(db, a, { lastSyncAge: 40 * MIN, status: "error" });
    expect((await evaluateAlerts(db, { now: NOW })).some((x) => x.kind === "sync_lag")).toBe(true);
  });

  it("a mailbox that has NEVER synced falls back to created_at, so a fresh enrolment is not an alert", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db, 10_000);
    const [fresh] = await db.insert(mailboxes).values({
      accountId: a, provider: "imap", address: "fresh@example.test",
      status: "connected", lastSyncAt: null, createdAt: ago(30_000),
    }).returning();
    expect(fresh).toBeDefined();
    expect((await evaluateAlerts(db, { now: NOW })).some((x) => x.kind === "sync_lag")).toBe(false);
  });

  it("all three fire together, and the thresholds are the arch doc's numbers", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedPendingSend(db, a, 25 * MIN);
    await seedMailbox(db, a, { lastSyncAge: 66 * MIN });

    // One kind per rule: `seedPendingSend` seeds its own mailbox with a fresh stamp, so the
    // lagging one below is the only `sync_lag` member.
    const kinds = [...new Set((await evaluateAlerts(db, { now: NOW })).map((x) => x.kind))].sort();
    expect(kinds).toEqual(["sends_stuck", "sync_lag", "worker_down"]);

    expect(DEFAULT_ALERT_THRESHOLDS).toEqual({
      leaderStaleMs: 2 * 60 * 1000,       // "no leader lock held for > 2 minutes"
      // 10 → 15 minutes, and the SENTENCE changed with it: this no longer means "a sender died"
      // (which was true when nothing but a client retry could resolve the row) but "the
      // RECONCILING PASS is not draining". Ten to go stale plus five for the once-a-minute
      // clock to have had several chances. `api-cron.test.ts` holds the same arithmetic against
      // the shipped cadence, so lowering one without the other is red there.
      stuckSendMs: 15 * 60 * 1000,        // "outbound_sends stuck 'pending' > 15 minutes"
      syncLagMs: 15 * 60 * 1000,          // "sync lag > 15 minutes for any enabled mailbox"
      syncLagSustainMs: 15 * 60 * 1000,   // …SUSTAINED one further scan period (the debounce)
      syncLagCriticalMs: 2 * 60 * 60 * 1000, // hours behind = "not receiving mail" is true
      deviceSyncStaleMs: 3 * 24 * 60 * 60 * 1000, // "a native device 3 days off the horizon"
                                            //  — session_sync_stale reads the SAME knob
      reuseRevokedWindowMs: 24 * 60 * 60 * 1000, // "a reuse revocation pages for a day"
      // ── cloud 0030's reliability rules ──────────────────────────────────────────────────
      workerDegradedMs: 10 * 60 * 1000,   // a booting worker is degraded; a stuck one stays so
      api5xxWindowMs: 15 * 60 * 1000,     // three five-minute polls, so one miss still leaves two
      api5xxMinErrors: 10,                // BOTH floors, never either — a rate alone pages on
      api5xxMinRate: 0.02,                // three requests, a count alone on a busy normal day
      apiFaultWindowMs: 10 * 60 * 1000,   // api_faults rows carry their own instants — no bucket
      apiFaultMinPerRoute: 10,            // 5x the worst quiet 15-min sum in the measured span
      apiFaultMinMinutesPerRoute: 3,      // the worker's grain: three separate failing minutes
      poolerRefusalThreshold: 10,         // one refusal IS the acquire ceiling working
      imapRefusalWindowMs: 15 * 60 * 1000, // matches the counter's own window in imap-admission.ts
      imapRefusalThreshold: 5,            // one or two refusals IS the cap working
      aiCircuitOpenMs: 10 * 60 * 1000,    // below the breaker's 15-min max cooldown, so only a
      alertDriverDarkMs: 30 * 60 * 1000,  // many missed passes for either arm, no plausible jitter
      alertDriverNeverRanMs: 30 * 60 * 1000,  // the dark threshold, counted from the leader's boot
      driverUndeliverableStreak: 3,       // passes refused by every arm: a 502 is a blip, three is not
      apiCronStaleFloorMs: 15 * 60 * 1000, // under twice a clocked pass's cadence, so a minute clock needs misses
      signalSourceDarkMs: 30 * 60 * 1000, // the poller runs every five; the widest gap measured was ten
      reuseWideAccounts: 3,               // one account is a client bug; three is a pattern
      refreshReplayedWindowMs: 60 * 60 * 1000, // a client rotates ~4x an hour at the access window
      refreshReplayedThreshold: 5,        // …so five replays in one is replaying more than rotating
      storageCapWideAccounts: 5,          // five at once is the evict pass, not five heavy users
      syncLagWideAccounts: 3,             // …and the promotion's two arms, one for each size of
      syncLagWideFraction: 0.2,           //    deployment — see the rule
    });
  });

  it("evaluation is READ-ONLY — the console can render it without being able to silence a pager", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedFiringRow(db, a, HOUR, "evt_ro");
    await evaluateAlerts(db, { now: NOW });
    expect(await db.select().from(alertState)).toEqual([]);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   The pass: memory, delivery, resolution
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("runAlertPass — notify once, repeat on a schedule, resolve when fixed", () => {
  it("notifies on the first observation and NOT on the second", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db, 10_000);
    await seedFiringRow(db, a, HOUR, "evt_repeat");
    const sink = spySink("spy");

    const first = await runAlertPass(db, { now: NOW, sinks: [sink] });
    expect(first.notified.map((x) => x.key)).toEqual(["sends_stuck"]);
    expect(first.delivered).toEqual(["spy"]);

    // One minute later, same fault. A pager that repeats every minute is a pager people mute.
    const second = await runAlertPass(db, { now: new Date(NOW.getTime() + MIN), sinks: [sink] });
    expect(second.firing.map((x) => x.key)).toEqual(["sends_stuck"]);
    expect(second.notified).toEqual([]);
    expect(sink.seen).toHaveLength(1);
  });

  it("repeats once the repeat interval has passed", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db, 10_000);
    await seedFiringRow(db, a, HOUR, "evt_hourly");
    const sink = spySink("spy");

    await runAlertPass(db, { now: NOW, sinks: [sink], repeatMs: HOUR });
    // An hour later. The heartbeat has gone stale too by then, which is realistic and is
    // exactly why the assertion is on the KEY rather than on the count: a repeat pass
    // batches whatever is due, and a second fault appearing must not hide the repeat.
    const later = await runAlertPass(db, {
      now: new Date(NOW.getTime() + HOUR + MIN), sinks: [sink], repeatMs: HOUR,
    });
    expect(later.notified.map((x) => x.key)).toContain("sends_stuck");
    expect(sink.seen).toHaveLength(2);

    const [row] = await db.select().from(alertState).where(eq(alertState.alertKey, "sends_stuck"));
    expect(row!.notifyCount).toBe(2);
  });

  it("opened_at is the moment the fault STARTED and survives every later pass", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db, 10_000);
    await seedFiringRow(db, a, HOUR, "evt_opened");
    await runAlertPass(db, { now: NOW, sinks: [] });
    await runAlertPass(db, { now: new Date(NOW.getTime() + 5 * MIN), sinks: [] });

    const [row] = await db.select().from(alertState).where(eq(alertState.alertKey, "sends_stuck"));
    expect(new Date(row!.openedAt).toISOString()).toBe(NOW.toISOString());
    expect(new Date(row!.lastSeenAt).getTime()).toBe(NOW.getTime() + 5 * MIN);
  });

  it("clears the row when the condition resolves, so alert_state is a LIVE list", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db, 10_000);
    await seedFiringRow(db, a, HOUR, "evt_resolve");
    await runAlertPass(db, { now: NOW, sinks: [] });
    expect(await listOpenAlerts(db)).toHaveLength(1);

    await db.update(outboundSends).set({ status: "sent" })
      .where(eq(outboundSends.idempotencyKey, "idem-evt_resolve"));
    const after = await runAlertPass(db, { now: new Date(NOW.getTime() + MIN), sinks: [] });
    expect(after.resolved).toEqual(["sends_stuck"]);
    expect(await listOpenAlerts(db)).toEqual([]);
  });

  it("A FAILED SINK DOES NOT STAMP notified_at — the next pass tries again", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db, 10_000);
    await seedFiringRow(db, a, HOUR, "evt_sinkfail");
    const broken = spySink("broken", false);

    const first = await runAlertPass(db, { now: NOW, sinks: [broken] });
    expect(first.delivered).toEqual([]);
    expect(first.failedSinks).toEqual(["broken"]);
    const [row] = await db.select().from(alertState).where(eq(alertState.alertKey, "sends_stuck"));
    expect(row!.notifiedAt, "an undelivered alert must not look delivered").toBeNull();

    // A misconfigured webhook is therefore self-correcting rather than a silent hole.
    const working = spySink("working");
    const second = await runAlertPass(db, { now: new Date(NOW.getTime() + MIN), sinks: [working] });
    expect(second.notified).toHaveLength(1);
    expect(working.seen).toHaveLength(1);
  });

  it("a THROWING sink cannot abort the pass, and the other sink still runs", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db, 10_000);
    await seedFiringRow(db, a, HOUR, "evt_throw");
    const exploding: AlertSink = {
      name: "exploding",
      notify: () => { throw new Error("provider exploded"); },
    };
    const good = spySink("good");

    const result = await runAlertPass(db, { now: NOW, sinks: [exploding, good] });
    expect(result.failedSinks).toEqual(["exploding"]);
    expect(result.delivered).toEqual(["good"]);
    expect(good.seen).toHaveLength(1);
  });

  it("reports `undeliverable` when alerts fire into NOTHING", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db, 10_000);
    await seedFiringRow(db, a, HOUR, "evt_nosink");
    const result = await runAlertPass(db, { now: NOW, sinks: [] });
    expect(result.firing).toHaveLength(1);
    expect(result.undeliverable, "a deployment with no sink must say so out loud").toBe(true);
    const [row] = await db.select().from(alertState).where(eq(alertState.alertKey, "sends_stuck"));
    expect(row!.notifiedAt).toBeNull();
  });

  it("the WORKER pass skips the leader rule — a process cannot testify to its own liveness", async () => {
    const db = await makeTestDb();
    // No heartbeat at all: the API pass would fire `worker_down`; the worker pass must not.
    const result = await runAlertPass(db, { now: NOW, sinks: [], shards: [], source: "worker" });
    expect(result.firing.map((x) => x.kind)).not.toContain("worker_down");
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   The webhook sink — no socket, no vendor SDK
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("webhookAlertSink", () => {
  it("is null when no URL is configured, so the pass simply has one fewer sink", () => {
    expect(webhookAlertSink(undefined)).toBeNull();
    expect(webhookAlertSink("   ")).toBeNull();
  });

  it("POSTs one JSON body carrying both prose and structure, and reports the HTTP verdict", async () => {
    const posted: Array<{ url: string; body: string }> = [];
    const sink = webhookAlertSink("https://ntfy.example/ohmail", async (url, body) => {
      posted.push({ url, body });
      return { status: 200 };
    })!;
    const alert: Alert = {
      key: "sends_stuck", kind: "sends_stuck", severity: "critical",
      title: "2 sends are stuck pending", detail: "oldest is 48m old", count: 2, oldestSeconds: 2880,
    };
    const ok = await sink.notify([alert], { source: "worker", environment: "production", now: NOW });
    // The verdict is now an `AlertDeliveryResult` rather than a bare boolean, because a
    // refusal has to be able to say WHY — see `alert-sink-failure.test.ts` for the production
    // failure that forced it — and it carries a CLOSED outcome code beside the prose, because
    // a second vendor made "which arm, and what happened to it" a question a machine has to be
    // able to answer (`alert-sink-health.test.ts`). A success has nothing else to add.
    expect(ok).toEqual({ ok: true, outcome: "ok" });
    expect(posted).toHaveLength(1);
    const body = JSON.parse(posted[0]!.body) as Record<string, unknown>;
    expect(body.text).toMatch(/2 sends are stuck pending/);
    expect(body.alerts).toHaveLength(1);
    expect(body.source).toBe("worker");
  });

  it("a non-2xx is a FAILED delivery, and a throwing transport does not propagate", async () => {
    const rejecting = webhookAlertSink("https://ntfy.example/x", async () => ({ status: 500 }))!;
    const alert: Alert = {
      key: "k", kind: "sync_lag", severity: "warning", title: "t", detail: "d", count: 1, oldestSeconds: 1,
    };
    const ctx = { source: "api", environment: "production", now: NOW };
    // Still a failure, and now a failure that STATES ITSELF: `delivered=[] failedSinks=["webhook"]`
    // with no reason attached is the log line this whole slice exists to stop producing.
    // `refused` — the vendor answered, and said no. Its network path is fine.
    expect(await rejecting.notify([alert], ctx))
      .toEqual({ ok: false, outcome: "refused", error: "HTTP 500" });

    const throwing = webhookAlertSink("https://ntfy.example/x", () => { throw new Error("dns"); })!;
    const thrown = await throwing.notify([alert], ctx) as
      { ok: boolean; outcome?: string; error?: string | null };
    expect(thrown.ok).toBe(false);
    expect(thrown.error).toContain("dns");
    // …and a transport that never produced an answer is UNREACHABLE, not a refusal. The
    // distinction is the ntfy outage: for months the logs could not tell "the host swallowed
    // our packets" apart from "the service rejected the request".
    expect(thrown.outcome).toBe("unreachable");
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   The operator queues the admin console renders
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("the operator queues", () => {
  it("listStuckSends returns only pending rows past the cutoff, and NEVER the idempotency key", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedPendingSend(db, a, 2 * MIN);
    await seedPendingSend(db, a, 45 * MIN);
    const rows = await listStuckSends(db, ago(10 * MIN));
    expect(rows).toHaveLength(1);
    // NARROWED THIS, and the narrowing is the assertion. `idempotencyKey` used to be
    // selected here and thrown away by `admin-service.ts`; Postgres requires the SELECT
    // privilege on every column a statement REFERENCES, so selecting-then-discarding would
    // have forced `outbound_sends.idempotency_key` into the `ohmail_admin` grant — the
    // caller-chosen free-text column the first staff change removed from the console in the first place.
    expect(Object.keys(rows[0]!).sort()).toEqual(["accountId", "createdAt", "id", "status"]);
  });

  it("listOpenAlerts is what the console renders, and it matches what the pass recorded", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedFiringRow(db, a, HOUR, "evt_open");
    await runAlertPass(db, { now: NOW, sinks: [spySink("s")] });
    const open = await listOpenAlerts(db);
    expect(open.map((o) => o.alertKey).sort()).toEqual(["sends_stuck", "worker_down:0"]);
    expect(open.every((o) => o.notifiedAt !== null)).toBe(true);
  });

  /**
   * and note WHERE this assertion has to live, because the obvious place cannot work.
   *
   * The two tests above assert `Object.keys(rows[0])`, which is the right guard for them. It is
   * useless here: `listOpenAlerts` re-projects every row through an explicit object literal, so
   * the RETURNED shape is identical whether the SELECT asked for eight columns or for all of
   * them. A whole-row read would pass that assertion forever. That is precisely why the row sat open
   * as a "drift shape" rather than a defect — the leak would arrive with a future column, not
   * with today's code, and nothing here would notice.
   *
   * The only place the two versions differ is the statement sent to Postgres, so that is what
   * this intercepts. It asserts the projection is present AND exactly the expected keys: one
   * more means someone widened what crosses the boundary, which is a decision that should cost
   * a failing test rather than a silent diff.
   */
  it("listOpenAlerts asks the database for thirteen named columns, never the whole row", async () => {
    const db = await makeTestDb();
    const projections: Array<unknown> = [];
    const realSelect = db.select.bind(db);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).select = (...args: unknown[]) => {
      projections.push(args[0]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realSelect as any)(...args);
    };

    await listOpenAlerts(db);

    expect(projections, "listOpenAlerts issued no SELECT at all").toHaveLength(1);
    expect(
      projections[0],
      "listOpenAlerts called .select() with NO projection — that is a whole-row read, and every " +
      "column added to alert_state from now on crosses the staff boundary the moment it exists",
    ).toBeTruthy();
    // ELEVEN → THIRTEEN for `title` and `count`, which is a WIDENING and therefore owes the
    // sentence this list exists to extract. Both are what the RULE said: the title a sentence
    // `alerts.ts` composes from counts and ages, the count an integer. Neither can carry what a
    // message says — the table's own header rules mail content out of every field, and every
    // producer of both is a literal in this repository.
    //
    // They are here because the alternative was worse than a widening. Without them, every
    // surface that READS this table rather than evaluating had to invent both: the count as a
    // hardcoded 1, the title as the detail's first sentence. That is not the exceptional path —
    // two rules are keyed by driver and one by role, so for those three the row is the only
    // source there is. A projected sentence the rule actually wrote is narrower than a
    // reconstructed one.
    //
    // EIGHT → ELEVEN for cloud 0030's incident/signal split: `cls`, `affectedAccounts` and
    // `fixHref`. Each was an explicit decision in the three places that have to agree
    // (`STAFF_SELECT_GRANTS`, `harden-staff-role.sql`, this projection), and each is a closed
    // word, a count, or an internal console path this repository composes from a literal — the
    // widening this list exists to make expensive is a column that carries what a MESSAGE says,
    // and none of these can.
    expect(Object.keys(projections[0] as object).sort()).toEqual([
      "affectedAccounts", "alertKey", "cls", "count", "detail", "fixHref", "kind", "lastSeenAt",
      "notifiedAt", "notifyCount", "openedAt", "severity", "title",
    ]);
  });
});

describe("humanAge", () => {
  it("renders an age a human parses without arithmetic", () => {
    expect(humanAge(null)).toBe("never");
    expect(humanAge(48)).toBe("48s");
    expect(humanAge(180)).toBe("3m");
    expect(humanAge(3 * 3600)).toBe("3h");
    expect(humanAge(4 * 3600 + 12 * 60)).toBe("4h 12m");
    expect(humanAge(50 * 3600)).toBe("2d 2h");
  });
});

describe("writeHeartbeat", () => {
  it("is keyed by SHARD, so a takeover overwrites instead of leaving a dead-instance row", async () => {
    const db = await makeTestDb();
    await writeHeartbeat(db, {
      shardIndex: 0, instanceId: "old", shards: 1, mailboxes: 3, expected: 3,
      accounts: 2, quarantined: 0, degraded: false, lastCycleAt: ago(MIN), startedAt: ago(HOUR),
    }, ago(MIN));
    await writeHeartbeat(db, {
      shardIndex: 0, instanceId: "new", shards: 1, mailboxes: 3, expected: 3,
      accounts: 2, quarantined: 0, degraded: false, lastCycleAt: NOW, startedAt: NOW,
    }, NOW);

    const rows = await db.select().from(workerHeartbeats);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.instanceId).toBe("new");
  });
});

/**
 * THE OFF-QUEUE WRITE, AND THE THREE THINGS IT MUST REFUSE TO DO.
 *
 * `refreshHeartbeat` exists so a leader draining a large mailbox's first sync keeps beating
 * while it works — the `worker_down` rule reads `beat_at` staleness and nothing else, so a
 * three-minute drain used to page a human and invite the platform to kill the instance
 * mid-backfill. But the caller is a TIMER, not the serial queue, so its write can land after a
 * surrender. Every assertion below is about a write that must NOT happen.
 */
describe("refreshHeartbeat — the guarded, off-queue write", () => {
  const beat = (instanceId: string, at: Date): Parameters<typeof writeHeartbeat>[1] => ({
    shardIndex: 0, instanceId, shards: 1, mailboxes: 2, expected: 2,
    accounts: 1, quarantined: 0, degraded: false, lastCycleAt: at, startedAt: ago(HOUR),
  });
  const refresh = (instanceId: string, at: Date): Parameters<typeof refreshHeartbeat>[1] => ({
    shardIndex: 0, instanceId, mailboxes: 5, expected: 5,
    accounts: 3, quarantined: 1, degraded: true, lastCycleAt: at,
  });

  it("moves beat_at and the counters for the instance that owns the row", async () => {
    const db = await makeTestDb();
    await writeHeartbeat(db, beat("wkr-1", ago(MIN)), ago(MIN));

    await refreshHeartbeat(db, refresh("wkr-1", NOW), NOW);

    const [row] = await db.select().from(workerHeartbeats);
    expect(row!.beatAt.getTime()).toBe(NOW.getTime());
    expect(row!.mailboxes).toBe(5);
    expect(row!.quarantined).toBe(1);
    expect(row!.degraded).toBe(true);
    // Identity is fixed by the CLAIMING write; a refresh may not restate it.
    expect(row!.startedAt.getTime()).toBe(ago(HOUR).getTime());
  });

  it("CANNOT RESURRECT A SURRENDERED LEADER — the race an upsert would lose", async () => {
    // The sequence, exactly as it happens in production: the lock drops, `handleLockLoss`
    // quiesces and queues `clearHeartbeat`, and a timer callback that was already in flight
    // lands afterwards. With an upsert the row would say `leader: true` again and the shard
    // would look led for the full two-minute window while nothing was syncing — two minutes
    // AFTER the worker already knew. The `leader = true` predicate makes it a no-op.
    const db = await makeTestDb();
    await writeHeartbeat(db, beat("wkr-1", ago(MIN)), ago(MIN));
    await clearHeartbeat(db, { shardIndex: 0, instanceId: "wkr-1" }, ago(30_000));

    await refreshHeartbeat(db, refresh("wkr-1", NOW), NOW);

    const [row] = await db.select().from(workerHeartbeats);
    expect(row!.leader, "a surrendered shard must stay surrendered").toBe(false);
    expect(row!.beatAt.getTime(), "and the surrender's own timestamp must stand").toBe(ago(30_000).getTime());
    expect(row!.mailboxes).toBe(2);
  });

  it("CANNOT OVERWRITE A SUCCESSOR — the outgoing instance's late beat matches nothing", async () => {
    // A rolling deploy: the incoming leader claims the shard, then the outgoing one's timer
    // fires once more before its process exits. Keyed on `instance_id`, so the stale write
    // cannot drag the row's counters — or its `beat_at` — back to the dead instance's view.
    const db = await makeTestDb();
    await writeHeartbeat(db, beat("wkr-old", ago(MIN)), ago(MIN));
    await writeHeartbeat(db, beat("wkr-new", NOW), NOW);

    await refreshHeartbeat(db, refresh("wkr-old", new Date(NOW.getTime() + MIN)), new Date(NOW.getTime() + MIN));

    const [row] = await db.select().from(workerHeartbeats);
    expect(row!.instanceId).toBe("wkr-new");
    expect(row!.beatAt.getTime()).toBe(NOW.getTime());
    expect(row!.mailboxes).toBe(2);
  });

  it("NEVER INSERTS — a refresh can never announce a leader that never claimed the shard", async () => {
    const db = await makeTestDb();
    await refreshHeartbeat(db, refresh("wkr-1", NOW), NOW);
    expect(await db.select().from(workerHeartbeats)).toHaveLength(0);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   Rule 8 — device_sync_stale: the alarm a week of dead desktop sync did not have
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("evaluateAlerts — device_sync_stale, against seeded mirror states", () => {
  const DAY = 24 * HOUR;

  /**
   * A user + native device + session, with the device's last horizon `syncAge` ago.
   *
   * The "account moved on" evidence is a MAILBOX whose `last_sync_at` is `newerChangeAge` ago —
   * the worker synced the account after the device's horizon. (The rule reads this rather than
   * `change_log`, which the blind alert role is deliberately refused; see rule 8's header.)
   */
  async function seedDevice(
    db: Db,
    opts: {
      kind?: string;
      syncAge: number | null;
      createdAge?: number;               // device row age; defaults to the DB clock's "now"
      sessionRevokedAge?: number | null; // null/absent = live session; a number = revoked that long ago
      sessionSeenAge?: number;           // the session's last request this long ago; absent = the DB default (fresh)
      newerChangeAge?: number | null;    // a mailbox sync this long ago (must be < syncAge to matter)
    },
  ): Promise<{ accountId: string; deviceId: string }> {
    const accountId = await seedAccount(db, "DeviceSync");
    const { users, devices, sessions } = await import("@trafficflow/db");
    const [user] = await db.insert(users).values({
      accountId, email: `dev-${Math.random().toString(36).slice(2, 10)}@example.test`,
    }).returning();
    const [dev] = await db.insert(devices).values({
      accountId, userId: user!.id, kind: opts.kind ?? "macos", label: "ohmail for Mac",
      lastSyncedAt: opts.syncAge === null ? null : ago(opts.syncAge),
      ...(opts.createdAge !== undefined ? { createdAt: ago(opts.createdAge) } : {}),
    }).returning();
    await db.insert(sessions).values({
      accountId, userId: user!.id, deviceId: dev!.id, familyId: crypto.randomUUID(),
      accessExpiresAt: NOW, refreshExpiresAt: NOW,
      revokedAt: opts.sessionRevokedAge == null ? null : ago(opts.sessionRevokedAge),
      ...(opts.sessionSeenAge !== undefined ? { lastSeenAt: ago(opts.sessionSeenAge) } : {}),
    });
    if (opts.newerChangeAge != null) {
      await seedMailbox(db, accountId, { lastSyncAge: opts.newerChangeAge });
    }
    return { accountId, deviceId: dev!.id };
  }

  it("FIRES for a native device 4 days quiet while its account moved on (live session)", async () => {
    const db = await makeTestDb();
    const { deviceId } = await seedDevice(db, { syncAge: 4 * DAY, newerChangeAge: HOUR });
    const alerts = await evaluateAlerts(db, { now: NOW });
    const hit = alerts.find((a) => a.kind === "device_sync_stale");
    expect(hit, "a mirror four days behind a moving account must page").toBeTruthy();
    expect(hit!.key).toBe(`device_sync_stale:${deviceId}`);
    expect(hit!.severity).toBe("warning");
  });

  it("FIRES for a device whose session was killed by reuse detection 2 days ago", async () => {
    const db = await makeTestDb();
    const { deviceId } = await seedDevice(db, {
      syncAge: 4 * DAY, newerChangeAge: HOUR, sessionRevokedAge: 2 * DAY,
    });
    const alerts = await evaluateAlerts(db, { now: NOW });
    expect(alerts.some((a) => a.key === `device_sync_stale:${deviceId}`),
      "reuse detection tells nobody — the alert is how an operator learns").toBe(true);
  });

  it("stays quiet for a device revoked beyond the 14-day arm window (retired, not broken)", async () => {
    const db = await makeTestDb();
    await seedDevice(db, { syncAge: 40 * DAY, newerChangeAge: HOUR, sessionRevokedAge: 20 * DAY });
    const alerts = await evaluateAlerts(db, { now: NOW });
    expect(alerts.some((a) => a.kind === "device_sync_stale")).toBe(false);
  });

  it("stays quiet for a dormant account — no mailbox synced after the device's horizon", async () => {
    const db = await makeTestDb();
    await seedDevice(db, { syncAge: 4 * DAY, newerChangeAge: 5 * DAY });
    const alerts = await evaluateAlerts(db, { now: NOW });
    expect(alerts.some((a) => a.kind === "device_sync_stale"),
      "an account with no new mail has nothing the device missed").toBe(false);
  });

  it("stays quiet for a web device — a closed browser tab is not an incident", async () => {
    const db = await makeTestDb();
    await seedDevice(db, { kind: "web", syncAge: 4 * DAY, newerChangeAge: HOUR });
    const alerts = await evaluateAlerts(db, { now: NOW });
    expect(alerts.some((a) => a.kind === "device_sync_stale")).toBe(false);
  });

  /**
   * THE NEVER-SYNCED ARM — the reversal of this suite's own earlier ruling, and the incident
   * is the argument. This test used to read "stays quiet for a device that never completed a
   * drain (NULL stamp asserts nothing)", and the first REAL staleness incident arrived exactly
   * there: a wedged mirror is NULL right up until the first time it converges, so the very
   * population the alert existed for was excluded by construction. A NULL stamp older than the
   * threshold, on a device whose session is LIVE and whose account moved on since pairing, is
   * an assertion: paired, armed, never once current.
   */
  it("FIRES for a native device paired 4 days ago that NEVER completed a drain (live session)", async () => {
    const db = await makeTestDb();
    const { deviceId } = await seedDevice(db, {
      syncAge: null, createdAge: 4 * DAY, newerChangeAge: HOUR,
      // Explicitly STILL REQUESTING — the arm's second gate. Stated rather than inherited from
      // the column default, which happens to be the wall clock and proves nothing on purpose.
      sessionSeenAge: MIN,
    });
    const alerts = await evaluateAlerts(db, { now: NOW });
    const hit = alerts.find((a) => a.key === `device_sync_stale:${deviceId}`);
    expect(hit, "a device that never once converged since pairing is the incident, not a non-event").toBeTruthy();
    expect(hit!.title).toContain("NEVER");
  });

  it("never-synced stays quiet for a DEAD HANDSHAKE — unrevoked but frozen since its mint", async () => {
    // The measured false page: a test pairing whose one session was last seen the
    // instant it was created, fifteen days back. Live in the column's sense, dead in every
    // human one — nobody is looking at a frozen mailbox, because nothing ever asked for mail.
    const db = await makeTestDb();
    await seedDevice(db, {
      syncAge: null, createdAge: 15 * DAY, newerChangeAge: HOUR, sessionSeenAge: 15 * DAY,
    });
    const alerts = await evaluateAlerts(db, { now: NOW });
    expect(alerts.some((a) => a.kind === "device_sync_stale"),
      "a session that stopped requesting at its own creation is a dead pairing, not a wedged person").toBe(false);
  });

  it("never-synced stays quiet when the session is REVOKED — taken back is not wedged", async () => {
    // Different from the stamped arm's 14-day window on purpose: a never-synced device with a
    // revoked session is a pairing that never worked and was already taken back (test fixtures
    // are exactly this shape) — nobody is reading stale mail from a mirror that never showed any.
    const db = await makeTestDb();
    await seedDevice(db, { syncAge: null, createdAge: 4 * DAY, newerChangeAge: HOUR, sessionRevokedAge: HOUR });
    const alerts = await evaluateAlerts(db, { now: NOW });
    expect(alerts.some((a) => a.kind === "device_sync_stale")).toBe(false);
  });

  it("never-synced stays quiet inside the threshold — a fresh pairing is still bootstrapping", async () => {
    const db = await makeTestDb();
    await seedDevice(db, { syncAge: null, createdAge: 2 * DAY, newerChangeAge: HOUR });
    const alerts = await evaluateAlerts(db, { now: NOW });
    expect(alerts.some((a) => a.kind === "device_sync_stale")).toBe(false);
  });

  it("never-synced stays quiet when the account never moved on since pairing", async () => {
    const db = await makeTestDb();
    await seedDevice(db, { syncAge: null, createdAge: 4 * DAY, newerChangeAge: 5 * DAY });
    const alerts = await evaluateAlerts(db, { now: NOW });
    expect(alerts.some((a) => a.kind === "device_sync_stale")).toBe(false);
  });

  it("stays quiet inside the threshold — two days is a weekend, not a page", async () => {
    const db = await makeTestDb();
    await seedDevice(db, { syncAge: 2 * DAY, newerChangeAge: HOUR });
    const alerts = await evaluateAlerts(db, { now: NOW });
    expect(alerts.some((a) => a.kind === "device_sync_stale")).toBe(false);
  });

  it("the pass sends the same statements with 1 stale device and with 200", async () => {
    const db = await makeTestDb();
    const seen = recordStatements(db);
    await seedDevice(db, { syncAge: 4 * DAY, newerChangeAge: HOUR });
    let at = seen.length;
    const one = await evaluateAlerts(db, { now: NOW });
    const forOne = seen.length - at;
    for (let i = 0; i < 100; i++) await seedDevice(db, { syncAge: 4 * DAY, newerChangeAge: HOUR });
    for (let i = 0; i < 99; i++) await seedDevice(db, { syncAge: null, createdAge: 4 * DAY, newerChangeAge: HOUR });
    at = seen.length;
    const many = await evaluateAlerts(db, { now: NOW });
    expect(one.filter((a) => a.kind === "device_sync_stale")).toHaveLength(1);
    expect(many.filter((a) => a.kind === "device_sync_stale")).toHaveLength(200);
    expect(seen.length - at, "the statements grew with the stale devices").toBe(forOne);
  });

  it("the whole pass records 1 standing device alert and 200 in the same statements", async () => {
    const db = await makeTestDb();
    const seen = recordStatements(db);
    // The accounts moved on MINUTES ago, so no mailbox lags and the device alerts are the only ones.
    await seedDevice(db, { syncAge: 4 * DAY, newerChangeAge: 5 * MIN });
    const pass = () => runAlertPass(db, { now: NOW, sinks: [], shards: [], source: "worker", environment: "test" });
    await pass();
    let at = seen.length;
    await pass();
    const forOne = seen.length - at;
    for (let i = 0; i < 199; i++) await seedDevice(db, { syncAge: 4 * DAY, newerChangeAge: 5 * MIN });
    await pass();
    at = seen.length;
    const r = await pass();
    const forMany = seen.length - at;
    expect([...new Set(r.firing.map((a) => a.kind))]).toEqual(["device_sync_stale"]);
    expect(r.firing).toHaveLength(200);
    const rows = await db.select().from(alertState);
    expect(rows.filter((x) => x.kind === "device_sync_stale" && x.resolvedAt === null)).toHaveLength(200);
    expect(forMany, "recording the observations grew with the alerts").toBe(forOne);
  });

  it("another account's sync does not move a device's account on, and another device's session does not arm it", async () => {
    const db = await makeTestDb();
    const quiet = await seedDevice(db, { syncAge: 4 * DAY, newerChangeAge: null });
    const busy = await seedAccount(db, "Busy");
    await seedMailbox(db, busy, { lastSyncAge: HOUR });
    const armedSibling = await seedDevice(db, { syncAge: 4 * DAY, newerChangeAge: HOUR });
    const { devices, users } = await import("@trafficflow/db");
    const [user] = await db.insert(users).values({ accountId: armedSibling.accountId, email: `bare-${Math.random().toString(36).slice(2, 10)}@example.test` }).returning();
    const [bare] = await db.insert(devices).values({
      accountId: armedSibling.accountId, userId: user!.id, kind: "macos", label: "no session", lastSyncedAt: ago(4 * DAY),
    }).returning();
    const keys = (await evaluateAlerts(db, { now: NOW })).filter((a) => a.kind === "device_sync_stale").map((a) => a.key);
    expect(keys).toEqual([`device_sync_stale:${armedSibling.deviceId}`]);
    expect(keys).not.toContain(`device_sync_stale:${quiet.deviceId}`);
    expect(keys).not.toContain(`device_sync_stale:${bare!.id}`);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   The renotify policy — a standing condition pages on change or on the long interval
   ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * ── MUTATIONS RUN, WATCHED RED, RESTORED (2026-08-25) ─────────────────────────────────────
 *   · never-synced arm's `gt(lastSeenAt, deviceStaleCut)` removed ⇒ "DEAD HANDSHAKE" fires
 *   · the claim's signature arm removed                           ⇒ "CHANGED condition" holds
 *   · the tier split collapsed to `repeatMs` for every severity   ⇒ "UNCHANGED standing
 *     warning" re-pages at the hourly mark
 *   · the claim writing the signature beside its lease            ⇒ "FAILED delivery leaves
 *     the signature untouched" reads the pending value off the row
 *   · the active-lease refusal removed                            ⇒ "MID-DELIVERY" pages the
 *     duplicate and orphans the outer confirm
 */
describe("runAlertPass — the renotify policy for standing conditions", () => {
  const DAY = 24 * HOUR;

  /**
   * A standing WARNING with a fixed signature that is also an INCIDENT — the reconciler dark.
   *
   * ── RE-AIMED, NOT WEAKENED (cloud 0030) ────────────────────────────────────────────────
   *
   * This fixture used to be a never-synced native device, and that rule is now a SIGNAL: the
   * mail is safe and one person's mirror broke, so it is recorded and rendered and never
   * delivered. A signal is therefore never claimed and never appears in `notified`, which is
   * precisely what the class was added to do — so the old fixture stopped being able to
   * demonstrate the renotify SCHEDULE at all.
   *
   * `billing_reconciliation_stale` is the rule this test now stands on, and it is the right
   * one on every axis the test needs: `warning` severity (so it takes the long unchanged hold
   * rather than the hourly critical repeat — the whole subject here), `incident` class (so it
   * is delivered), and a signature of `warning|1` that cannot move as the clock advances. The
   * condition also STRENGTHENS with time rather than resolving, so the same row is genuinely
   * standing at every one of the three clocks below.
   *
   * The measured failure this test exists for is unchanged and is not device-specific: a true
   * standing warning, emailed on every repeat interval with nothing different but the age in
   * its sentence.
   */
  /**
   * ONE ACCOUNT AT ITS STORAGE CAP, held by the host's own reader.
   *
   * The condition has to stand UNCHANGED while only the clock moves, which rules out every
   * window- and age-driven rule: a lagging mailbox crosses into the critical tier two hours in
   * and the key changes underneath the case. `storage_at_cap` is a warning whose population is
   * whatever `accountsAtCap` answers, so a constant reader is a constant condition — and it
   * doubles as this seam's positive control, which nothing else in the suite supplies.
   *
   * It replaced a stale-reconciliation row, whose rule left with the reconciler.
   */
  const standingAtCap = { accountsAtCap: async () => ({ atCap: AT_CAP, read: AT_CAP.length, total: AT_CAP.length }) };

  it("an UNCHANGED standing warning pages once, holds through the hourly mark, re-pages after a day", async () => {
    // THE MEASURED FAILURE: a true device_sync_stale warning, emailed on every repeat interval
    // for fifteen days with nothing changed but the age in its sentence. The condition below
    // stands unchanged across all three passes; only the clock moves.
    const db = await makeTestDb();
    await seedHeartbeat(db, 10_000);
    const key = "storage_at_cap";
    const sink = spySink("spy");

    const first = await runAlertPass(db, { now: NOW, sinks: [sink], ...standingAtCap });
    expect(first.notified.map((a) => a.key)).toContain(key);

    // Two hours on — past the OLD hourly repeat, condition unchanged: held.
    const held = await runAlertPass(db, {
      now: new Date(NOW.getTime() + 2 * HOUR), sinks: [sink], ...standingAtCap,
    });
    expect(held.firing.map((a) => a.key), "the condition still stands").toContain(key);
    expect(held.notified.map((a) => a.key), "unchanged ⇒ no page at the hourly mark").not.toContain(key);

    // Past the unchanged interval: the daily reminder.
    const reminded = await runAlertPass(db, {
      now: new Date(NOW.getTime() + 25 * HOUR), sinks: [sink], ...standingAtCap,
    });
    expect(reminded.notified.map((a) => a.key)).toContain(key);

    const [row] = await db.select().from(alertState).where(eq(alertState.alertKey, key));
    expect(row!.notifyCount).toBe(2);
  });

  it("a CHANGED condition re-pages immediately, inside any interval", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db, 10_000);
    await seedFiringRow(db, a, HOUR, "evt_sig_1");
    const sink = spySink("spy");

    const first = await runAlertPass(db, { now: NOW, sinks: [sink] });
    expect(first.notified.map((x) => x.key)).toContain("sends_stuck");

    // Five minutes later the COUNT moves 1 → 2: the signature differs, so the page goes out
    // now, not at the top of the hour.
    await seedFiringRow(db, a, HOUR, "evt_sig_2");
    const changed = await runAlertPass(db, { now: new Date(NOW.getTime() + 5 * MIN), sinks: [sink] });
    expect(changed.notified.map((x) => x.key),
      "count 1 → 2 is a state change and pages at once").toContain("sends_stuck");

    // Control: five more minutes, nothing moved — held again.
    const held = await runAlertPass(db, { now: new Date(NOW.getTime() + 10 * MIN), sinks: [sink] });
    expect(held.firing.map((x) => x.key)).toContain("sends_stuck");
    expect(held.notified.map((x) => x.key)).not.toContain("sends_stuck");
  });

  it("a change inside the stale-evaluation floor holds one beat, then pages", async () => {
    // The change arm's floor (`claimTtlMs`): a signature that differs within seconds of the
    // last confirm may be a SLOWER driver's older snapshot, not news — so the claim waits out
    // the claim-TTL window. A pass runs every minute, so a genuine change still pages within
    // one cadence plus the floor; what can no longer happen is an older evaluation reclaiming
    // a condition a newer pass just confirmed.
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db, 10_000);
    await seedFiringRow(db, a, HOUR, "evt_floor_1");
    const sink = spySink("spy");

    await runAlertPass(db, { now: NOW, sinks: [sink] });

    await seedFiringRow(db, a, HOUR, "evt_floor_2");
    const inside = await runAlertPass(db, { now: new Date(NOW.getTime() + MIN), sinks: [sink] });
    expect(inside.firing.map((x) => x.key)).toContain("sends_stuck");
    expect(inside.notified.map((x) => x.key),
      "one minute after a confirm, an unequal signature is not yet trusted").not.toContain("sends_stuck");

    const past = await runAlertPass(db, { now: new Date(NOW.getTime() + 3 * MIN), sinks: [sink] });
    expect(past.notified.map((x) => x.key)).toContain("sends_stuck");
  });

  it("a FAILED delivery leaves the signature untouched, so the change still pages on the retry", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db, 10_000);
    await seedFiringRow(db, a, HOUR, "evt_rel_1");
    const ok = spySink("ok");
    const dead = spySink("dead", false);

    await runAlertPass(db, { now: NOW, sinks: [ok] });

    // The condition changes, but the only sink refuses: the claim is RELEASED. The claim
    // wrote only the lease, so the row still records the CONFIRMED condition — this is the
    // invariant that makes the crash path safe too: a signature persisted at claim time would
    // read as "already told them" after a mid-delivery death, suppressing the change for the
    // whole tier interval instead of retrying after the TTL.
    await seedFiringRow(db, a, HOUR, "evt_rel_2");
    const refused = await runAlertPass(db, { now: new Date(NOW.getTime() + 5 * MIN), sinks: [dead] });
    expect(refused.notified.map((x) => x.key)).toContain("sends_stuck");
    expect(refused.delivered).toEqual([]);

    const [row] = await db.select().from(alertState).where(eq(alertState.alertKey, "sends_stuck"));
    // The stored peak: critical (2), one step of count (pow2Floor(1) = 1).
    expect(row!.notifiedSignature, "only a CONFIRM may move the peak").toBe("peak|2|1");
    expect(row!.claimedUntil, "the release cleared its lease").toBeNull();

    const retry = await runAlertPass(db, { now: new Date(NOW.getTime() + 6 * MIN), sinks: [ok] });
    expect(retry.notified.map((x) => x.key),
      "the undelivered change re-pages — a misconfigured sink must not swallow it").toContain("sends_stuck");
    const [after] = await db.select().from(alertState).where(eq(alertState.alertKey, "sends_stuck"));
    expect(after!.notifiedSignature, "the confirm raised the peak to count 2").toBe("peak|2|2");
  });

  it("an ABANDONED changed-condition claim retries after the TTL — never the tier interval", async () => {
    // The crash invariant, held at the row: a pass that claimed a changed condition and died
    // mid-delivery leaves only an expiring lease. Simulated exactly as a crash leaves it —
    // the claim's own write (the lease) with no settle — which under the fixed protocol is
    // BY CONSTRUCTION the pre-claim row plus a lease, because the claim writes nothing else.
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db, 10_000);
    await seedFiringRow(db, a, HOUR, "evt_crash_1");
    const sink = spySink("spy");
    await runAlertPass(db, { now: NOW, sinks: [sink] }); // confirmed: sig critical|1

    // The condition changes and a claim is taken that never settles (the pass died).
    await seedFiringRow(db, a, HOUR, "evt_crash_2");
    await db.update(alertState)
      .set({ claimedUntil: new Date(NOW.getTime() + 5 * MIN + DEFAULT_CLAIM_TTL_MS) })
      .where(eq(alertState.alertKey, "sends_stuck"));

    // While the lease lives, every arm holds.
    const held = await runAlertPass(db, { now: new Date(NOW.getTime() + 6 * MIN), sinks: [sink] });
    expect(held.notified.map((x) => x.key)).not.toContain("sends_stuck");

    // The moment it expires, the changed condition pages — claimTtl, not an hour.
    const recovered = await runAlertPass(db, {
      now: new Date(NOW.getTime() + 5 * MIN + DEFAULT_CLAIM_TTL_MS + 1_000), sinks: [sink],
    });
    expect(recovered.notified.map((x) => x.key),
      "a crashed claim must cost claimTtlMs, not the tier interval").toContain("sends_stuck");
  });

  it("a CHANGED condition observed MID-DELIVERY is refused — the lease blocks every arm", async () => {
    // The review-caught duplicate: while one driver's page is in flight, the row's lease used
    // to be encoded in `notified_at` at a value the change arm read as an ancient confirm, so
    // a second driver with a different signature could reclaim the live row, page stale
    // numbers and orphan the first driver's settle. Reproduced by running a second pass FROM
    // INSIDE the first pass's delivery — the exact overlap two drivers produce.
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db, 10_000);
    await seedFiringRow(db, a, HOUR, "evt_lease_1");

    let innerNotified: string[] | null = null;
    const inner = spySink("inner");
    const sink: AlertSink & { seen: Alert[][] } = {
      name: "outer",
      seen: [],
      async notify(alerts) {
        this.seen.push([...alerts]);
        // Mid-delivery, the condition CHANGES and a second driver runs a whole pass.
        await seedFiringRow(db, a, HOUR, "evt_lease_2");
        const second = await runAlertPass(db, { now: new Date(NOW.getTime() + 1_000), sinks: [inner] });
        innerNotified = second.notified.map((x) => x.key);
        return true;
      },
    };

    const first = await runAlertPass(db, { now: NOW, sinks: [sink] });
    expect(first.notified.map((x) => x.key)).toContain("sends_stuck");
    expect(innerNotified, "the overlapping driver ran").not.toBeNull();
    expect(innerNotified!, "a live lease refuses even a changed signature").not.toContain("sends_stuck");

    // …and the outer pass's confirm was not orphaned: the count landed.
    const [row] = await db.select().from(alertState).where(eq(alertState.alertKey, "sends_stuck"));
    expect(row!.notifyCount).toBe(1);

    // The change is news, not noise: once the floor passes, the next pass pages it.
    const later = await runAlertPass(db, { now: new Date(NOW.getTime() + 3 * MIN), sinks: [inner] });
    expect(later.notified.map((x) => x.key)).toContain("sends_stuck");
  });

  it("a standing CRITICAL keeps the hourly nag — the tier split leaves it alone", async () => {
    // The complement of the warning test above, pinned so the split cannot silently flip:
    // a critical kind with an UNCHANGED count still re-pages at the hour.
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db, 10_000);
    await seedFiringRow(db, a, HOUR, "evt_crit");
    const sink = spySink("spy");

    await runAlertPass(db, { now: NOW, sinks: [sink] });
    const held = await runAlertPass(db, { now: new Date(NOW.getTime() + 30 * MIN), sinks: [sink] });
    expect(held.notified.map((x) => x.key), "half an hour is inside even the critical interval").not.toContain("sends_stuck");
    const hourly = await runAlertPass(db, { now: new Date(NOW.getTime() + HOUR + MIN), sinks: [sink] });
    expect(hourly.notified.map((x) => x.key)).toContain("sends_stuck");
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   Rule 8b — session_sync_stale: the deviceless install the device rule cannot see
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("evaluateAlerts — session_sync_stale, the browser-door install's alarm", () => {
  const DAY = 24 * HOUR;

  /**
   * A user + SESSION (deviceless by default — mail 0061's ordinary shape), with the session's
   * last horizon `syncAge` ago and its last request `seenAge` ago. The moved-on evidence is
   * the same mailbox stamp rule 8 reads.
   */
  async function seedSession(
    db: Db,
    opts: {
      syncAge: number | null;
      seenAge: number;
      scope?: string;
      revoked?: boolean;
      deviceKind?: string;            // present = a device-BACKED session of this kind
      newerChangeAge?: number | null;
    },
  ): Promise<{ accountId: string; sessionId: string }> {
    const accountId = await seedAccount(db, "SessionSync");
    const { users, devices, sessions } = await import("@trafficflow/db");
    const [user] = await db.insert(users).values({
      accountId, email: `sess-${Math.random().toString(36).slice(2, 10)}@example.test`,
    }).returning();
    let deviceId: string | null = null;
    if (opts.deviceKind) {
      const [dev] = await db.insert(devices).values({
        accountId, userId: user!.id, kind: opts.deviceKind, label: "seeded",
      }).returning();
      deviceId = dev!.id;
    }
    const [session] = await db.insert(sessions).values({
      accountId, userId: user!.id, deviceId, familyId: crypto.randomUUID(),
      scope: opts.scope ?? "full",
      accessExpiresAt: NOW, refreshExpiresAt: NOW,
      lastSeenAt: ago(opts.seenAge),
      lastSyncedAt: opts.syncAge === null ? null : ago(opts.syncAge),
      revokedAt: opts.revoked ? ago(HOUR) : null,
    }).returning();
    if (opts.newerChangeAge != null) {
      await seedMailbox(db, accountId, { lastSyncAge: opts.newerChangeAge });
    }
    return { accountId, sessionId: session!.id };
  }

  it("FIRES for a deviceless session 4 days behind that is STILL making requests — the incident", async () => {
    // The measured shape: a browser-door desktop, wedged, rotating its refresh family four
    // times an hour for days — last_seen fresh, horizon ancient, account moving.
    const db = await makeTestDb();
    const { sessionId } = await seedSession(db, { syncAge: 4 * DAY, seenAge: MIN, newerChangeAge: HOUR });
    const alerts = await evaluateAlerts(db, { now: NOW });
    const hit = alerts.find((a) => a.kind === "session_sync_stale");
    expect(hit, "a signed-in install whose pulls stopped converging must page").toBeTruthy();
    expect(hit!.key).toBe(`session_sync_stale:${sessionId}`);
    expect(hit!.severity).toBe("warning");
  });

  it("FIRES for a paired WEB device's session — the kind the device rule excludes on purpose", async () => {
    const db = await makeTestDb();
    const { sessionId } = await seedSession(db, {
      syncAge: 4 * DAY, seenAge: MIN, deviceKind: "web", newerChangeAge: HOUR,
    });
    const alerts = await evaluateAlerts(db, { now: NOW });
    expect(alerts.some((a) => a.key === `session_sync_stale:${sessionId}`),
      "an OPEN, wedged phone browser is the same incident one kind over").toBe(true);
  });

  it("stays quiet for a closed tab — last_seen aged out with the stamp", async () => {
    const db = await makeTestDb();
    await seedSession(db, { syncAge: 5 * DAY, seenAge: 5 * DAY, newerChangeAge: HOUR });
    const alerts = await evaluateAlerts(db, { now: NOW });
    expect(alerts.some((a) => a.kind === "session_sync_stale"),
      "a session that stopped requesting is a closed client, not a wedged one").toBe(false);
  });

  it("stays quiet for a session that never stamped — a REST-only caller is not a sync client", async () => {
    const db = await makeTestDb();
    await seedSession(db, { syncAge: null, seenAge: MIN, newerChangeAge: HOUR });
    const alerts = await evaluateAlerts(db, { now: NOW });
    expect(alerts.some((a) => a.kind === "session_sync_stale")).toBe(false);
  });

  it("stays quiet for a session on a NATIVE device — that install is the device rule's", async () => {
    const db = await makeTestDb();
    await seedSession(db, {
      syncAge: 4 * DAY, seenAge: MIN, deviceKind: "macos", newerChangeAge: HOUR,
    });
    const alerts = await evaluateAlerts(db, { now: NOW });
    expect(alerts.some((a) => a.kind === "session_sync_stale"),
      "one install must not page under two keys").toBe(false);
  });

  it("stays quiet for a revoked session, a dormant account, and inside the threshold", async () => {
    const db = await makeTestDb();
    await seedSession(db, { syncAge: 4 * DAY, seenAge: MIN, revoked: true, newerChangeAge: HOUR });
    await seedSession(db, { syncAge: 4 * DAY, seenAge: MIN, newerChangeAge: 5 * DAY });
    await seedSession(db, { syncAge: 2 * DAY, seenAge: MIN, newerChangeAge: HOUR });
    const alerts = await evaluateAlerts(db, { now: NOW });
    expect(alerts.some((a) => a.kind === "session_sync_stale")).toBe(false);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   Rule 9 — session_reuse_revoked: the sweep that used to leave no record
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("evaluateAlerts — session_reuse_revoked, from the auth_events trail", () => {
  async function seedReuseEvent(db: Db, accountId: string, age: number): Promise<void> {
    const { authEvents } = await import("../src/cloud.js");
    await db.insert(authEvents).values({
      accountId, event: "refresh_reuse_revoked", at: ago(age),
      device: "family=00000000-0000-0000-0000-000000000000 session=00000000-0000-0000-0000-000000000001",
    });
  }

  it("FIRES per account while a reuse revocation is inside the window, with the count", async () => {
    const db = await makeTestDb();
    const accountId = await seedAccount(db, "ReuseAlert");
    await seedReuseEvent(db, accountId, 2 * HOUR);
    await seedReuseEvent(db, accountId, HOUR);
    const alerts = await evaluateAlerts(db, { now: NOW });
    const hit = alerts.find((a) => a.kind === "session_reuse_revoked");
    expect(hit, "a family swept by reuse detection is an attack or a broken client — page").toBeTruthy();
    expect(hit!.key).toBe(`session_reuse_revoked:${accountId}`);
    expect(hit!.count).toBe(2);
    expect(hit!.severity).toBe("warning");
  });

  it("self-resolves once the window slides past — alert_state keeps the history", async () => {
    const db = await makeTestDb();
    const accountId = await seedAccount(db, "ReuseAlertOld");
    await seedReuseEvent(db, accountId, 25 * HOUR);
    const alerts = await evaluateAlerts(db, { now: NOW });
    expect(alerts.some((a) => a.kind === "session_reuse_revoked")).toBe(false);
  });

  it("does NOT count a refresh_attempt_revoked sweep: a person's own late answer writes it too", async () => {
    const db = await makeTestDb();
    const accountId = await seedAccount(db, "ReuseAlertAttempt");
    const { authEvents } = await import("../src/cloud.js");
    await db.insert(authEvents).values({
      accountId, event: "refresh_attempt_revoked", at: ago(HOUR),
      device: "family=00000000-0000-0000-0000-000000000000 session=00000000-0000-0000-0000-000000000001 cause=attempt_mismatch",
    });
    const alerts = await evaluateAlerts(db, { now: NOW });
    expect(alerts.some((a) => a.kind === "session_reuse_revoked")).toBe(false);
    await seedReuseEvent(db, accountId, HOUR);
    const again = await evaluateAlerts(db, { now: NOW });
    expect(again.find((a) => a.kind === "session_reuse_revoked")?.count, "the stolen-token sweep beside it still counts, alone").toBe(1);
  });

  it("ignores every other auth event — logins are activity, not incidents", async () => {
    const db = await makeTestDb();
    const accountId = await seedAccount(db, "ReuseAlertLogin");
    const { authEvents } = await import("../src/cloud.js");
    await db.insert(authEvents).values({ accountId, event: "login", at: ago(HOUR) });
    const alerts = await evaluateAlerts(db, { now: NOW });
    expect(alerts.some((a) => a.kind === "session_reuse_revoked")).toBe(false);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   Rule 9c — session_refresh_replayed: the client that cannot adopt what it is given
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("evaluateAlerts — session_refresh_replayed, from the auth_events trail", () => {
  async function seedReplay(db: Db, accountId: string, age: number): Promise<void> {
    const { authEvents } = await import("../src/cloud.js");
    await db.insert(authEvents).values({
      accountId, event: "refresh_replayed", at: ago(age),
      device: "family=00000000-0000-0000-0000-000000000000 session=00000000-0000-0000-0000-000000000001 surface=cookie",
    });
  }
  const CUT = DEFAULT_ALERT_THRESHOLDS.refreshReplayedThreshold;

  it("FIRES per account once the replays inside the window reach the cut", async () => {
    const db = await makeTestDb();
    const accountId = await seedAccount(db, "ReplayAlert");
    for (let i = 0; i < CUT; i += 1) await seedReplay(db, accountId, (i + 1) * MIN);
    const alerts = await evaluateAlerts(db, { now: NOW });
    const hit = alerts.find((a) => a.kind === "session_refresh_replayed");
    expect(hit, "a client replaying more often than it rotates is worth seeing").toBeTruthy();
    expect(hit!.key).toBe(`session_refresh_replayed:${accountId}`);
    expect(hit!.count).toBe(CUT);
    expect(hit!.severity).toBe("warning");
    // Nothing died, so nobody is paged: this is a question for daylight.
    expect(hit!.cls).toBe("signal");
    expect(hit!.oldestSeconds).toBe(CUT * 60);
  });

  it("is SILENT one below the cut — a dropped answer is the case the retry arm made cheap", async () => {
    const db = await makeTestDb();
    const accountId = await seedAccount(db, "ReplayAlertQuiet");
    for (let i = 0; i < CUT - 1; i += 1) await seedReplay(db, accountId, (i + 1) * MIN);
    const alerts = await evaluateAlerts(db, { now: NOW });
    expect(alerts.some((a) => a.kind === "session_refresh_replayed"),
      "the ordinary lost answer must never page anybody").toBe(false);
  });

  it("self-resolves once the window slides past — the same rows, an hour older", async () => {
    const db = await makeTestDb();
    const accountId = await seedAccount(db, "ReplayAlertOld");
    for (let i = 0; i < CUT + 3; i += 1) await seedReplay(db, accountId, 2 * HOUR);
    const alerts = await evaluateAlerts(db, { now: NOW });
    expect(alerts.some((a) => a.kind === "session_refresh_replayed")).toBe(false);
  });

  it("counts replays ONLY — a reuse sweep is a different rule and a different answer", async () => {
    const db = await makeTestDb();
    const accountId = await seedAccount(db, "ReplayAlertSweep");
    const { authEvents } = await import("../src/cloud.js");
    for (let i = 0; i < CUT + 2; i += 1) {
      await db.insert(authEvents).values({
        accountId, event: "refresh_reuse_revoked", at: ago(MIN),
        device: "family=00000000-0000-0000-0000-000000000000 session=00000000-0000-0000-0000-000000000001",
      });
    }
    const alerts = await evaluateAlerts(db, { now: NOW });
    expect(alerts.some((a) => a.kind === "session_refresh_replayed"),
      "a swept family is rule 9's row, never this one").toBe(false);
    expect(alerts.some((a) => a.kind === "session_reuse_revoked")).toBe(true);
  });

  it("keys per account — two broken clients are two rows", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db, "ReplayAlertA");
    const b = await seedAccount(db, "ReplayAlertB");
    for (let i = 0; i < CUT; i += 1) {
      await seedReplay(db, a, (i + 1) * MIN);
      await seedReplay(db, b, (i + 1) * MIN);
    }
    const alerts = await evaluateAlerts(db, { now: NOW });
    const keys = alerts.filter((x) => x.kind === "session_refresh_replayed").map((x) => x.key).sort();
    expect(keys).toEqual([`session_refresh_replayed:${a}`, `session_refresh_replayed:${b}`].sort());
  });
});

describe("firingToLog — a standing alert is logged once, not every pass", () => {
  const alert = (key: string, count = 1): Alert => ({
    key, kind: "device_sync_stale", severity: "warning", title: "t", detail: "d", count, oldestSeconds: 1,
  } as Alert);
  it("logs a new key once, again on a changed signature, and again after it cleared", () => {
    const logged = new Map<string, string>();
    expect(firingToLog(logged, [alert("a"), alert("b")]).map((x) => x.key)).toEqual(["a", "b"]);
    expect(firingToLog(logged, [alert("a"), alert("b")])).toEqual([]);
    expect(firingToLog(logged, [alert("a", 2), alert("b")]).map((x) => x.key)).toEqual(["a"]);
    expect(firingToLog(logged, [alert("a", 2)])).toEqual([]);
    expect(firingToLog(logged, [alert("a", 2), alert("b")]).map((x) => x.key)).toEqual(["b"]);
  });
});
