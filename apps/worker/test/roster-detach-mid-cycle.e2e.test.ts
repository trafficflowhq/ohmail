import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, mailboxes, mailboxCredentials, messages, rules } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider, createLogger } from "@trafficflow/core";
import { formatClaim } from "@trafficflow/core/adapters/organizer-lease";
import { randomUUID } from "node:crypto";
import { startWorker, type RunningWorker } from "../src/index.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * FIX-026-A: a roster pass that runs INSIDE a parked cycle, driven by gates and never by a clock.
 *
 * With three lanes and three accounts A, B and C are admitted in one fill, so C can still be before
 * its `changesSince` when B parks. The first two cases hold C in its lease read to make that certain
 * and state what then happens: C's visit runs once, and it starts before the roster pass closes C.
 * The rest ask what a lane the pass could not detach, or a runtime it did, may WRITE once another
 * organizer holds the mailbox. `roster-preemption.e2e.test.ts` holds the held-out forms.
 */

type Db = ReturnType<typeof makeDb>;
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 9));
const ROSTER_MS = 150;
const INSTALL = "cloud-fix026";
let DB = "";

async function seedMailbox(db: Db, accountId: string = randomUUID()): Promise<{ accountId: string; mailboxId: string }> {
  await db.insert(accounts).values({ id: accountId, name: "fix026" }).onConflictDoNothing();
  const [row] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`,
    organizerRole: "organizer", organizeConsentedAt: new Date(Date.now() - 60 * 60 * 1000),
  }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return { accountId, mailboxId: row!.id };
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

function cfgFor(fleet: FakeAdapterFleet, over: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    databaseUrl: DB, keyProvider: KP, pollIntervalMs: 120, sentDomain: "trafficflow.test",
    rosterIntervalMs: ROSTER_MS, mailboxRetryMs: 300, maxSyncFailures: 2,
    lockHeartbeatMs: 60_000, servingNothingMaxMs: 500, adapterFactory: fleet.factory,
    organizer: { installId: INSTALL, displayName: "Cloud", staleAfterMs: 60_000 }, ...over,
  };
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => { open = r; });
  return { wait, open };
}

/** Park the next `changesSince` of one mailbox; the release clears the seam first. */
function parkSync(fleet: FakeAdapterFleet, mailboxId: string): () => void {
  const g = gate();
  fleet.behave(mailboxId, { syncGate: g.wait });
  return () => { fleet.behave(mailboxId, { syncGate: undefined }); g.open(); };
}

/**
 * Hold ONE lease read of a mailbox inside a cycle visit: the first `listClaims` after its attach
 * has set up IDLE (`watch`), i.e. the visit's `mayOrganize`, before its `changesSince`.
 */
function holdCycleLeaseRead(fleet: FakeAdapterFleet, mailboxId: string): { held: () => boolean; release: () => void } {
  const meta = fleet.metaFor(mailboxId);
  const listClaims = meta.listClaims.bind(meta);
  const g = gate();
  let armed = true;
  let held = false;
  meta.listClaims = async () => {
    if (armed && fleet.indicesOf(mailboxId, "watch").length > 0) {
      armed = false;
      held = true;
      await g.wait;
    }
    return listClaims();
  };
  return { held: () => held, release: g.open };
}

/** Two completed rotations from now — the "released cycle finished, and the next ran" point. */
async function twoCycles(worker: RunningWorker): Promise<void> {
  for (let i = 0; i < 2; i++) {
    const before = worker.stats().lastCycleAt;
    await waitFor(() => worker.stats().lastCycleAt !== before, 8000, `completed cycle ${i + 1}`);
  }
}

/** Every `sync_start` of a mailbox that came AFTER its first `close` — a sync of a detached runtime. */
function syncsAfterClose(fleet: FakeAdapterFleet, mailboxId: string): number {
  const closeAt = fleet.nth(mailboxId, "close", 1);
  return fleet.indicesOf(mailboxId, "sync_start").filter((i) => i > closeAt).length;
}

function rivalClaim(): string {
  return formatClaim({
    authorizedAt: new Date(), capabilities: [], installId: "a-desktop-install", kind: "local",
    displayName: "Desktop", heartbeat: new Date(), claimedAt: new Date(), nonce: "rival-fix026",
  });
}

describe("FIX-026-A — a roster pass inside a parked cycle", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_fix026_detach"); }, 60000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const opens: Array<() => void> = [];
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const r of opens.splice(0)) { try { r(); } catch { /* ignore */ } }
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  /**
   * A C visit admitted beside B runs ONCE, and it is a member's: it starts before the roster pass
   * closes C, and nothing of C runs after. This is the interleaving that reddened :242 under load.
   */
  it("a visit admitted beside a parked lane runs once, before its runtime is closed", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    await seedMailbox(db);
    const b = await seedMailbox(db);
    const c = await seedMailbox(db);
    const releaseB = parkSync(fleet, b.mailboxId);
    opens.push(releaseB);
    const holdC = holdCycleLeaseRead(fleet, c.mailboxId);
    opens.push(holdC.release);
    const visits: Array<Record<string, unknown>> = [];
    const logger = createLogger({
      service: "worker", level: "info",
      sink: (l) => { const j = JSON.parse(l) as Record<string, unknown>; if (j.event === "mailbox_visit") visits.push(j); },
    });

    const worker = await startWorker(cfgFor(fleet, { logger }));
    closers.push(() => worker.stop());
    await waitFor(() => fleet.syncInFlight === 1 && holdC.held(), 8000, "B parked and C held in one cycle");
    const cSyncsBefore = fleet.indicesOf(c.mailboxId, "sync_start").length;
    const cTurnsBefore = visits.filter((v) => v.mailboxId === c.mailboxId && v.due !== true).length;

    holdC.release();
    await waitFor(() => fleet.indicesOf(c.mailboxId, "sync_end").length > cSyncsBefore, 8000, "C's visit of this cycle");
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, c.mailboxId));
    await waitFor(() => worker.stats().mailboxes === 2, 8000, "the roster pass that detaches C");
    expect(fleet.syncInFlight, "B must still be parked when C is detached").toBe(1);
    releaseB();
    await twoCycles(worker);

    expect(syncsAfterClose(fleet, c.mailboxId), "a sync began on C after C was closed").toBe(0);
    // C may also take turns while B is parked, each one due its poll (`admitDue`) and logged so;
    // the visit admitted beside B is its one turn of the pass that is not.
    expect(visits.filter((v) => v.mailboxId === c.mailboxId && v.due !== true).length, "C's admitted visit ran exactly once")
      .toBe(cTurnsBefore + 1);
    expect(fleet.nth(c.mailboxId, "sync_start", cSyncsBefore + 1)).toBeLessThan(fleet.nth(c.mailboxId, "close", 1));
  }, 30000);

  /** The same interleaving for adoption: that C visit precedes D, and D precedes C's next batch. */
  it("a visit admitted beside a parked lane precedes a mailbox connected after it", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    await seedMailbox(db);
    const b = await seedMailbox(db);
    const c = await seedMailbox(db);
    const releaseB = parkSync(fleet, b.mailboxId);
    opens.push(releaseB);
    const holdC = holdCycleLeaseRead(fleet, c.mailboxId);
    opens.push(holdC.release);

    const worker = await startWorker(cfgFor(fleet));
    closers.push(() => worker.stop());
    await waitFor(() => fleet.syncInFlight === 1 && holdC.held(), 8000, "B parked and C held in one cycle");
    const cSyncsBefore = fleet.indicesOf(c.mailboxId, "sync_start").length;
    holdC.release();
    await waitFor(() => fleet.indicesOf(c.mailboxId, "sync_end").length > cSyncsBefore, 8000, "C's visit of this cycle");

    const d = await seedMailbox(db);
    await waitFor(() => worker.stats().mailboxes === 4, 8000, "D adopted while B is parked");
    expect(fleet.syncInFlight).toBe(1);
    const atRelease = fleet.trace.length;
    releaseB();
    await twoCycles(worker);
    const dConnect = fleet.nth(d.mailboxId, "connect", 1);
    expect(fleet.nth(c.mailboxId, "sync_start", cSyncsBefore + 1), "C's admitted visit came first").toBeLessThan(dConnect);
    // C may take further turns while B is parked, each one due its poll (`admitDue`), so "C's next
    // batch" no longer marks the end of the parked pass; B's release does.
    expect(dConnect, "D is adopted inside the parked pass, before B's release").toBeLessThan(atRelease);
    const cNext = fleet.indicesOf(c.mailboxId, "sync_start").find((i) => i >= atRelease) ?? Infinity;
    expect(cNext, "C's next batch after the release ran").not.toBe(Infinity);
  }, 30000);

  /**
   * THE WRITE QUESTION, for the runtime the pass could NOT detach: C is parked in its own batch
   * with a message a rule files, the pass defers C's leave, a desktop takes the lease, C resumes.
   * `takeover: false` is the positive control that this observation can see a filing at all.
   */
  for (const [takeover, disable] of [[true, true], [false, true], [true, false], [false, false]] as const) {
    it(`a parked lane (disabled=${disable}, takeover=${takeover}) files only while it holds the lease`, async () => {
      const db = makeDb(DB);
      const fleet = new FakeAdapterFleet();
      const lines: Array<Record<string, unknown>> = [];
      const logger = createLogger({ service: "worker", level: "debug", sink: (l) => { lines.push(JSON.parse(l) as Record<string, unknown>); } });
      await seedMailbox(db);
      const c = await seedMailbox(db);
      await db.insert(rules).values({ accountId: c.accountId, kind: "domain", match: "feed.example", destination: "ohmail/News", priority: 5 });
      const worker = await startWorker({ ...cfgFor(fleet), logger });
      closers.push(() => worker.stop());
      await waitFor(() => worker.stats().mailboxes === 2, 8000, "A and C served");
      await twoCycles(worker);

      fleet.behave(c.mailboxId, {
        deliver: [{ from: "digest@feed.example", subject: "a newsletter", messageId: `f26-${randomUUID()}@feed.example` }],
      });
      const releaseC = parkSync(fleet, c.mailboxId);
      opens.push(releaseC);
      await waitFor(() => fleet.syncInFlight === 1, 8000, "C parked in its batch");
      if (disable) {
        await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, c.mailboxId));
        await waitFor(() => worker.stats().expected === 1, 8000, "a roster pass that dropped C from the duty");
        expect(worker.stats().mailboxes, "C's leave was deferred while its lane is inside").toBe(2);
      }
      const logMark = lines.length;

      const meta = fleet.metaFor(c.mailboxId);
      if (takeover) fleet.seedClaim(c.mailboxId, rivalClaim());
      const appendsBefore = meta.appends;
      const rowsBefore = await rowsOf(db, c.mailboxId);
      releaseC();
      if (disable) await waitFor(() => worker.stats().mailboxes === 1, 8000, "C's deferred leave drained");
      await twoCycles(worker);

      const moves = fleet.movesFor(c.mailboxId);
      const flags = fleet.flagWrites.filter((w) => w.mailboxId === c.mailboxId).length;
      const rows = await rowsOf(db, c.mailboxId);
      const rival = meta.messages.some((m) => m.raw.includes("rival-fix026"));
      const events = new Set(lines.slice(logMark).filter((l) => l.mailboxId === c.mailboxId).map((l) => String(l.event)));
      // Two independent refusals: the lease permit at every IMAP write (takeover), and the fenced
      // transaction's removal check on the mailbox row (disable). Neither is the roster membership.
      if (takeover || disable) {
        expect(moves, "C filed mail it may no longer organize").toEqual([]);
        expect(flags).toBe(0);
      } else {
        expect(moves.length, "the control must see the parked lane file").toBeGreaterThan(0);
      }
      // A removed mailbox commits nothing; a demoted one keeps a READER's mirror (ingest is a reader's).
      if (disable) {
        expect(rows, "C's batch committed rows into a removed mailbox").toBe(rowsBefore);
        expect(events.has("sync_cycle_mailbox_removed"), "the removal fence is what stopped the batch").toBe(true);
        expect(events.has("organizer_claim_released"), "the deferred leave releases the claim").toBe(true);
      } else if (takeover) {
        expect(events.has("stood_down_mid_cycle"), "the lease permit is what stopped the batch").toBe(true);
      }
      if (takeover) {
        expect(meta.appends - appendsBefore, "C renewed a claim after the takeover").toBe(0);
        expect(rival, "C expunged the rival's claim").toBe(true);
      }
    }, 40000);
  }

  /** The detached runtime (not in a lane) with a takeover landed: nothing at all reaches C. */
  it("a runtime detached before its turn writes nothing after a takeover", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    await seedMailbox(db);
    const b = await seedMailbox(db);
    const c = await seedMailbox(db, b.accountId);
    await db.insert(rules).values({ accountId: c.accountId, kind: "domain", match: "feed.example", destination: "ohmail/News", priority: 5 });
    const worker = await startWorker(cfgFor(fleet));
    closers.push(() => worker.stop());
    await waitFor(() => worker.stats().mailboxes === 3, 8000, "A, B and C served");

    fleet.behave(c.mailboxId, {
      deliver: [{ from: "digest@feed.example", subject: "a newsletter", messageId: `f26-${randomUUID()}@feed.example` }],
    });
    const releaseB = parkSync(fleet, b.mailboxId);
    opens.push(releaseB);
    await waitFor(() => fleet.syncInFlight === 1, 8000, "a cycle parked inside B");
    const cSyncsBefore = fleet.indicesOf(c.mailboxId, "sync_start").length;
    const movesBefore = fleet.movesFor(c.mailboxId).length;
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, c.mailboxId));
    await waitFor(() => worker.stats().mailboxes === 2, 8000, "the roster pass that detaches C");
    const meta = fleet.metaFor(c.mailboxId);
    fleet.seedClaim(c.mailboxId, rivalClaim());
    const appendsBefore = meta.appends;
    releaseB();
    await twoCycles(worker);

    expect(fleet.indicesOf(c.mailboxId, "sync_start").length).toBe(cSyncsBefore);
    expect(fleet.movesFor(c.mailboxId).length).toBe(movesBefore);
    expect(meta.appends - appendsBefore).toBe(0);
    expect(meta.messages.some((m) => m.raw.includes("rival-fix026"))).toBe(true);
  }, 30000);
});

async function rowsOf(db: Db, mailboxId: string): Promise<number> {
  return (await db.select({ id: messages.id }).from(messages).where(eq(messages.mailboxId, mailboxId))).length;
}
