import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { randomUUID } from "node:crypto";
import { runWorkerSupervised } from "../src/supervisor.js";
import { acquireLeaderLock } from "../src/leader-lock.js";
import { DEFAULT_SERVING_NOTHING_MAX_MS, type WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * `/health` MUST NOT REPORT HEALTHY WHILE SYNCING NOTHING, against a real listener.
 *
 * `health-verdict.test.ts` is the truth table. This file is the part a table cannot prove: real
 * HTTP status codes out of a real supervisor, on the two transitions that decide whether an
 * outage is visible and whether a deployment can go live at all.
 *
 * Both directions of both rules are asserted, and the 200s matter as much as the 503s. Railway
 * will not stop the outgoing instance until the incoming one answers healthy, and the incoming
 * instance is a STANDBY for the whole of that window — so an over-eager bound here does not
 * make the product safer, it makes it unshippable.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
let DB = "";

type Db = ReturnType<typeof makeDb>;

interface Body {
  ok: boolean; healthy: boolean; leader: boolean; standby: boolean; takingOver: boolean;
  mailboxes: number; expected: number; quarantined: number; awaitingCredentials: number;
  unhealthyReason: string | null; waitingForLockSeconds: number | null;
  version: string; buildError: string | null;
  degraded: boolean; degradedReason: string | null;
  unserved: {
    total: number; quarantined: number; awaitingCredentials: number;
    standDown: number; leaseUnreadable: number; unaccounted: number;
  };
}

/** The credential that reads the whole health snapshot; the public body carries no count. */
const DETAIL = "d".repeat(32);
const detail = { headers: { authorization: `Bearer ${DETAIL}` } };

async function health(port: number): Promise<{ status: number; body: Body }> {
  const res = await fetch(`http://127.0.0.1:${port}/health`, detail);
  return { status: res.status, body: (await res.json()) as Body };
}

/** Poll until the published body satisfies `pred` — for shapes that are not a status change. */
async function waitForBody(
  port: number, pred: (b: Body) => boolean, ms: number, what: string,
): Promise<Body> {
  const start = Date.now();
  let last: Body | null = null;
  while (Date.now() - start < ms) {
    last = (await health(port)).body;
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`never saw ${what} in ${ms}ms; last = ${JSON.stringify(last)}`);
}

async function waitForStatus(port: number, want: number, ms: number): Promise<Body> {
  const start = Date.now();
  let last: Body | null = null;
  while (Date.now() - start < ms) {
    const h = await health(port);
    last = h.body;
    if (h.status === want) return h.body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`health never answered ${want} in ${ms}ms; last = ${JSON.stringify(last)}`);
}

/** A mailbox row with credentials — it will attach unless the fake refuses. */
async function seedMailbox(db: Db, accountId = randomUUID()): Promise<{ accountId: string; mailboxId: string }> {
  const [row] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test` }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return { accountId, mailboxId: row!.id };
}

/** Enabled, but with no `imap` credential row — expected, unservable, and NOT quarantined. */
async function seedMailboxWithoutCreds(db: Db): Promise<void> {
  await db.insert(mailboxes)
    .values({ accountId: randomUUID(), provider: "imap", address: `${randomUUID()}@trafficflow.test` });
}

function cfgFor(fleet: FakeAdapterFleet, over: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
    adapterFactory: fleet.factory, healthPort: 0, standbyRetryMs: 200, healthDetailSecret: DETAIL,
    rosterIntervalMs: 300, lockHeartbeatMs: 30_000, alertIntervalMs: 60_000,
    ...over,
  };
}

describe("/health bounds", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_p18"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } } }, ISOLATED_DB_RESET_BUDGET_MS);

  it("a standby that cannot take the lock goes 503 once it is past the bound", async () => {
    // The state that hid the 2026-08-02 outage, and the storage wedge before it: `leader:false,
    // standby:true, mailboxes:0`. Indistinguishable from a hot spare in every field the endpoint
    // published, so `healthy` was true for a worker syncing nothing.
    const fleet = new FakeAdapterFleet();
    const held = await acquireLeaderLock(DB);
    expect(held).not.toBeNull();
    closers.push(async () => { await held!.release(); });

    const sup = await runWorkerSupervised(cfgFor(fleet, { servingNothingMaxMs: 600 }));
    closers.push(() => sup.stop());
    expect(sup.state()).toBe("standby");

    const body = await waitForStatus(sup.healthPort, 503, 10_000);
    expect(body).toMatchObject({
      ok: false, healthy: false, leader: false, standby: true, takingOver: false,
      unhealthyReason: "waiting_for_lock",
    });
    expect(body.waitingForLockSeconds).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it("publishes the build identity — and a MISSING one never costs a 200", async () => {
    // ── WHY THIS IS AN e2e AND NOT A UNIT ASSERTION ─────────────────────────────────────────
    //
    // The claim under test is about the RESPONSE, and it has two halves that pull opposite ways.
    //
    // The first half is the feature: a worker deploy used to have no in-band confirmation at all
    // `railway deployment list` matching the `railway up` output is the deploy tool
    // agreeing with itself, and it is the evidence this field exists to replace — so the sha has
    // to reach the wire, out of a real listener, not merely reach a config object.
    //
    // The second half is the trap, and it is the reason this lives in THIS file. The API answers
    // `/health` 503 for a missing build identity, and copying that here would be a disaster of a
    // different order: Vercel does not gate a deployment on `/health` and **Railway does**
    // (`railway.toml` → `healthcheckPath`; a deployment that never answers healthy never goes
    // active). A 503 over a missing LABEL therefore means a worker that cannot say which build
    // it is can never be deployed — the bookkeeping gap becomes a refusal to ship the fix for
    // whatever the real incident was. Every other rule in this file was written to keep the
    // deploy gate honest; this one keeps a label from becoming the thing that closes it.
    //
    // MUTATION THAT MUST TURN THIS RED: in `supervisor.ts`, fold the label into the verdict —
    // `healthy: verdict.healthy && !config.buildError`. Nothing else in the suite notices.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    await seedMailbox(db);

    const stamped = await runWorkerSupervised(cfgFor(fleet, { buildVersion: "abc1234deadbeef" }));
    closers.push(() => stamped.stop());
    const good = await waitForStatus(stamped.healthPort, 200, 20_000);
    expect(good.version).toBe("abc1234deadbeef");
    expect(good.buildError).toBeNull();
    await stamped.stop();

    // The unlabelled build. `version` says so plainly rather than inventing one, `buildError`
    // explains it, and the STATUS CODE is unmoved.
    const blind = await runWorkerSupervised(cfgFor(fleet, {
      buildVersion: "dev",
      buildError: "no build identity: apps/worker/BUILD_VERSION is absent from this image",
    }));
    closers.push(() => blind.stop());
    const body = await waitForStatus(blind.healthPort, 200, 20_000);
    expect(body).toMatchObject({ ok: true, healthy: true, version: "dev" });
    expect(body.buildError).toMatch(/no build identity/);
    expect(body.unhealthyReason).toBeNull();
  }, 90_000);

  it("…but a deploy handover INSIDE the bound stays 200 and takes over — this is the deploy gate", async () => {
    // The direction that keeps the product shippable. Railway will not SIGTERM the outgoing
    // instance until the incoming one is Active AND healthy, and the incoming one is exactly
    // this standby. A bound that trips here means no deployment can ever go live.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    await seedMailbox(db);

    const held = await acquireLeaderLock(DB);
    expect(held).not.toBeNull();

    // The SHIPPED bound, not a test-shrunk one: two minutes against a measured 5.2 s handover.
    const sup = await runWorkerSupervised(cfgFor(fleet, { servingNothingMaxMs: DEFAULT_SERVING_NOTHING_MAX_MS }));
    closers.push(() => sup.stop());
    expect(sup.state()).toBe("standby");

    const spare = await health(sup.healthPort);
    expect(spare.status).toBe(200);
    expect(spare.body).toMatchObject({ ok: true, healthy: true, standby: true, unhealthyReason: null });

    // The outgoing instance releases; the spare that was allowed to live takes over and serves.
    await held!.release();
    const start = Date.now();
    while (sup.state() !== "leader" && Date.now() - start < 15_000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(sup.state()).toBe("leader");
    const after = await waitForStatus(sup.healthPort, 200, 10_000);
    expect(after).toMatchObject({ leader: true, standby: false, mailboxes: 1, unhealthyReason: null });
  }, 60_000);

  it("a TAKEOVER stays 200 past the bound — a real first sync must not read as an outage", async () => {
    // The supervisor publishes `standby: true` for the whole of `startWorkerWithLock`, which is
    // where the initial roster and every attach live. That window is minutes on a real mailbox —
    // a measured first sync took many of them — and calling it broken is the same mistake
    // the heartbeat pulse was written to stop making. `takingOver` is what tells the two apart:
    // this instance HOLDS the lock and is working, it is not a spare that cannot start.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    let release: () => void = () => { /* replaced */ };
    const gate = new Promise<void>((r) => { release = r; });
    fleet.behave(mb.mailboxId, { gate });
    closers.push(async () => { release(); });

    // The lock has to be held by somebody else first: `runWorkerSupervised` AWAITS its first
    // attempt, so a supervisor that wins the lock immediately would park inside the gate before
    // it ever returned. Held → standby → released → it wins → parks in the takeover.
    const held = await acquireLeaderLock(DB);
    expect(held).not.toBeNull();
    const sup = await runWorkerSupervised(cfgFor(fleet, { servingNothingMaxMs: 300 }));
    closers.push(async () => { release(); await sup.stop(); });
    expect(sup.state()).toBe("standby");
    await held!.release();

    // Parked inside `adapter.connect()`, well past a 300 ms bound.
    const start = Date.now();
    while (fleet.created === 0 && Date.now() - start < 15_000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(fleet.created, "the takeover never reached adapter.connect()").toBe(1);
    await new Promise((r) => setTimeout(r, 900));
    expect(sup.state()).toBe("standby");
    const parked = await health(sup.healthPort);
    expect(parked.status, "a takeover in flight was reported as a stalled standby").toBe(200);
    expect(parked.body).toMatchObject({
      healthy: true, standby: true, takingOver: true, unhealthyReason: null,
      waitingForLockSeconds: null,             // it is not waiting for a lock — it has one
    });
  }, 60_000);

  it("a leader serving 0 of 2 goes 503 even with NOTHING quarantined", async () => {
    // The widening. The old rule was `… && quarantined > 0`, so a shard whose mailboxes are
    // expected but unservable for any OTHER reason answered 200 for ever. Two enabled mailboxes
    // with no credential rows: expected 2, connected 0, quarantined 0 — nothing syncs, and the
    // endpoint has to say so.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    await seedMailboxWithoutCreds(db);
    await seedMailboxWithoutCreds(db);

    const sup = await runWorkerSupervised(cfgFor(fleet, { servingNothingMaxMs: 600 }));
    closers.push(() => sup.stop());

    const body = await waitForStatus(sup.healthPort, 503, 15_000);
    expect(body).toMatchObject({
      ok: false, healthy: false, leader: true, mailboxes: 0, expected: 2,
      quarantined: 0, awaitingCredentials: 2, unhealthyReason: "serving_nothing",
      // HEALTH-REASON — and the decomposition comes off the REAL roster maps, not off a subtraction.
      degraded: true, degradedReason: "roster_shortfall",
    });
    expect(body.unserved).toEqual({
      total: 2, quarantined: 0, awaitingCredentials: 2,
      standDown: 0, leaseUnreadable: 0, unaccounted: 0,
    });
  }, 60_000);

  it("a PARTIALLY served shard names the shortfall and breaks it down — the measured shape", async () => {
    // THE DEFECT, end to end. Two production deploy probes read `degraded: true,
    // degradedReason: null` and sent their readers looking for a fault the body never described.
    // This is that shape at 1-of-2: 200 (one bad mailbox must never take down the rest), degraded,
    // and now carrying both the token and the bucket that produced it.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    await seedMailbox(db);                    // attaches
    await seedMailboxWithoutCreds(db);        // expected, unservable

    const sup = await runWorkerSupervised(cfgFor(fleet, { servingNothingMaxMs: 600 }));
    closers.push(() => sup.stop());

    const body = await waitForBody(
      sup.healthPort, (b) => b.mailboxes === 1 && b.expected === 2, 15_000, "1 of 2 served",
    );
    expect(body).toMatchObject({
      ok: true, healthy: true, leader: true, unhealthyReason: null,
      degraded: true, degradedReason: "roster_shortfall",
    });
    expect(body.unserved).toEqual({
      total: 1, quarantined: 0, awaitingCredentials: 1,
      standDown: 0, leaseUnreadable: 0, unaccounted: 0,
    });
  }, 60_000);

  it("a fully served shard is not degraded, and says nothing is unserved rather than staying silent", async () => {
    // The other direction, and the reason `unserved` is published unconditionally: a field that
    // appears only when something is wrong makes its own absence ambiguous to whoever is reading.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    await seedMailbox(db);

    const sup = await runWorkerSupervised(cfgFor(fleet, { servingNothingMaxMs: 600 }));
    closers.push(() => sup.stop());

    const body = await waitForBody(
      sup.healthPort, (b) => b.mailboxes === 1 && b.expected === 1, 15_000, "1 of 1 served",
    );
    expect(body).toMatchObject({ ok: true, healthy: true, degraded: false, degradedReason: null });
    expect(body.unserved.total).toBe(0);
  }, 60_000);

  it("the pager verdict reaches the PUBLIC endpoint through the supervisor's snapshot", async () => {
    const fleet = new FakeAdapterFleet();
    const unarmed = await runWorkerSupervised(cfgFor(fleet));
    closers.push(() => unarmed.stop());
    const read = async (port: number) => (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as
      { pager?: string | null; leader?: boolean };
    const deadline = Date.now() + 15_000;
    let body = await read(unarmed.healthPort);
    while (!body.leader && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      body = await read(unarmed.healthPort);
    }
    expect(body.pager, "a leader with no arm cannot page anybody, and says so").toBe("unarmed");
    await unarmed.stop();

    const armed = await runWorkerSupervised(cfgFor(fleet, {
      alertWebhookUrl: "https://ntfy.example/ohmail", alertPost: async () => ({ status: 200 }),
    }));
    closers.push(() => armed.stop());
    body = await read(armed.healthPort);
    while (!body.leader && Date.now() < deadline + 15_000) {
      await new Promise((r) => setTimeout(r, 50));
      body = await read(armed.healthPort);
    }
    expect(body.pager, "an arm never attempted is not a dead one").toBe("ok");
  }, 60_000);

  it("…and stays 200 inside the grace, so a cold deploy during an incident can still ship", async () => {
    // A cold start reaches `leader` in seconds — which is precisely what happens right after the
    // previous instance crashed. If the reason nothing attaches is external (the provider is
    // down), a rule that answers 503 at once fails the deploy of the build that fixes something else.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const a = await seedMailbox(db);
    const b = await seedMailbox(db);
    fleet.behave(a.mailboxId, { failConnect: true });
    fleet.behave(b.mailboxId, { failConnect: true });

    const sup = await runWorkerSupervised(cfgFor(fleet, { servingNothingMaxMs: DEFAULT_SERVING_NOTHING_MAX_MS }));
    closers.push(() => sup.stop());

    const body = await health(sup.healthPort);
    expect(body.status, "the leader-serving-nothing rule fired inside its grace period").toBe(200);
    expect(body.body).toMatchObject({
      healthy: true, leader: true, mailboxes: 0, expected: 2, unhealthyReason: null,
      degraded: true,                      // honest about the fault without failing the gate
    });
    // THE INVARIANT, against a real worker rather than the pure function (HEALTH-REASON). The bucket here
    // is genuinely racy — a failed connect is `unaccounted` mid-attach and `quarantined` a moment
    // later — so the assertion is the one that must hold in every one of those instants: a
    // degraded body NAMES a cause. That is exactly the state the deploy probes were reading.
    expect(body.body.degradedReason, "degraded with nothing to act on").not.toBeNull();
    expect(body.body.unserved.total).toBe(2);
  }, 60_000);
});
