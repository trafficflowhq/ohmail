import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { folderState, mailboxes, mailboxCredentials, messages, rules } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider, createLogger } from "@trafficflow/core";
import { startWorker, type RunningWorker } from "../src/index.js";
import { CYCLE_WAKE_REVISITS, type WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { byMessageId, ORGANIZER_CONSENT } from "./_workerdb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * production 2026-10-09: a burst spent a woken mailbox's four revisits and the next
 * wake waited minutes, twice, for the pass to end with its slowest lane. `heldOpenByAnother`
 * re-admits past the cap while a lane on a BOUNDED turn holds the pass open and no unserved mailbox
 * could take the lane; two mailboxes ringing for ever still let the pass end. The same held pass
 * kept closed connections attached 6.7 min, so one is detached between two turns; a rule retro's
 * moves wake their mailboxes. Order and presence, never a stopwatch; real Postgres, fake providers.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 53));
let DB = "";
type Db = ReturnType<typeof makeDb>;

async function seedMailbox(
  db: Db, accountId: string = randomUUID(), organizer = false,
): Promise<{ accountId: string; mailboxId: string }> {
  const [row] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`, ...(organizer ? ORGANIZER_CONSENT : {}),
  }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return { accountId, mailboxId: row!.id };
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

function cfgFor(fleet: FakeAdapterFleet, over: Partial<WorkerConfig> = {}): WorkerConfig {
  // A poll far longer than any case: every turn after the warm-up is a wake's, never the timer's.
  return {
    databaseUrl: DB, keyProvider: KP, sentDomain: "trafficflow.test", adapterFactory: fleet.factory,
    pollIntervalMs: 600_000, rosterIntervalMs: 5_000, lockHeartbeatMs: 60_000,
    alertIntervalMs: 600_000, maxSyncFailures: 50, mailboxRetryMs: 60_000, ...over,
  };
}

async function landed(db: Db, mailboxId: string, messageId: string): Promise<boolean> {
  const rows = await db.select({ id: messages.id }).from(messages).where(byMessageId(mailboxId, messageId));
  return rows.length > 0;
}

/** No `sync_start` anywhere for a full second: the boot's own follow-up passes are over. */
async function quiet(fleet: FakeAdapterFleet, ids: string[]): Promise<void> {
  const count = (): number => ids.reduce((n, id) => n + fleet.indicesOf(id, "sync_start").length, 0);
  for (let last = -1, n = count(); n !== last;) {
    last = n;
    await new Promise((r) => setTimeout(r, 1_000));
    n = count();
  }
}

function parkSync(fleet: FakeAdapterFleet, mailboxId: string): () => void {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  fleet.behave(mailboxId, { syncGate: gate });
  return () => { fleet.behave(mailboxId, { syncGate: undefined }); release(); };
}

describe("the wake cap", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_wake_past_cap"); }, 60_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  const releases: Array<() => void> = [];
  afterEach(async () => {
    for (const r of releases.splice(0)) { try { r(); } catch { /* ignore */ } }
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  async function warm(
    db: Db, fleet: FakeAdapterFleet, seeds: Array<{ mailboxId: string }>, over: Partial<WorkerConfig> = {},
  ): Promise<RunningWorker> {
    const worker = await startWorker(cfgFor(fleet, over));
    closers.push(() => worker.stop());
    await waitFor(() => worker.stats().mailboxes === seeds.length, 20_000, "every mailbox attached");
    await waitFor(() => seeds.every((s) => fleet.indicesOf(s.mailboxId, "sync_end").length > 0),
      20_000, "every mailbox's first cycle");
    // …and the warm-up PASS over, so every case starts with a stamp a later pass end would move.
    await waitFor(() => worker.stats().lastCycleAt !== null, 20_000, "the warm-up pass to end");
    return worker;
  }

  it.each([
    { shape: "two mailboxes", sibling: false },
    // H's account has a second mailbox the pass has not served: it cannot take a lane while H is
    // parked (one cycle per account), so it must not count as waiting for the lane L would take.
    { shape: "beside an unserved mailbox of the parked one's account", sibling: true },
  ])("serves every letter of a burst while another mailbox's batch holds the pass open — $shape", async ({ sibling }) => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const h = await seedMailbox(db);
    const l = await seedMailbox(db);
    const seeds = [h, l];
    if (sibling) seeds.push(await seedMailbox(db, h.accountId));
    const names = new Map([[h.mailboxId, "H"], [l.mailboxId, "L"]]);
    // The worker's own `mailbox_visit` lines, AFTER the allow-list: a field it drops is not there.
    const visits: Array<Record<string, unknown>> = [];
    const logger = createLogger({
      service: "worker", level: "info",
      sink: (line) => { const j = JSON.parse(line) as Record<string, unknown>; if (j.event === "mailbox_visit") visits.push(j); },
    });
    const worker = await warm(db, fleet, seeds, { logger });

    // H's next turn parks: the pass now cannot end until H returns.
    const releaseH = parkSync(fleet, h.mailboxId);
    releases.push(releaseH);
    fleet.signal.get(h.mailboxId)!();
    await waitFor(() => fleet.syncInFlight === 1, 20_000, "a lane parked inside H's batch");
    const passStamp = worker.stats().lastCycleAt?.getTime() ?? null;

    // The burst: one letter per ring, each waited for before the next. Two MORE than the cap, so
    // the claim cannot be met by the four in-cap revisits plus L's own turn.
    const rounds = CYCLE_WAKE_REVISITS + 2;
    const deliver: Array<{ from: string; subject: string; messageId: string }> = [];
    for (let i = 0; i < rounds; i++) {
      deliver.push({ from: "burst@x.example", subject: `burst ${i}`, messageId: `cap-${i}@x` });
      fleet.behave(l.mailboxId, { deliver: [...deliver] });
      fleet.signal.get(l.mailboxId)!();
      await waitFor(() => landed(db, l.mailboxId, `cap-${i}@x`), 10_000,
        `letter ${i + 1} of ${rounds} while H is parked — past the cap a woken mailbox waited for the ` +
        `pass to end — trace: ${fleet.describeTrace(names)}`);
    }
    // AT THE SAME INSTANT H is still inside its batch and no pass has ended: the letters did not
    // ride a new pass.
    expect(fleet.syncInFlight, `H's batch returned, so the burst proves nothing — trace: ${fleet.describeTrace(names)}`)
      .toBe(1);
    expect(worker.stats().lastCycleAt?.getTime() ?? null, "a pass ended during the burst").toBe(passStamp);
    // The visit line names the lane and how it was admitted, so the slow lane is named in production.
    const lVisits = visits.filter((v) => v.mailboxId === l.mailboxId);
    expect(lVisits.every((v) => typeof v.visitMs === "number" && typeof v.woken === "boolean"
      && typeof v.overCap === "boolean" && typeof v.heavy === "boolean"), JSON.stringify(lVisits[0])).toBe(true);
    expect(lVisits.filter((v) => v.overCap === true).length, "no visit was admitted past the cap").toBeGreaterThan(0);
  }, 120_000);

  it("gives a waiting unserved mailbox the lane before a woken one past the cap", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const h = await seedMailbox(db);
    const l = await seedMailbox(db);
    const u = await seedMailbox(db);
    const names = new Map([[h.mailboxId, "H"], [l.mailboxId, "L"], [u.mailboxId, "U"]]);
    // TWO lanes: H parked in one, L and U contend for the other. L is woken first, so the pass
    // admits H and L and U waits its turn behind L's in-cap revisits.
    const worker = await startWorker(cfgFor(fleet, { cycleLanes: 2 }));
    closers.push(() => worker.stop());
    await waitFor(() => worker.stats().mailboxes === 3, 20_000, "every mailbox attached");
    await waitFor(() => worker.stats().lastCycleAt !== null, 20_000, "the warm-up pass to end");
    // U must be UNSERVED in the pass H's park holds: a boot follow-up pass still running here would
    // give U its turn before the park, and the claim below would wait for a pass that cannot end.
    await quiet(fleet, [h.mailboxId, l.mailboxId, u.mailboxId]);
    const uStarts = fleet.indicesOf(u.mailboxId, "sync_start").length;

    const releaseH = parkSync(fleet, h.mailboxId);
    releases.push(releaseH);
    let ringing = true;
    const ringer = (async () => {
      while (ringing) {
        fleet.behave(l.mailboxId, { syncGate: new Promise<void>((res) => setTimeout(res, 20)) });
        fleet.signal.get(l.mailboxId)!();
        await new Promise((res) => setTimeout(res, 10));
      }
    })();
    try {
      fleet.signal.get(h.mailboxId)!();
      await waitFor(() => fleet.syncInFlight >= 1, 20_000, "a lane parked inside H's batch");
      await waitFor(() => fleet.indicesOf(u.mailboxId, "sync_start").length > uStarts, 10_000,
        `U's turn while H is parked — a woken mailbox past the cap took the lane U was waiting for ` +
        `— trace: ${fleet.describeTrace(names)}`);
    } finally {
      ringing = false;
      await ringer;
    }
  }, 120_000);

  it("still ends the pass when two mailboxes ring for ever past the cap", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const h = await seedMailbox(db);
    const r1 = await seedMailbox(db);
    const r2 = await seedMailbox(db);
    const names = new Map([[h.mailboxId, "H"], [r1.mailboxId, "ring one"], [r2.mailboxId, "ring two"]]);
    const worker = await warm(db, fleet, [h, r1, r2]);

    const releaseH = parkSync(fleet, h.mailboxId);
    releases.push(releaseH);
    fleet.signal.get(h.mailboxId)!();
    await waitFor(() => fleet.syncInFlight === 1, 20_000, "a lane parked inside H's batch");

    // The two ringing mailboxes ring every 15 ms and each visit lasts ~40 ms, so their lanes overlap: if an
    // over-cap lane counted as the pass's holder, each would hold the pass open for the other.
    let ringing = true;
    const ringer = (async () => {
      while (ringing) {
        for (const r of [r1, r2]) {
          fleet.behave(r.mailboxId, { syncGate: new Promise<void>((res) => setTimeout(res, 40)) });
          fleet.signal.get(r.mailboxId)!();
        }
        await new Promise((res) => setTimeout(res, 15));
      }
    })();
    try {
      await waitFor(() => fleet.indicesOf(r1.mailboxId, "sync_start").length > CYCLE_WAKE_REVISITS + 3
        && fleet.indicesOf(r2.mailboxId, "sync_start").length > CYCLE_WAKE_REVISITS + 3,
        20_000, "both ringers past the cap while H holds the pass");
      // `lastCycleAt` is stamped after a pass's loop has joined its lanes, so it moves only when
      // the pass ENDS; H's park pins it until the release.
      const passStamp = worker.stats().lastCycleAt?.getTime() ?? null;
      expect(passStamp, "the warm-up pass never stamped, so the claim below is vacuous").not.toBeNull();
      releaseH();
      await waitFor(() => (worker.stats().lastCycleAt?.getTime() ?? null) !== passStamp, 20_000,
        `the pass to end — it never did while two mailboxes rang — trace: ${fleet.describeTrace(names)}`);
    } finally {
      ringing = false;
      await ringer;
    }
  }, 120_000);
  it("detaches and re-dials a closed connection while another lane holds the pass, and the late queue entry leaves the new one", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const h = await seedMailbox(db);
    const l = await seedMailbox(db);
    const names = new Map([[h.mailboxId, "H"], [l.mailboxId, "L"]]);
    const detached: string[] = [];
    const logger = createLogger({
      service: "worker", level: "info",
      sink: (line) => { const j = JSON.parse(line) as Record<string, unknown>; if (j.event === "mailbox_detached") detached.push(String(j.mailboxId)); },
    });
    const worker = await warm(db, fleet, [h, l], { logger });

    const releaseH = parkSync(fleet, h.mailboxId);
    releases.push(releaseH);
    fleet.signal.get(h.mailboxId)!();
    await waitFor(() => fleet.syncInFlight === 1, 20_000, "a lane parked inside H's batch");
    const passStamp = worker.stats().lastCycleAt?.getTime() ?? null;

    // L's socket ends while H holds the pass: detached AND re-dialled before H returns.
    fleet.closeConnection(l.mailboxId);
    await waitFor(() => fleet.indicesOf(l.mailboxId, "connect").length >= 2, 10_000,
      `L re-dialled while H is parked — the detach waited for the pass — trace: ${fleet.describeTrace(names)}`);
    expect(fleet.syncInFlight, "H's batch returned, so the claim proves nothing").toBe(1);
    expect(worker.stats().lastCycleAt?.getTime() ?? null, "a pass ended before the re-dial").toBe(passStamp);

    // The queued entry runs once H returns and the pass ends; it must not close L's NEW connection.
    releaseH();
    await waitFor(() => (worker.stats().lastCycleAt?.getTime() ?? null) !== passStamp, 20_000, "the pass to end");
    await new Promise((r) => setTimeout(r, 300));
    expect(detached.filter((id) => id === l.mailboxId), "L was detached twice — the late entry closed the re-attached runtime")
      .toHaveLength(1);
    expect(worker.stats().mailboxes).toBe(2);
    expect(fleet.indicesOf(l.mailboxId, "connect")).toHaveLength(2);
  }, 120_000);
  it("quarantines a mailbox whose failing visit also ended its connection, before any between-turns detach", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const h = await seedMailbox(db);
    const l = await seedMailbox(db);
    const names = new Map([[h.mailboxId, "H"], [l.mailboxId, "L"]]);
    const worker = await warm(db, fleet, [h, l], { maxSyncFailures: 1 });

    // H holds the pass; L's next visit parks, its connection ends inside it, and it then FAILS —
    // the failure that reaches `maxSyncFailures`, owed to the post-loop quarantine.
    const releaseH = parkSync(fleet, h.mailboxId);
    releases.push(releaseH);
    fleet.signal.get(h.mailboxId)!();
    await waitFor(() => fleet.syncInFlight === 1, 20_000, "a lane parked inside H's batch");
    const releaseL = parkSync(fleet, l.mailboxId);
    releases.push(releaseL);
    fleet.signal.get(l.mailboxId)!();
    await waitFor(() => fleet.syncInFlight === 2, 20_000, "L's visit parked beside H's");
    fleet.closeConnection(l.mailboxId);
    fleet.behave(l.mailboxId, { syncError: new Error("provider refused the batch") });
    releaseL();

    releaseH();
    await waitFor(() => worker.stats().quarantined === 1, 20_000,
      `L quarantined — the between-turns detach re-attached it with zero failures first — trace: ${fleet.describeTrace(names)}`);
    expect(fleet.indicesOf(l.mailboxId, "connect"), "L was re-dialled instead of quarantined").toHaveLength(1);
  }, 120_000);

  it("pushes a rule retro's moves on the next free lane, not the next pass", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    // An ORGANIZER: a consent-less reader moves nothing, so its retro would have nothing to push.
    const m = await seedMailbox(db, randomUUID(), true);
    fleet.behave(m.mailboxId, { deliver: [{ from: "news@atelier.example", subject: "issue 1", messageId: "retro-1@x" }] });
    await warm(db, fleet, [m]);

    await waitFor(() => landed(db, m.mailboxId, "retro-1@x"), 20_000, "the letter ingested");
    const [row] = await db.select({ id: messages.id }).from(messages).where(byMessageId(m.mailboxId, "retro-1@x"));
    // A QUIET shard first: the boot's own follow-up passes would push the move without any wake.
    await quiet(fleet, [m.mailboxId]);
    const movesBefore = fleet.indicesOf(m.mailboxId, "move").length;

    // A rule made now, owed to the mail already filed; one wake runs a pass whose tail applies it.
    await db.insert(rules).values({
      accountId: m.accountId, kind: "sender", match: "news@atelier.example", destination: "ohmail/News",
      provenance: "manual", enabled: true, retroRequestedAt: new Date(),
    });
    fleet.signal.get(m.mailboxId)!();
    await waitFor(async () => {
      const [fs] = await db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, row!.id));
      return fs?.d === "ohmail/News";
    }, 20_000, "the retro to write the desired folder");
    // The poll is ten minutes: only a wake can bring the move this soon.
    await waitFor(() => fleet.indicesOf(m.mailboxId, "move").length > movesBefore, 10_000,
      `the retro's move pushed — it waited for the next pass — trace: ${fleet.describeTrace(new Map([[m.mailboxId, "M"]]))}`);
  }, 120_000);
});
