import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getHeapStatistics } from "node:v8";
import type { KnownLocator, WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { ImapCursor } from "@trafficflow/core/adapters/imap";
import { buildCursor } from "../src/sync.js";
import {
  KnownSetCache, KnownSetBudget, estimateRetainedBytes, watchKnownSet,
  KNOWN_SET_BUDGET_BYTES, KNOWN_SET_BUDGET_DIVISOR, knownSetBudgetBytes, processKnownSetBudget,
} from "../src/known-set.js";

const MIB = 1024 * 1024;

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  WHAT THE WORKER RETAINS GROWS WITH THE WORK, NOT WITH THE ROSTER
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * One locator memo per attachment with no eviction made this process's memory ceiling the number
 * of mailboxes it serves. Measured on the rig (`test/rigs/known-set-peak-rig.mjs`, synthetic
 * projections of a large mailbox each, heap read after two forced collects with every memo still
 * warm): the heap grew by the same step with every mailbox added — strictly linear, and
 * a full shard of attached mailboxes wants several times the heap it has.
 *
 * The cases below pin the four things that make the requirement independent of the roster: the
 * bound is a stated fraction of the heap and is checked against the file that sets the heap;
 * eviction happens ON THE INSERTION and the total is under the bound at every step of the pass,
 * not only at the end of one; the victim is the least recently used mailbox; and a mailbox inside
 * the budget still hits its memo, because turning every cycle into a cold read is a different cost
 * on the same person.
 */

function fixtureRows(mailbox: number, n: number): KnownLocator[] {
  return Array.from({ length: n }, (_, i) => ({
    folder: i % 2 === 0 ? "INBOX" : "INBOX/Archive",
    uid: i + 1,
    uidValidity: String(1700000000 + mailbox),
    messageId: `<${i}.${mailbox}@fixture.invalid>`,
    seen: i % 3 === 0,
  }));
}

/** A mailbox's memo and the read it is fed, so a case reads like the cycle it stands for. */
function attach(mailbox: number, budget: KnownSetBudget, rows: KnownLocator[]) {
  const id = `mailbox-${mailbox}`;
  const cache = new KnownSetCache(id, budget);
  let dbReads = 0;
  return {
    cache,
    id,
    get dbReads() { return dbReads; },
    cycle: () => cache.list(async () => { dbReads++; return rows; }, id),
  };
}

const ROWS = 200;
/** One fixture projection's charge, so the budgets below are stated in projections. */
const ONE = estimateRetainedBytes(fixtureRows(0, ROWS));

describe("the locator budget: the bound is a fraction of the deployed heap", () => {
  /**
   * THE HEAP IS THE RUNNING PROCESS'S. A stated constant outlived the heap it was a quarter of; the
   * budget is now read off the engine's own limit, so a deployment that raises the heap raises the budget.
   */
  it("takes a quarter of the running process's heap limit", () => {
    const limit = getHeapStatistics().heap_size_limit;
    expect(KNOWN_SET_BUDGET_DIVISOR).toBe(4);
    expect(knownSetBudgetBytes(512 * MIB)).toBe(128 * MIB);
    expect(KNOWN_SET_BUDGET_BYTES).toBe(Math.floor(limit / 4));
    // The default is the BOUNDED one: a memo built without a budget is bounded, so the composition
    // root cannot forget to pass it.
    expect(processKnownSetBudget.limitBytes).toBe(KNOWN_SET_BUDGET_BYTES);
    expect(new KnownSetCache("m").census().processBudgetBytes).toBe(KNOWN_SET_BUDGET_BYTES);
  });

  /**
   * THE CLIFF. One mailbox importing toward 600k copies outgrows a 512 MiB heap's quarter, and a
   * projection over the whole budget is never kept: every cycle re-reads it. A 2 GiB heap holds it.
   */
  it("admits a 600k-entry projection at a 2 GiB heap, and not at 512 MiB", () => {
    const charge = estimateRetainedBytes(fixtureRows(0, 1)) * 600_000;
    const at = (heapMib: number): boolean => {
      const budget = new KnownSetBudget(knownSetBudgetBytes(heapMib * MIB));
      return budget.offer(new KnownSetCache("importing", budget), charge);
    };
    expect(at(512), "a 512 MiB heap's budget held the importing mailbox").toBe(false);
    expect(at(2048), "a 2 GiB heap's budget refused the importing mailbox").toBe(true);
  });
});

describe("the locator budget: eviction on insertion, during the pass", () => {
  /**
   * THE CONTROL THIS LANE EXISTS FOR. Ten mailboxes attach in one pass against a budget that fits
   * three projections, and the charge is read AFTER EVERY read-through rather than at the end: a
   * bound enforced when a multi-mailbox pass finishes is no bound while it runs, and while it runs
   * is when this process meets its heap ceiling. Remove the eviction loop in `KnownSetBudget.admit`
   * and the charge walks to ten projections here.
   */
  it("holds the total under the bound at every step as N grows", async () => {
    const budget = new KnownSetBudget(ONE * 3);
    const seen: number[] = [];
    const warm: number[] = [];
    const attached = [];
    for (let m = 0; m < 10; m++) {
      const a = attach(m, budget, fixtureRows(m, ROWS));
      attached.push(a);
      await a.cycle();
      seen.push(budget.chargedBytes);
      warm.push(budget.warmCount);
    }
    expect(seen.every((b) => b <= budget.limitBytes)).toBe(true);
    expect(Math.max(...seen)).toBeLessThanOrEqual(budget.limitBytes);
    // It stops growing at three and stays there — the roster no longer sets the ceiling.
    expect(warm).toEqual([1, 2, 3, 3, 3, 3, 3, 3, 3, 3]);
    expect(attached.filter((a) => a.cache.warm)).toHaveLength(3);
  });

  it("evicts AT the insertion, not at the end of the pass", async () => {
    const budget = new KnownSetBudget(ONE * 3);
    const a = attach(0, budget, fixtureRows(0, ROWS));
    const b = attach(1, budget, fixtureRows(1, ROWS));
    const c = attach(2, budget, fixtureRows(2, ROWS));
    const d = attach(3, budget, fixtureRows(3, ROWS));
    await a.cycle(); await b.cycle(); await c.cycle();
    expect([a, b, c].map((x) => x.cache.warm)).toEqual([true, true, true]);
    // The fourth read-through has not returned to any pass epilogue yet, and the first is already
    // cold: the room was made by the insertion itself.
    await d.cycle();
    expect(a.cache.warm).toBe(false);
    expect([b, c, d].map((x) => x.cache.warm)).toEqual([true, true, true]);
    expect(a.cache.census().droppedBy).toBe("evicted: the process locator budget");
    expect(a.cache.census().retainedBytes).toBe(0);
  });

  it("takes the LEAST RECENTLY USED mailbox, and a hit makes a mailbox recent", async () => {
    const budget = new KnownSetBudget(ONE * 3);
    const a = attach(0, budget, fixtureRows(0, ROWS));
    const b = attach(1, budget, fixtureRows(1, ROWS));
    const c = attach(2, budget, fixtureRows(2, ROWS));
    const d = attach(3, budget, fixtureRows(3, ROWS));
    await a.cycle(); await b.cycle(); await c.cycle();
    // A's cycle comes round again and is served from memory. Without the touch on that hit, A is
    // still the oldest insertion and D would take it — the mailbox being polled most often would
    // be the one evicted, which is the wrong mailbox by construction.
    await a.cycle();
    expect(a.dbReads).toBe(1);
    await d.cycle();
    expect(b.cache.warm).toBe(false);
    expect([a, c, d].map((x) => x.cache.warm)).toEqual([true, true, true]);
  });
});

describe("the locator budget: a warm mailbox still hits its memo", () => {
  /**
   * THE POSITIVE CONTROL. A bound that is met by never remembering anything is not this fix: it
   * would put the whole projection back on the wire every cycle for every mailbox. Inside the
   * budget the memo behaves exactly as it did — one database read for the attachment, every later
   * cycle from memory.
   */
  it("reads the database once and serves every later cycle from memory", async () => {
    const budget = new KnownSetBudget(ONE * 3);
    const a = attach(0, budget, fixtureRows(0, ROWS));
    const b = attach(1, budget, fixtureRows(1, ROWS));
    for (let cycle = 0; cycle < 6; cycle++) { await a.cycle(); await b.cycle(); }
    expect(a.dbReads).toBe(1);
    expect(b.dbReads).toBe(1);
    expect(a.cache.census().hits + b.cache.census().hits).toBeGreaterThan(0);
    expect(budget.warmCount).toBe(2);
  });

  it("keeps serving the same rows it read — the bound changes what is kept, never what is answered", async () => {
    const budget = new KnownSetBudget(ONE * 3);
    const rows = fixtureRows(0, ROWS);
    const a = attach(0, budget, rows);
    const first = await a.cycle();
    const second = await a.cycle();
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });
});

describe("the locator budget: the refusals", () => {
  /**
   * ONE MAILBOX MAY NOT SPEND THE PROCESS'S MEMORY ON ITSELF. A projection larger than the whole
   * budget is not retained at all — that mailbox reads cold every cycle, which costs it one read,
   * rather than being admitted and evicting every other mailbox to make room for itself.
   */
  it("does not retain a projection larger than the whole budget, and evicts nobody for it", async () => {
    const budget = new KnownSetBudget(ONE * 2);
    const small = attach(0, budget, fixtureRows(0, ROWS));
    await small.cycle();
    const huge = attach(1, budget, fixtureRows(1, ROWS * 10));
    await huge.cycle();
    expect(huge.cache.warm).toBe(false);
    expect(huge.cache.census().droppedBy)
      .toBe("not admitted: one projection over the whole process locator budget");
    // The positive control on the same budget: the ordinary projection is still admitted and still
    // warm, so the refusal above is about the size and not about the budget refusing everything.
    expect(small.cache.warm).toBe(true);
    expect(budget.warmCount).toBe(1);
    // And it reads cold every cycle rather than silently answering stale rows.
    await huge.cycle();
    expect(huge.dbReads).toBe(2);
  });

  /**
   * THROUGH THE CURSOR, not `list()` alone: a mailbox over the budget is read cold, and the cursor
   * built from that read must not be kept as a derivation the memo cannot follow (it holds no
   * entries, so the import's appends never reach it). Kept, the next cycle hands the adapter the
   * same known list and the import fetches the same newest batch for ever.
   */
  it("a refused mailbox's next cursor names the letters stored since, so the import advances", async () => {
    const budget = new KnownSetBudget(ONE);
    const rows = fixtureRows(0, ROWS * 2).map((r) => ({ ...r, folder: "INBOX" }));
    const epoch = rows[0]!.uidValidity;
    let reads = 0;
    const repo = {
      getMailboxFolders: async () => [{ folder: "INBOX", uidValidity: epoch, uidNext: 0, highestModseq: "0" }],
      listKnownLocators: async () => { reads += 1; return [...rows]; },
    } as unknown as WorkerRepo;
    const cache = new KnownSetCache("mb", budget);
    const watched = watchKnownSet(repo, cache);
    const knownUids = (c: ImapCursor) => c.folders["INBOX"]!.known.map((k) => k.uid);

    expect(knownUids(await buildCursor(watched, "mb", undefined, undefined, cache))).toHaveLength(ROWS * 2);
    expect(cache.census().droppedBy).toBe("not admitted: one projection over the whole process locator budget");
    for (const uid of [9001, 9002]) {
      // One creates-only cycle: the ingest stores a letter and tells the memo, as `insertMessage` does.
      const stored: KnownLocator = { folder: "INBOX", uid, uidValidity: epoch, messageId: `<${uid}@fixture.invalid>`, seen: false };
      rows.push(stored);
      cache.noteInserted(stored);
      expect(knownUids(await buildCursor(watched, "mb", undefined, undefined, cache))).toContain(uid);
    }
    expect(reads).toBe(3);
  });

  it("gives the bytes back when the memo is dropped", async () => {
    const budget = new KnownSetBudget(ONE * 3);
    const a = attach(0, budget, fixtureRows(0, ROWS));
    await a.cycle();
    expect(budget.chargedBytes).toBeGreaterThan(0);
    a.cache.drop("detached: test");
    expect(budget.chargedBytes).toBe(0);
    expect(budget.warmCount).toBe(0);
    a.cache.drop("detached: test");
    expect(budget.chargedBytes).toBe(0);
  });

  /**
   * THE BUDGET HOLDS ITS CACHES STRONGLY, so the door that retires a runtime has to be the door
   * that drops the memo: a runtime removed without a drop would leave its whole projection charged
   * here and unreachable to evict. That door is `detachMailbox` in `index.ts`; this reads the call
   * rather than a comment about it.
   */
  it("the worker's detach path drops the memo, which is what releases the charge", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
    expect(src).toContain("knownSet?.drop(`detached: ${reason}`)");
    expect(src).toContain('knownSet?.drop("leader lock lost")');
  });
});

describe("the locator budget: what a remembered locator is charged", () => {
  it("charges every string the entry holds, its object and its membership key", () => {
    const one = estimateRetainedBytes([{
      folder: "INBOX", uid: 1, uidValidity: "1700000000", messageId: "<a@b>", seen: false,
    }]);
    //   128 object + (16 + 2*5) folder + (16 + 2*10) uidValidity + (16 + 2*5) messageId
    // + (16 + 2*(5 + 10 + 1 + 2)) key + 24 slot. The two overheads are MEASURED against rows a
    // real Postgres minted, not reasoned: the first draft charged 334 bytes for an entry the heap
    // held 360 of, and a budget that under-charges is a bound quietly exceeded.
    expect(one).toBe(128 + 26 + 36 + 26 + 52 + 24);
    // An absent Message-ID is charged nothing for the string it does not hold.
    const none = estimateRetainedBytes([{
      folder: "INBOX", uid: 1, uidValidity: "1700000000", messageId: null, seen: false,
    }]);
    expect(none).toBe(one - 26);
    expect(estimateRetainedBytes([])).toBe(0);
    // Linear in the row count, which is what makes the budget's arithmetic readable. Measured on
    // one repeated entry: `fixtureRows` widens its own UIDs and Message-IDs as it counts up, so a
    // a projection twice as long is legitimately a few bytes more than twice the shorter one.
    const same = { folder: "INBOX", uid: 1, uidValidity: "1700000000", messageId: "<a@b>", seen: false };
    expect(estimateRetainedBytes(Array.from({ length: 100 }, () => same))).toBe(one * 100);
    expect(estimateRetainedBytes(fixtureRows(0, 100)))
      .toBeGreaterThan(estimateRetainedBytes(fixtureRows(0, 50)) * 2);
  });
});
