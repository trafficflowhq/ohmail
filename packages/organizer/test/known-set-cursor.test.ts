import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mailboxes, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { runSyncCycle } from "../src/sync.js";
import { KnownSetCache, insertedLocator } from "../src/known-set.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * THE CURSOR THE INGEST MAINTAINS AS IT WRITES.
 *
 * The memo cannot help during an import: every cycle writes, `insertMessage` is dirty, so every
 * cycle drops and re-reads the whole projection - measured at millions of rows re-read for a
 * large mailbox. The ingest knows what it wrote, so it appends instead.
 *
 * The risk that decides every assertion below is not a slow import, it is LOST MAIL: a memo that
 * holds a locator the database does not is a UID this process believes it has already fetched, and
 * it will never fetch it again. So the question asked here is always the same one - is what the
 * memo holds exactly what a fresh read would return - and it is asked after a commit, after a
 * rollback, and after a resume.
 */

const ACCOUNT = "00000000-0000-4000-8000-00000000a11e";

async function rig(n: number, batch?: number, role: "organizer" | "reader" = "reader"): Promise<{
  db: Tx; repo: ReturnType<typeof makeDrizzleRepo>; cache: KnownSetCache; mailboxId: string;
  cycle: () => Promise<{ hasBacklog: boolean }>;
}> {
  const db = (await makeTestDb()) as unknown as Tx;
  const [mb] = await db.insert(mailboxes)
    .values({ accountId: ACCOUNT, provider: "imap", address: `mb-${randomUUID().slice(0, 8)}@lichtgrat.example` })
    .returning();
  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory(
    { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId: ACCOUNT, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials here */ } },
  );
  fleet.behave(mb!.id, {
    ...(batch === undefined ? {} : { batchSize: batch }),
    deliver: Array.from({ length: n }, (_, i) => ({
      from: `s${i % 7}@x.example`, subject: `msg ${i}`, messageId: `m-${i}@x`, seen: i % 10 < 3,
    })),
  });
  const repo = makeDrizzleRepo(db as never);
  const cache = new KnownSetCache(mb!.id);
  return {
    db, repo, cache, mailboxId: mb!.id,
    cycle: async () => runSyncCycle({
      writeAuthority: FIXTURE_LEASE,
      repo, adapter, accountId: ACCOUNT, mailboxId: mb!.id, storageCap: UNMETERED_STORAGE_CAP,
      role, trustedAuthservIds: new Set<string>(), knownSet: cache,
    } as never) as Promise<{ hasBacklog: boolean }>,
  };
}

/** What the database says, in the shape the memo holds it, sorted so two sets compare. */
const sorted = (rows: ReadonlyArray<{ folder: string; uid: number; uidValidity: string }>): string[] =>
  rows.map((r) => `${r.folder}\u0000${r.uidValidity}:${r.uid}`).sort();

const cold = async (): Promise<never> => { throw new Error("the memo went to the database"); };

describe("the ingest's known-set cursor", () => {
  it("holds exactly what a fresh read would return, after ingesting in several cycles", async () => {
    const { repo, cache, mailboxId, cycle } = await rig(120, 40);
    let cycles = 0;
    for (;;) { cycles += 1; if (!(await cycle()).hasBacklog) break; if (cycles > 20) throw new Error("no drain"); }

    // THE POSITIVE CONTROL FIRST: this fixture really did ingest over several cycles, so the memo
    // really was warm across a write. A one-cycle fixture would pass every assertion below for
    // the wrong reason.
    expect(cycles, "the fixture drained in one cycle - the cursor was never asked").toBeGreaterThan(2);
    expect(cache.warm, "the memo is cold at the end of an import - the cursor did not hold").toBe(true);

    const fromDb = await repo.listKnownLocators(mailboxId);
    const held = await cache.list(cold, mailboxId);
    expect(held).toHaveLength(120);
    expect(sorted(held)).toEqual(sorted(fromDb));
    // And the columns, not just the tuples: a locator that agrees on the UID and lies about the
    // read state is a flag the adapter will not re-observe.
    const byRef = new Map(fromDb.map((r) => [`${r.folder}\u0000${r.uidValidity}:${r.uid}`, r]));
    for (const h of held) {
      const truth = byRef.get(`${h.folder}\u0000${h.uidValidity}:${h.uid}`)!;
      expect({ seen: h.seen, messageId: h.messageId }).toEqual({ seen: truth.seen, messageId: truth.messageId });
    }
  }, 120_000);

  it("re-reads nothing after the first cycle: the census counts the reads", async () => {
    const { cache, cycle } = await rig(120, 40);
    const reads: number[] = [];
    const appended: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const out = await cycle();
      reads.push(cache.census().dbReads);
      appended.push(cache.census().appended);
      if (!out.hasBacklog) break;
    }
    // The first cycle reads - the memo is cold. Every later cycle of the import appends instead,
    // which is the whole change: before it, every one of them read the mailbox again.
    expect(reads[0], "the first cycle did not read").toBe(1);
    expect(reads.slice(1, 3), `later cycles read ${reads.slice(1, 3).join(",")} times`).toEqual([0, 0]);
    expect(appended.slice(0, 3).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  }, 120_000);

  /**
   * THE CENSUS IS PER CYCLE, and nothing measured the two lines that make it so. `beginCycle()`
   * zeroes `appendedThisCycle` and `movedThisCycle`; with both removed all 49 cases here stayed
   * green, because every reader either summed them across cycles or never read them twice. A
   * cumulative count read as one cycle's work makes an import look like it appends faster and
   * faster, and the budget row and the perf rows are read off exactly these numbers.
   */
  it("counts appends per CYCLE, not since the memo woke up", async () => {
    const { cache, cycle } = await rig(120, 40);
    await cycle();
    const first = cache.census();
    expect(first.appended, "the first cycle appended nothing, so there is nothing to carry").toBeGreaterThan(0);
    /* The door the loop calls, asked directly: at the top of a cycle both counters are zero. */
    cache.beginCycle();
    expect({ appended: cache.census().appended, moved: cache.census().moved })
      .toEqual({ appended: 0, moved: 0 });
    /* And through the real cycle. From the second cycle on the memo only ever grows by what it
       appends, so a cycle's own `appended` IS its own growth in `rows` — a carried-forward total
       is larger than the rows that cycle wrote, every cycle, and by more each time. */
    let rows = cache.census().rows;
    const over: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const out = await cycle();
      const c = cache.census();
      if (c.droppedBy === null && c.dbReads === 0 && c.appended !== c.rows - rows) {
        over.push(`cycle ${i}: appended ${c.appended} where the memo grew by ${c.rows - rows}`);
      }
      rows = c.rows;
      if (!out.hasBacklog) break;
    }
    expect(over, "a cycle reported more appends than it wrote rows").toEqual([]);
  }, 120_000);

  it("an import interrupted and resumed does not re-derive the known set from zero", async () => {
    const { repo, cache, mailboxId, cycle } = await rig(120, 40);
    await cycle();
    const afterFirst = cache.census();
    // The interruption: the cycles stop, the process keeps the memo, and the import resumes.
    await cycle();
    const afterSecond = cache.census();
    expect(afterSecond.dbReads, "the resumed cycle went back to the database").toBe(0);
    expect(afterSecond.rows, "the resumed cycle's memo did not grow").toBeGreaterThan(afterFirst.rows);
    const fromDb = await repo.listKnownLocators(mailboxId);
    const held = await cache.list(cold, mailboxId);
    expect(sorted(held)).toEqual(sorted(fromDb));
  }, 120_000);

  /**
   * THE ORGANIZER'S OWN CYCLE, which is the one the product runs and the one the row is about.
   * The ingest is not the only writer that moves the projection: the filing move's bookkeeping
   * (`pipeline.ts#applyMoveOutcome`, `junk-filing.ts#completeFiling`) repoints an instance every
   * cycle. It is handed a row id the projection does not carry, so it carries WHERE IT WAS as
   * well, and the memo moves the entry instead of throwing the mailbox away.
   *
   * Measured before the move existed: [1, 1, 1] reads with `updateLocator` as the dropper, which
   * is what an ingest-only cursor is worth on this path — nothing.
   */
  it("reads once and then not again on an organizer, with nothing dropping the memo", async () => {
    const { repo, cache, mailboxId, cycle } = await rig(120, 40, "organizer");
    const reads: number[] = [];
    const droppers = new Set<string>();
    let appended = 0;
    let moved = 0;
    for (let i = 0; i < 20; i += 1) {
      const out = await cycle();
      const c = cache.census();
      reads.push(c.dbReads);
      appended += c.appended;
      moved += c.moved;
      if (c.droppedBy !== null) droppers.add(c.droppedBy);
      if (!out.hasBacklog) break;
    }
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ reads, droppers: [...droppers], appended, moved }));
    // The positive controls: both halves of the cursor actually fired on this path. A fixture
    // that moved nothing would pass the read count for the wrong reason.
    expect(appended, "the cursor appended nothing on an organizer cycle").toBeGreaterThan(0);
    expect(moved, "nothing moved, so this case never exercised the half it is about").toBeGreaterThan(0);
    expect(reads.slice(0, 3), `an organizer's cycles read ${reads.slice(0, 3).join(",")} times`)
      .toEqual([1, 0, 0]);
    expect([...droppers], "something still drops the memo on an organizer cycle").toEqual([]);

    // And the memo is still the projection, after moves as after inserts.
    const fromDb = await repo.listKnownLocators(mailboxId);
    const held = await cache.list(cold, mailboxId);
    expect(sorted(held)).toEqual(sorted(fromDb));
    const byRef = new Map(fromDb.map((r) => [`${r.folder}\u0000${r.uidValidity}:${r.uid}`, r]));
    for (const h of held) {
      const truth = byRef.get(`${h.folder}\u0000${h.uidValidity}:${h.uid}`)!;
      expect({ seen: h.seen, messageId: h.messageId },
        "a moved entry lost the header or the read-state baseline it carried")
        .toEqual({ seen: truth.seen, messageId: truth.messageId });
    }
  }, 120_000);

  it("drops when it is asked to move a locator it does not hold", async () => {
    const { cache } = await rig(1);
    await cache.list(async () => ([{ folder: "INBOX", uid: 1, uidValidity: "9", messageId: "a@x", seen: false }]), cache.mailboxId);
    cache.noteMoved({ folder: "INBOX", ref: "9:404" }, { folder: "Archive", uid: 2, uidValidity: "9", messageId: null, seen: null });
    expect(cache.warm, "a move the memo could not account for left it warm").toBe(false);
    expect(cache.census().droppedBy).toBe("updateLocator: the memo does not hold the locator it moved from");
  });

  it("drops rather than appends when the write group does not commit", async () => {
    const { cache } = await rig(1);
    // Warm it with a set of this cache's own making, then buffer an append inside a group that
    // fails. The memo must not hold the row: the transaction never wrote it.
    await cache.list(async () => ([
      { folder: "INBOX", uid: 1, uidValidity: "9", messageId: "a@x", seen: false },
    ]), cache.mailboxId);
    expect(cache.warm).toBe(true);
    cache.enterWrite();
    cache.noteInserted({ folder: "INBOX", uid: 2, uidValidity: "9", messageId: "b@x", seen: false });
    cache.leaveWrite(false);
    expect(cache.warm, "a rolled-back group left the memo warm with its row in it").toBe(false);
    expect(cache.census().droppedBy).toBe("a write group that did not commit");
  });

  it("a nested group flushes once, at the outermost commit", async () => {
    const { cache } = await rig(1);
    await cache.list(async () => ([{ folder: "INBOX", uid: 1, uidValidity: "9", messageId: "a@x", seen: false }]), cache.mailboxId);
    cache.enterWrite();
    cache.enterWrite();
    cache.noteInserted({ folder: "INBOX", uid: 2, uidValidity: "9", messageId: "b@x", seen: false });
    cache.leaveWrite(true);
    // Still buffered: the outer group has not committed, so nothing may be believed yet - the
    // read takes the database, which here answers empty.
    const mid = await cache.list(async () => ([]), cache.mailboxId);
    expect(mid, "an uncommitted row was served").toHaveLength(0);
    cache.leaveWrite(true);
  });

  it("a read inside an open group takes the database, never the half-written memo", async () => {
    const { cache } = await rig(1);
    await cache.list(async () => ([{ folder: "INBOX", uid: 1, uidValidity: "9", messageId: "a@x", seen: false }]), cache.mailboxId);
    cache.enterWrite();
    cache.noteInserted({ folder: "INBOX", uid: 2, uidValidity: "9", messageId: "b@x", seen: false });
    let wentToDb = false;
    await cache.list(async () => { wentToDb = true; return []; }, cache.mailboxId);
    expect(wentToDb, "a read inside an open write group was served from the memo").toBe(true);
    cache.leaveWrite(true);
  });
});

describe("what one insertMessage adds to the projection", () => {
  const loc = { folder: "INBOX", ref: "42:7" };
  const input = { canonical: { messageIdHeader: "a@x" }, nativeLocator: loc, unread: true };

  it("reads the four projected columns off the call", () => {
    expect(insertedLocator(input, { created: true }))
      .toEqual({ folder: "INBOX", uid: 7, uidValidity: "42", messageId: "a@x", seen: false });
    // `seen` is the coalesce the projection computes, and at insert time there is no flag row.
    expect(insertedLocator({ ...input, unread: false }, { created: true })?.seen).toBe(true);
  });

  it("refuses every shape the memo may not follow", () => {
    // A conflict: another ingest owns the row and its locator is not ours to model.
    expect(insertedLocator(input, { created: false })).toBeNull();
    // A repo that does not report what it did at all.
    expect(insertedLocator(input, {})).toBeNull();
    // Locators this cannot read take the drop path, never the keep path.
    expect(insertedLocator({ ...input, nativeLocator: { folder: "INBOX", ref: "no-colon" } }, { created: true })).toBeNull();
    expect(insertedLocator({ ...input, nativeLocator: { folder: "INBOX", ref: ":7" } }, { created: true })).toBeNull();
    expect(insertedLocator({ ...input, nativeLocator: { folder: "INBOX", ref: "42:x" } }, { created: true })).toBeNull();
    expect(insertedLocator({ ...input, nativeLocator: undefined }, { created: true })).toBeNull();
  });
});
