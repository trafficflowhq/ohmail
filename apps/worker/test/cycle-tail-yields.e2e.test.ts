import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accountSettings, accounts, mailboxes, mailboxCredentials, type Tx } from "@trafficflow/db";
import { makeDb, markScreenerSuggestOwed, screenerSuggestOwed } from "@trafficflow/db/cloud";
import { StaticKeyProvider, createLogger, type Logger } from "@trafficflow/core";
import { startWorker, type RunningWorker } from "../src/index.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { threadJoinHealPass } from "../src/thread-join-heal.js";

vi.mock("../src/thread-join-heal.js", async (load) => {
  const real = await load<typeof import("../src/thread-join-heal.js")>();
  return { ...real, threadJoinHealPass: vi.fn(real.threadJoinHealPass) };
});

/**
 * THE CYCLE TAIL YIELDS TO NEW MAIL, AND ONLY TO NEW MAIL. The per-account passes run as their own
 * queue entry behind each rotation; a slice is PARKED through `tailSliceHook` and every claim is an
 * ORDER in the fleet's trace, never a duration. First, a wake is served before the next slice; second, a
 * resumed walk goes on at its cursor (the owed serve does not run twice); third, a poll cycle does not
 * preempt, and the turn budget yields to whatever is queued.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 23));
let DB = "";
type Db = ReturnType<typeof makeDb>;

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

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

/** Every tail slice, with the fleet trace's length when it started — its position in the trace. */
interface Slice { section: string; index: number; pos: number }

/** A slice matching `when` parks until released; every slice is recorded, parked or not. */
function tailProbe(fleet: FakeAdapterFleet) {
  const slices: Slice[] = [];
  let when: ((s: Slice) => boolean) | null = null;
  let release: (() => void) | null = null;
  let parked = false;
  let sleepMs = 0;
  const hook = async (section: string, index: number): Promise<void> => {
    const s = { section, index, pos: fleet.trace.length };
    slices.push(s);
    if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
    if (when?.(s)) {
      when = null;
      parked = true;
      await new Promise<void>((r) => { release = () => { parked = false; r(); }; });
    }
  };
  return {
    slices, hook,
    parkAt(pred: (s: Slice) => boolean): void { when = pred; },
    get parked(): boolean { return parked; },
    release(): void { release?.(); release = null; },
    sleepEach(ms: number): void { sleepMs = ms; },
  };
}

function capturingLogger(): { log: Logger; phases: Array<Record<string, unknown>> } {
  const phases: Array<Record<string, unknown>> = [];
  const log = createLogger({
    service: "worker", level: "info",
    sink: (line) => {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (o.event === "cycle_phases") phases.push(o);
    },
  });
  return { log, phases };
}

function cfgFor(
  fleet: FakeAdapterFleet, probe: ReturnType<typeof tailProbe>, log: Logger, over: Partial<WorkerConfig> = {},
): WorkerConfig {
  return {
    databaseUrl: DB, keyProvider: KP, sentDomain: "trafficflow.test", adapterFactory: fleet.factory,
    pollIntervalMs: 600_000, rosterIntervalMs: 600_000, lockHeartbeatMs: 60_000,
    alertIntervalMs: 600_000, mailboxRetryMs: 60_000, maxSyncFailures: 50, logger: log,
    tailTurn: { minTurnMs: 1, turnBudgetMs: 600_000 }, tailSliceHook: probe.hook,
    ...over,
  };
}

/** The first `sync_start` of `mailboxId` at or after trace position `from`, or Infinity. */
function syncStartFrom(fleet: FakeAdapterFleet, mailboxId: string, from: number): number {
  return fleet.indicesOf(mailboxId, "sync_start").find((i) => i >= from) ?? Infinity;
}

describe("the cycle tail yields to new mail", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_cycle_tail"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  const releases: Array<() => void> = [];
  afterEach(async () => {
    for (const r of releases.splice(0)) { try { r(); } catch { /* ignore */ } }
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  async function warm(
    db: Db, over: Partial<WorkerConfig> = {},
  ): Promise<{ worker: RunningWorker; fleet: FakeAdapterFleet; probe: ReturnType<typeof tailProbe>;
      phases: Array<Record<string, unknown>>; a: { accountId: string; mailboxId: string };
      b: { accountId: string; mailboxId: string } }> {
    const fleet = new FakeAdapterFleet();
    const probe = tailProbe(fleet);
    releases.push(() => probe.release());
    const { log, phases } = capturingLogger();
    const a = await seedMailbox(db);
    const b = await seedMailbox(db);
    const worker = await startWorker(cfgFor(fleet, probe, log, over));
    closers.push(() => worker.stop());
    await waitFor(() => worker.stats().mailboxes === 2, 20_000, "both mailboxes attached");
    await waitFor(() => phases.length >= 1, 20_000, "the first tail walk to finish");
    return { worker, fleet, probe, phases, a, b };
  }

  // Parked inside a slice, B's doorbell rings: nothing visits B while the slice holds the queue
  // (the tail is a queue entry), and once released B is visited BEFORE the walk's next slice.
  it("serves a wake that rang during a tail slice before the walk's next slice", async () => {
    const db = makeDb(DB);
    const { fleet, probe, a, b } = await warm(db);
    probe.parkAt((s) => s.section === "rule_retro" && s.index === 0);
    fleet.signal.get(a.mailboxId)!();
    await waitFor(() => probe.parked, 20_000, "a slice of the next walk to park");

    const rang = fleet.trace.length;
    fleet.signal.get(b.mailboxId)!();
    await new Promise((r) => setTimeout(r, 150));
    expect(syncStartFrom(fleet, b.mailboxId, rang), "B was visited while a tail slice held the queue")
      .toBe(Infinity);

    const parkedAt = probe.slices.length;
    probe.release();
    await waitFor(() => syncStartFrom(fleet, b.mailboxId, rang) < Infinity, 20_000, "B's visit");
    await waitFor(() => probe.slices.length > parkedAt, 20_000, "the walk's next slice");
    const next = probe.slices[parkedAt]!;
    expect(
      syncStartFrom(fleet, b.mailboxId, rang),
      `the walk ran ${next.section}[${next.index}] before the woken mailbox — trace ${fleet.describeTrace()}`,
    ).toBeLessThan(next.pos);
    expect(next, "the resumed walk did not go on at its cursor").toMatchObject({ section: "rule_retro", index: 1 });
  }, 120_000);

  // A walk that yielded goes on where it stopped: A's owed serve ran in this walk, A is marked
  // owed again while the walk is parked, and the resumed walk finishes WITHOUT serving A a second
  // time. The next walk does serve it — the observable is live, not merely absent.
  it("resumes a walk at its cursor, so the owed serve does not run twice in one walk", async () => {
    const db = makeDb(DB);
    const { fleet, probe, phases, a, b } = await warm(db);
    await db.insert(accounts).values({ id: a.accountId, name: "a" }).onConflictDoNothing();
    await db.insert(accountSettings).values({ accountId: a.accountId, autoSuggestAt: new Date() })
      .onConflictDoUpdate({ target: accountSettings.accountId, set: { autoSuggestAt: new Date() } });
    const owed = async (): Promise<boolean> =>
      (await db.select().from(screenerSuggestOwed).where(eq(screenerSuggestOwed.accountId, a.accountId))).length > 0;

    await markScreenerSuggestOwed(db as unknown as Tx, a.accountId);
    expect(await owed(), "the fixture could not mark the account owed").toBe(true);
    probe.parkAt((s) => s.section === "rule_retro" && s.index === 0);
    fleet.signal.get(a.mailboxId)!();
    await waitFor(() => probe.parked, 20_000, "the walk to park after the owed serve");
    expect(probe.slices.some((s) => s.section === "screener_suggest_owed"), "the owed serve did not run").toBe(true);
    expect(await owed(), "the owed serve did not clear its mark").toBe(false);

    await new Promise((r) => setTimeout(r, 5));
    await markScreenerSuggestOwed(db as unknown as Tx, a.accountId);
    const walks = phases.length;
    fleet.signal.get(b.mailboxId)!();
    probe.release();
    await waitFor(() => phases.length > walks, 20_000, "the resumed walk to finish");
    expect(Number(phases[walks]!.turns), "the walk never yielded, so nothing resumed").toBeGreaterThan(1);
    expect(await owed(), "the resumed walk served the owed account again — it restarted at the top").toBe(true);

    fleet.signal.get(a.mailboxId)!();
    await waitFor(async () => !(await owed()), 20_000, "the NEXT walk to serve and clear the mark");
  }, 120_000);

  // A poll cycle queued behind a parked slice does not cut the walk: every remaining slice
  // runs before the next visit, and the walk finishes in one turn.
  it("does not yield to a poll cycle that carries no wake", async () => {
    const db = makeDb(DB);
    const { fleet, probe, phases, a, b } = await warm(db, { pollIntervalMs: 60 });
    probe.parkAt((s) => s.section === "rule_retro" && s.index === 0);
    await waitFor(() => probe.parked, 20_000, "a walk to park");
    await new Promise((r) => setTimeout(r, 200));
    const from = fleet.trace.length;
    const parkedAt = probe.slices.length;
    const walks = phases.length;
    probe.release();
    await waitFor(() => phases.length > walks, 20_000, "the parked walk to finish");
    const rest = probe.slices.slice(parkedAt).filter((s) => s.pos >= from);
    const last = rest.findIndex((s) => s.section === "mailbox_erasure");
    expect(last, "the walk's last slice was not recorded").toBeGreaterThanOrEqual(0);
    const firstVisit = Math.min(syncStartFrom(fleet, a.mailboxId, from), syncStartFrom(fleet, b.mailboxId, from));
    expect(rest[last]!.pos, `a poll cycle ran inside the walk — trace ${fleet.describeTrace()}`)
      .toBeLessThanOrEqual(firstVisit);
    expect(Number(phases[walks]!.turns), "the walk yielded with no wake").toBe(1);
  }, 120_000);

  // With no wake at all, a turn past its budget yields to what is queued: a poll cycle's visit
  // lands between two slices of one walk, and the walk takes more than one turn.
  it("yields to a queued poll cycle once a turn has run its budget", async () => {
    const db = makeDb(DB);
    const { fleet, probe, phases } = await warm(db, {
      pollIntervalMs: 60, tailTurn: { minTurnMs: 1, turnBudgetMs: 40 },
    });
    probe.sleepEach(25);
    const walks = phases.length;
    const from = probe.slices.length;
    await waitFor(() => phases.length > walks + 1, 30_000, "a whole walk under the budget");
    const walk = probe.slices.slice(from);
    const start = walk.findIndex((s) => s.section === "workflow" && s.index === 0);
    const end = walk.findIndex((s, i) => i > start && s.section === "mailbox_erasure");
    expect(start >= 0 && end > start, "no whole walk was recorded").toBe(true);
    const visits = fleet.trace.filter((e, i) => e.event === "sync_start" && i >= walk[start]!.pos && i < walk[end]!.pos);
    expect(visits.length, `no visit ran inside a walk past its budget — trace ${fleet.describeTrace()}`)
      .toBeGreaterThan(0);
    expect(Number(phases[walks + 1]!.turns), "the walk never yielded to its budget").toBeGreaterThan(1);
  }, 120_000);

  // A heal its slice clock cut is owed: the next walk goes on at its cursor with what is left of
  // the group budget, and once it finishes the six-hour gate is shut again.
  it("resumes a heal its slice clock cut in the next walk, then shuts the gate", async () => {
    const heal = vi.mocked(threadJoinHealPass);
    heal.mockClear();
    heal.mockImplementationOnce(async (deps) => ({
      groupsScanned: 1, merged: 0, messagesMoved: 0, skipped: 0, failed: 0, refusedUncorroborated: 0,
      capped: false, cut: true, cursor: { accountId: deps.accountId!, subject: "Alpha" },
    }));
    const db = makeDb(DB);
    const { fleet, phases, a } = await warm(db);
    const cutAccount = heal.mock.calls[0]![0].accountId!;

    let walks = phases.length;
    fleet.signal.get(a.mailboxId)!();
    await waitFor(() => heal.mock.calls.length >= 3, 20_000, "the cut heal to resume");
    const resumed = heal.mock.calls[2]![0];
    expect(resumed.accountId).toBe(cutAccount);
    expect(resumed.cursor).toEqual({ accountId: cutAccount, subject: "Alpha" });
    expect(resumed.maxGroups).toBe(199);
    expect(typeof resumed.until).toBe("function");

    await waitFor(() => phases.length > walks, 20_000, "the resuming walk to finish");
    walks = phases.length;
    fleet.signal.get(a.mailboxId)!();
    await waitFor(() => phases.length > walks, 20_000, "one more walk");
    expect(heal.mock.calls, "a finished heal ran again inside its period").toHaveLength(3);
  }, 120_000);
});
