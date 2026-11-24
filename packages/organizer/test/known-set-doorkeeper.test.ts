import { describe, it, expect } from "vitest";
import type { KnownLocator } from "@trafficflow/core/adapters/drizzle-repo";
import { KnownSetCache, KnownSetBudget, estimateRetainedBytes } from "../src/known-set.js";
import { KnownSetDoorkeeper, DOORKEEPER_MAX_MAILBOXES } from "../src/known-set-doorkeeper.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A POLLED ROSTER LARGER THAN THE BUDGET KEEPS THE MEMOS IT WILL HIT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Least-recently-used has one degenerate case and the worker's poll is it: round-robin over a
 * roster the budget cannot hold evicts every mailbox before its own turn comes round, so the hit
 * rate is 0.00 and every cycle pays one `listKnownLocators`. The doorkeeper admits a projection on
 * its SECOND miss inside one roster round, and only while the budget is full — a roster the budget
 * holds whole must pay nothing for one that does not.
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

const ROWS = 200;
const ONE = estimateRetainedBytes(fixtureRows(0, ROWS));

/** A roster of memos on one budget, polled round-robin the way the loop polls one pass. */
function roster(n: number, budget: KnownSetBudget, rows = ROWS) {
  const caches = Array.from({ length: n }, (_, m) => new KnownSetCache(`mailbox-${m}`, budget));
  const data = Array.from({ length: n }, (_, m) => fixtureRows(m, rows));
  const dbReads = new Map<string, number>();
  async function round() {
    let hits = 0, reads = 0;
    for (let m = 0; m < n; m++) {
      const cache = caches[m]!;
      cache.beginCycle();
      await cache.list(async (id) => {
        dbReads.set(id, (dbReads.get(id) ?? 0) + 1);
        return data[m]!;
      }, cache.mailboxId);
      hits += cache.census().hits;
      reads += cache.census().dbReads;
    }
    return { hits, reads, rate: hits / n, warm: caches.filter((c) => c.warm).length };
  }
  return { caches, round, dbReads };
}

describe("the locator doorkeeper: a roster over the budget", () => {
  /**
   * THE ROW THIS LANE EXISTS FOR. Ten mailboxes poll round-robin against a budget that fits three
   * projections. Every round's hit rate is read off the memos' own counters. Mutation watched red:
   * `admits` returning true on a first miss (the doorkeeper removed) takes every one of these
   * rounds to zero hits, which is the thrash the row recorded.
   */
  it("keeps some memos across rounds instead of replacing every one of them", async () => {
    const budget = new KnownSetBudget(ONE * 3);
    const r = roster(10, budget);
    const rates: number[] = [];
    for (let i = 0; i < 8; i++) rates.push((await r.round()).rate);
    // A number, not zero — the invariant. The first round is cold under every policy.
    expect(rates.slice(1).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(Math.max(...rates)).toBeGreaterThan(0);
    // And the memory is bounded exactly as before: never more than three memos, never over the bound.
    expect(budget.warmCount).toBeLessThanOrEqual(3);
    expect(budget.chargedBytes).toBeLessThanOrEqual(budget.limitBytes);
  });

  it("holds the bound at every step of the poll, not only at the end of it", async () => {
    const budget = new KnownSetBudget(ONE * 3);
    const r = roster(10, budget);
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const out = await r.round();
      seen.push(out.warm);
      expect(budget.chargedBytes).toBeLessThanOrEqual(budget.limitBytes);
    }
    expect(Math.max(...seen)).toBeLessThanOrEqual(3);
  });
});

describe("the locator doorkeeper: a roster the budget holds whole pays nothing", () => {
  /**
   * THE POSITIVE CONTROL, and the reason the door is only shut while the budget is full. Three
   * mailboxes on a budget that fits three: each is admitted on its FIRST miss, so the roster reads
   * the database once per mailbox and every later round is served from memory. A doorkeeper with
   * no pressure gate would charge this roster an extra cold round per mailbox to buy nothing.
   */
  it("admits on the first miss and reads the database once per mailbox", async () => {
    const budget = new KnownSetBudget(ONE * 3);
    const r = roster(3, budget);
    const first = await r.round();
    expect(first.reads).toBe(3);
    expect(first.warm).toBe(3);
    for (let i = 0; i < 4; i++) {
      const out = await r.round();
      expect(out.rate).toBe(1);
      expect(out.reads).toBe(0);
    }
    expect([...r.dbReads.values()]).toEqual([1, 1, 1]);
  });

  it("still refuses a projection larger than the whole budget, every round", async () => {
    const budget = new KnownSetBudget(ONE * 2);
    const small = new KnownSetCache("mailbox-small", budget);
    const huge = new KnownSetCache("mailbox-huge", budget);
    const smallRows = fixtureRows(0, ROWS);
    const hugeRows = fixtureRows(1, ROWS * 10);
    let hugeReads = 0;
    for (let i = 0; i < 3; i++) {
      small.beginCycle();
      await small.list(async () => smallRows, small.mailboxId);
      huge.beginCycle();
      await huge.list(async () => { hugeReads++; return hugeRows; }, huge.mailboxId);
    }
    expect(huge.warm).toBe(false);
    expect(hugeReads).toBe(3);
    expect(huge.census().droppedBy)
      .toBe("not admitted: one projection over the whole process locator budget");
    // The positive control beside it: the ordinary projection on the same budget is still warm.
    expect(small.warm).toBe(true);
  });
});

describe("the locator doorkeeper: the round boundary", () => {
  /**
   * ONE ROUND OF MEMORY, AND ONLY ONE. The loop calls `beginCycle` once per mailbox per pass, so a
   * mailbox beginning a second cycle IS the roster having come round — no pass counter exists for
   * the memo to read. Mutation watched red: never rotating (the generations kept for ever) admits
   * C below, whose only miss was two rounds earlier.
   */
  it("admits a miss one round after the first and not one two rounds after", () => {
    const dk = new KnownSetDoorkeeper();
    expect(dk.armed).toBe(false);
    for (const id of ["A", "B", "C"]) {
      dk.beginCycle(id);
      expect(dk.admits(id), `${id} is a first miss in round 1`).toBe(false);
    }
    // Round 2 begins where A comes round again. A and B miss a second time and are admitted; C
    // takes no turn this round, so nothing records it again.
    dk.beginCycle("A");
    expect(dk.admits("A")).toBe(true);
    dk.beginCycle("B");
    expect(dk.admits("B")).toBe(true);
    // Round 3. C's only record is round 1's, which the boundary dropped.
    dk.beginCycle("A");
    expect(dk.admits("C"), "a first miss two rounds old may not open the door").toBe(false);
    // And A, admitted in round 2 and never recorded since, is a fresh first miss here.
    expect(dk.admits("A")).toBe(false);
  });

  /**
   * BEFORE THE FIRST ROUND THERE IS NO WINDOW a second miss could be inside, so the door stands
   * open and the LRU decides alone. That is what an attach pass is, and what a caller driving the
   * budget without announcing cycles is.
   */
  it("stands open until a cycle is announced", async () => {
    const dk = new KnownSetDoorkeeper();
    expect(dk.admits("mailbox-0")).toBe(true);
    expect(dk.sizes).toEqual({ current: 0, previous: 0 });
    const budget = new KnownSetBudget(ONE * 3);
    const cache = new KnownSetCache("mailbox-0", budget);
    await cache.list(async () => fixtureRows(0, ROWS), cache.mailboxId);
    expect(cache.warm).toBe(true);
  });
});

describe("the locator doorkeeper: its own memory is bounded and charged", () => {
  /**
   * THE SEEN-SET IS A BOUND, NOT A SIZE. Mutation watched red: dropping the
   * `current.size < DOORKEEPER_MAX_MAILBOXES` guard lets one generation grow with whatever ids
   * arrive, and the first case below reads the overflow.
   */
  it("stops recording past its bound and keeps the overflow cold", () => {
    const dk = new KnownSetDoorkeeper();
    dk.beginCycle("mailbox-arm");
    for (let i = 0; i < DOORKEEPER_MAX_MAILBOXES + 64; i++) dk.admits(`mailbox-${i}`);
    expect(dk.sizes.current).toBe(DOORKEEPER_MAX_MAILBOXES);
    // Past the bound a first miss is simply not recorded, so that mailbox reads cold — the cost it
    // paid before the memo existed, never an unbounded set.
    expect(dk.admits(`mailbox-${DOORKEEPER_MAX_MAILBOXES + 1000}`)).toBe(false);
    expect(dk.sizes.current).toBe(DOORKEEPER_MAX_MAILBOXES);
  });

  it("charges its own memory against the budget the memos spend", () => {
    const budget = new KnownSetBudget(ONE * 3);
    expect(budget.spendableBytes).toBe(budget.limitBytes);
    budget.beginCycle("mailbox-0");
    budget.doorkeeper.admits("mailbox-0");
    expect(budget.doorkeeper.chargedBytes).toBeGreaterThan(0);
    expect(budget.spendableBytes).toBe(budget.limitBytes - budget.doorkeeper.chargedBytes);
    // Both generations at the bound, against the deployed budget: a fraction of a percent of it.
    const full = 2 * DOORKEEPER_MAX_MAILBOXES * (16 + 2 * 36 + 24);
    expect(full).toBeLessThan((512 / 4) * 1024 * 1024 * 0.01);
  });
});
