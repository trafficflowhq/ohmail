import { describe, it, expect } from "vitest";
import { ImapAdapter } from "../../src/adapters/imap.js";
import { WATCHED_FOLDERS, type ImapCursor } from "../../src/adapters/imap-types.js";

/**
 * THE FLAG DRAIN'S RESUME POINT UNDER A **SHARED** BUDGET — the stall that left a real
 * mailbox with `initial_import_completed_at` NULL for four days.
 *
 * `imap.changes.flagbudget.test.ts` proves the drain resumes correctly when it is the only
 * claimant on the budget. It cannot see this, because the budget is ONE object spent across all
 * of `WATCHED_FOLDERS` in order (`changesSince`, "ONE budget for the whole call") and that file's
 * fake serves INBOX alone. Everything below needs a SECOND folder that reaches the flag pass
 * with the budget already spent.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────
 *
 * The pass recorded its resume point as `lastFlagUid + 1`, where `lastFlagUid` started at 0 and
 * only ever moved when a flag change was ACCEPTED. So a folder that reached the loop with
 * `budget.flags <= 0` broke on its first known UID having accepted nothing, and wrote
 * `resumeUid: 1` — not "no progress this pass" but **"start over"**, discarding every UID the
 * folder had already drained on earlier cycles. `flagsTruncated` then held the folder cursor, so
 * the next cycle re-read the identical range from the beginning.
 *
 * That is a permanent stall rather than a slow one, and the difference is what made it survive
 * days of healthy cycles: the drain does not need to be starved CONTINUOUSLY. It needs only to be
 * starved more often than it can finish. A folder needing four clean cycles, reset by an INBOX
 * burst every third, never reaches the end — and `hasBacklog` is true on every one of those
 * cycles, so `stampInitialImportComplete` (apps/worker/src/index.ts, gated on
 * `hasBacklog === false`) is never reached and the mailbox reads as "still importing" for ever.
 *
 * The unknown-UID `continue` above the budget check is the same mistake in the other direction:
 * a UID that is not in the known-set WAS examined — unknown-ness is an answer, not a skip — and
 * leaving the cursor behind it means the next pass re-reads it from the server for nothing.
 *
 * ── THE FIX THESE TESTS PIN ────────────────────────────────────────────────────────────────
 *
 * `lastFlagUid` means "the highest UID this pass EXAMINED": seeded at `from - 1`, so a pass that
 * accepted nothing records no progress instead of rewinding, and advanced on unknown UIDs as well
 * as accepted ones. Two independent lines, each watched red on its own below.
 *
 * An anti-stall floor of the kind `fetchCapped` has for creates — admit the first candidate of a
 * folder however spent the budget — was written for this and dropped. It passes both starvation
 * tests on its own, which is the problem: with it in place `flagsTruncated` implies something was
 * accepted, so the seed can never be reached and cannot be watched fail. The residual it would
 * have covered (a folder starved on EVERY cycle makes no progress, though it loses none) is
 * stated at the fix.
 */

interface Changed { uid: number; modseq: bigint }

interface FakeFolder {
  uidValidity: bigint;
  uidNext: number;
  /** HIGHESTMODSEQ the server reports for this folder. */
  serverModseq: bigint;
  /** Every UID present on the server, in UID order. */
  uids: number[];
  /** What `changedSince` reports, filtered by `modseq > since`. */
  changed: Changed[];
}

/** `n` consecutive changed UIDs from `from`, all at `modseq`. */
const changedRun = (n: number, from: number, modseq: bigint): Changed[] =>
  Array.from({ length: n }, (_, i) => ({ uid: from + i, modseq }));

/**
 * A CONDSTORE server with real INBOX and `ohmail/Screener` folders, and empty ohmail folders
 * behind them — the shape `changesSince` actually walks.
 */
function makeFakeClient(folders: Record<string, FakeFolder>) {
  const empty = (path: string): FakeFolder =>
    ({ uidValidity: 100n, uidNext: 1, serverModseq: 0n, uids: [], changed: [] });
  for (const f of WATCHED_FOLDERS) folders[f] ??= empty(f);

  /** Every `changedSince` fetch, in order: which folder, which range. The proof of resumption. */
  const ranges: Array<{ folder: string; range: string; since: bigint }> = [];
  const client = {
    capabilities: new Map<string, boolean>([["CONDSTORE", true], ["MOVE", true], ["UIDPLUS", true], ["IDLE", true]]),
    mailbox: {} as { path: string; uidValidity: bigint; uidNext: number; highestModseq: bigint; exists: number },
    folders,
    ranges,
    _path: "INBOX",
    /** No Sent folder: `foldersToScan` must resolve `sent: null` so the watermark branch is out. */
    async list() {
      return WATCHED_FOLDERS.map((path) => ({ path, name: path, delimiter: "/", flags: new Set<string>() }));
    },
    async getMailboxLock(path: string) {
      this._path = path;
      const f = folders[path]!;
      this.mailbox = {
        path, uidValidity: f.uidValidity, uidNext: f.uidNext,
        highestModseq: f.serverModseq, exists: f.uids.length,
      };
      return { path, release() { /* no lock in the fake */ } };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async *fetch(range: any, _query: any, options: any) {
      const f = folders[this._path]!;
      if (options?.changedSince) {
        const since = options.changedSince as bigint;
        ranges.push({ folder: this._path, range: String(range), since });
        // Honour the requested range AND the modseq. A fake that ignores either would pass
        // against an implementation whose cursor never moves — which is the defect itself.
        const from = Number(String(range).split(":")[0] ?? 1);
        for (const c of f.changed) {
          if (c.uid < from || c.modseq <= since) continue;
          yield { uid: c.uid, flags: new Set(["\\Seen"]), modseq: c.modseq };
        }
        return;
      }
      // The uid-only enumeration (`enumerateUids`). Every UID is in the cursor's known-set in
      // these tests, so no creates are produced and `fetchCapped` is never reached.
      for (const uid of f.uids) yield { uid };
    },
  };
  return client;
}

/** A cursor that knows every UID of every folder, at `highestModseq` 50. */
function cursorFor(folders: Record<string, FakeFolder>): ImapCursor {
  const cursor: ImapCursor = { folders: {} };
  for (const f of WATCHED_FOLDERS) {
    const fake = folders[f]!;
    cursor.folders[f] = {
      uidValidity: String(fake.uidValidity),
      uidNext: fake.uidNext,
      highestModseq: "50",
      known: fake.uids.map((uid) => ({ uid, messageId: `u${f}${uid}@x` })),
    };
  }
  return cursor;
}

/** Carry a returned cursor into the next cycle, exactly as `packages/organizer/src/sync.ts` persists it. */
function thread(cursor: ImapCursor, next: ImapCursor): void {
  for (const [folder, c] of Object.entries(next.folders)) {
    const prev = cursor.folders[folder];
    if (!prev) continue;
    prev.uidValidity = c.uidValidity;
    prev.uidNext = c.uidNext;
    prev.highestModseq = c.highestModseq;
  }
}

function makeAdapter(client: unknown, maxBatchFlags: number) {
  return new ImapAdapter(
    { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } },
    { client, maxBatchFlags },
  );
}

/**
 * The ranges one folder was asked for, in order.
 *
 * ALWAYS FILTERED BY FOLDER. Every watched folder is on the fast path in these fakes — the empty
 * ones too, since the cursor gives them a non-"0" modseq — so an unfiltered `fake.ranges` is six
 * `"1:*"` entries per cycle and an assertion on it reads the wrong folder's history.
 */
const rangesFor = (fake: ReturnType<typeof makeFakeClient>, folder: string) =>
  fake.ranges.filter((r) => r.folder === folder).map((r) => r.range);

const screenerRanges = (fake: ReturnType<typeof makeFakeClient>) =>
  rangesFor(fake, "ohmail/Screener");

describe("ImapAdapter.changesSince — the flag drain under a starved budget", () => {
  /**
   * THE REWIND. A folder that has already drained six UIDs is thrown back to UID 1 by one cycle
   * in which an earlier folder spent the whole budget.
   *
   * Mutation watched: restore `let lastFlagUid = 0` and the third range is `"1:*"` —
   * `expected '1:*' not to be '1:*'`.
   */
  it("does not restart a folder's drain when the budget was spent before it", async () => {
    const folders: Record<string, FakeFolder> = {
      INBOX: {
        uidValidity: 100n, uidNext: 41, serverModseq: 60n,
        uids: Array.from({ length: 40 }, (_, i) => i + 1),
        changed: changedRun(4, 1, 51n),        // quiet on cycle 1: four changes, budget to spare
      },
      "ohmail/Screener": {
        uidValidity: 100n, uidNext: 41, serverModseq: 60n,
        uids: Array.from({ length: 40 }, (_, i) => i + 1),
        changed: changedRun(40, 1, 51n),       // a long drain, many cycles' worth
      },
    };
    const fake = makeFakeClient(folders);
    const adapter = makeAdapter(fake, 10);
    await adapter.connect();
    const cursor = cursorFor(folders);

    // ── Cycle 1: INBOX takes 4, Screener drains uids 1-6 with what is left ──────────────────
    const first = await adapter.changesSince(cursor);
    expect(first.hasBacklog, "Screener is truncated at uid 6").toBe(true);
    expect(screenerRanges(fake)).toEqual(["1:*"]);
    thread(cursor, first.newCursor);

    // ── Cycle 2: INBOX gets busy and spends the ENTIRE budget ───────────────────────────────
    folders["INBOX"]!.changed = changedRun(10, 1, 71n);
    folders["INBOX"]!.serverModseq = 80n;
    const second = await adapter.changesSince(cursor);
    expect(second.hasBacklog).toBe(true);
    // Screener resumed correctly here — its drain from cycle 1 is still in memory.
    expect(screenerRanges(fake).at(-1)).toBe("7:*");
    thread(cursor, second.newCursor);

    // ── Cycle 3: THE ASSERTION. Cycle 2 accepted nothing for Screener, so the resume point must
    // be untouched (or one further, under the anti-stall floor) — never back at the start.
    folders["INBOX"]!.changed = [];
    const third = await adapter.changesSince(cursor);

    expect(screenerRanges(fake).at(-1), "a starved pass must not discard the drain's progress")
      .not.toBe("1:*");
    // Nothing already drained may be reported twice, either: uids 1-6 are behind the cursor.
    const reported = third.flagChanges
      .filter((c) => c.locator.folder === "ohmail/Screener")
      .map((c) => Number(c.locator.ref.split(":")[1]));
    expect(Math.min(...reported)).toBeGreaterThan(6);
  });

  /**
   * THE STALL ITSELF, at the level the worker reads: `hasBacklog` never reaching false.
   *
   * INBOX bursts to exactly the budget on every third cycle — the worker's own filing moves are
   * enough to do that on a mailbox mid-import. A drain needing four clean cycles, reset every
   * third, never finishes. This is the acceptance test for the stamp: `hasBacklog === false` is
   * the one gate `stampInitialImportComplete` sits behind.
   *
   * Mutation watched: restore `let lastFlagUid = 0` and this runs all 24 cycles with
   * `hasBacklog` true on every one — `expected -1 to be greater than 0`.
   */
  it("reaches hasBacklog === false — the gate the initial-import stamp sits behind", async () => {
    const folders: Record<string, FakeFolder> = {
      INBOX: {
        uidValidity: 100n, uidNext: 41, serverModseq: 60n,
        uids: Array.from({ length: 40 }, (_, i) => i + 1),
        changed: [],
      },
      "ohmail/Screener": {
        uidValidity: 100n, uidNext: 41, serverModseq: 60n,
        uids: Array.from({ length: 40 }, (_, i) => i + 1),
        changed: changedRun(40, 1, 51n),
      },
    };
    const fake = makeFakeClient(folders);
    const adapter = makeAdapter(fake, 10);
    await adapter.connect();
    const cursor = cursorFor(folders);

    let drainedAfter = -1;
    let inboxModseq = 60n;
    for (let cycle = 1; cycle <= 24; cycle++) {
      if (cycle % 3 === 0) {
        // The burst is exactly the budget, so INBOX itself is never truncated — the ONLY reason
        // this cycle owes anything is the folder behind it.
        folders["INBOX"]!.changed = changedRun(10, 1, inboxModseq + 1n);
        folders["INBOX"]!.serverModseq = inboxModseq + 10n;
        inboxModseq += 10n;
      } else {
        folders["INBOX"]!.changed = [];
      }
      const batch = await adapter.changesSince(cursor);
      thread(cursor, batch.newCursor);
      if (!batch.hasBacklog) { drainedAfter = cycle; break; }
    }

    expect(drainedAfter, "an intermittently starved drain must still terminate")
      .toBeGreaterThan(0);
  });

  /**
   * UNKNOWN UIDS ARE EXAMINED, NOT SKIPPED. `changedSince` reports any changed message, including
   * ones the known-set has never seen (their bodies come from the creates diff, and their flags
   * arrive with them). Leaving the resume point behind a run of them re-reads that run from the
   * server on every pass of the drain, for nothing.
   *
   * Mutation watched: drop the `lastFlagUid = m.uid` from the unknown arm and the second range is
   * `"11:*"` — the ten unknown UIDs are asked for again.
   */
  it("advances the resume point past unknown UIDs", async () => {
    const folders: Record<string, FakeFolder> = {
      INBOX: {
        uidValidity: 100n, uidNext: 31, serverModseq: 60n,
        // uids 1-10 are known; 11-20 exist on the server but are NOT in the cursor's known-set.
        uids: Array.from({ length: 30 }, (_, i) => i + 1),
        changed: changedRun(30, 1, 51n),
      },
    };
    const fake = makeFakeClient(folders);
    const adapter = makeAdapter(fake, 10);
    await adapter.connect();

    const cursor = cursorFor(folders);
    // Known-set: 1-10 and 21-30. 11-20 are the unknown run in the middle.
    cursor.folders["INBOX"]!.known = [...Array.from({ length: 10 }, (_, i) => i + 1),
      ...Array.from({ length: 10 }, (_, i) => i + 21)]
      .map((uid) => ({ uid, messageId: `uINBOX${uid}@x` }));

    const first = await adapter.changesSince(cursor);
    expect(first.hasBacklog, "20 known changes at a budget of 10").toBe(true);
    expect(first.flagChanges.map((c) => Number(c.locator.ref.split(":")[1]))).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 1),
    );

    thread(cursor, first.newCursor);
    await adapter.changesSince(cursor);

    // The pass stopped ON uid 21 (the first change it had no budget for), having examined and
    // dismissed 11-20 on the way. It must resume AT 21, not before the unknown run.
    expect(rangesFor(fake, "INBOX")).toEqual(["1:*", "21:*"]);
  });

  /**
   * ── THE SCHEDULING STARVATION, AT THE MEASURED SIZES ───────────────────────────────────────
   *
   * The two tests above are about a folder LOSING progress. This one is about a folder never
   * being ASKED, which the resume-point fix does nothing for and which is what actually held the
   * a real iCloud mailbox at `initial_import_completed_at IS NULL`.
   *
   * The numbers have the live shape, scaled down so the test is a second rather than a
   * minute: `ohmail/Screener` owes far more known UIDs than the budget, and the four folders
   * behind it owe a few each. Under FIFO the leader needs eleven whole cycles before anything
   * behind it is read at all; at the unscaled sizes that is sixteen cycles of an IMAP mailbox
   * doing nothing else, and the tail is dark for every one of them.
   *
   * CYCLE 2, NOT CYCLE 1, AND THAT IS THE DESIGN. Before the first pass nothing is known to owe —
   * a drain is the only evidence there is — so cycle 1 is deliberately the FIFO order and the
   * schedule takes hold once the starved folders have recorded their drains. The transient is one
   * cycle; the stall was days.
   *
   * Mutations watched, both on the schedule block in `imap.ts`:
   *   • per-folder share removed (`const allowance = budget.flags`) — the tail is never read at
   *     all while the leader owes, and `readOnCycleTwo` fails
   *     `expected [ 'ohmail/Screener' ] to have a length of 5`.
   *   • rotation removed (`const flagLead = null`) — this test STAYS GREEN, and that is recorded
   *     rather than fixed: an equal share converges on its own. What rotation decides is who is
   *     exempt from the share, and the test that watches it is the next one.
   */
  it("reads every owing folder once the drains are known, and rotates which one leads", async () => {
    // The owed sizes below, the leader far past the others and Sent past all of them —
    // against DEFAULT_SYNC_BATCH_MAX_FLAGS = 500.
    const owed: Record<string, number> = {
      "ohmail/Screener": 510, "ohmail/News": 4, "ohmail/Receipts": 1,
      "ohmail/Screened": 24, "ohmail/Quarantine": 25,
    };
    const folders: Record<string, FakeFolder> = {
      INBOX: {
        uidValidity: 100n, uidNext: 2, serverModseq: 60n, uids: [1], changed: [],
      },
    };
    for (const [name, n] of Object.entries(owed)) {
      folders[name] = {
        uidValidity: 100n, uidNext: n + 1, serverModseq: 60n,
        uids: Array.from({ length: n }, (_, i) => i + 1),
        changed: changedRun(n, 1, 51n),
      };
    }
    const fake = makeFakeClient(folders);
    const adapter = makeAdapter(fake, 50);
    await adapter.connect();
    const cursor = cursorFor(folders);

    /** Folder → the highest UID reported for it so far. The per-folder proof of convergence. */
    const highWater = new Map<string, number>();
    const perCycle: Array<Map<string, number>> = [];
    let drainedAfter = -1;
    for (let cycle = 1; cycle <= 40; cycle++) {
      const batch = await adapter.changesSince(cursor);
      const took = new Map<string, number>();
      for (const c of batch.flagChanges) {
        const f = c.locator.folder;
        const uid = Number(c.locator.ref.split(":")[1]);
        took.set(f, (took.get(f) ?? 0) + 1);
        highWater.set(f, Math.max(highWater.get(f) ?? 0, uid));
      }
      perCycle.push(took);
      thread(cursor, batch.newCursor);
      if (!batch.hasBacklog) { drainedAfter = cycle; break; }
    }

    // 1. NOTHING IS DARK. Every owing folder was read on cycle 2 — the first cycle on which any
    // of them is KNOWN to owe — and not just the head of the queue.
    const readOnCycleTwo = [...perCycle[1]!.keys()].sort();
    expect(readOnCycleTwo, "every owing folder is read once its drain is on record")
      .toHaveLength(Object.keys(owed).length);

    // 2. IT CONVERGES, and within the budget's own bound: the owed UIDs at the budget a cycle cannot be
    // done in fewer than 12, and a schedule that wastes budget would take many more.
    const totalOwed = Object.values(owed).reduce((a, b) => a + b, 0);
    expect(drainedAfter, "the whole set drains and the cycle ends with no backlog").toBeGreaterThan(0);
    expect(drainedAfter).toBeLessThanOrEqual(Math.ceil(totalOwed / 50) + 4);

    // 3. EVERY FOLDER FINISHED — the cursor moved to the end of each one, which is what
    // `hasBacklog === false` is claiming on the worker's behalf.
    for (const [name, n] of Object.entries(owed)) {
      expect(highWater.get(name), `${name} drained to its last UID`).toBe(n);
    }

  });

  /**
   * THE ROTATION ITSELF. Two folders that both want the whole budget, for ever.
   *
   * With an equal share and no rotation the split is the same every cycle — each takes exactly
   * `ceil(budget / claimants)` and the folder at the front of the walk is permanently the one that
   * gets the rounding. Rotation exempts ONE claimant per cycle from the share (down to the floor
   * every folder behind it keeps), so the split alternates and the front of the queue moves.
   *
   * Mutation watched: `const flagLead: string | null = null` in `imap.ts` and both takes are 25 on
   * every cycle — `expected 1 to be greater than 1`.
   */
  it("rotates which owing folder is exempt from the share", async () => {
    const big = (n: number): FakeFolder => ({
      uidValidity: 100n, uidNext: n + 1, serverModseq: 60n,
      uids: Array.from({ length: n }, (_, i) => i + 1),
      changed: changedRun(n, 1, 51n),
    });
    const folders: Record<string, FakeFolder> = {
      INBOX: { uidValidity: 100n, uidNext: 2, serverModseq: 60n, uids: [1], changed: [] },
      "ohmail/Screener": big(400),
      "ohmail/Quarantine": big(400),
    };
    const fake = makeFakeClient(folders);
    const adapter = makeAdapter(fake, 50);
    await adapter.connect();
    const cursor = cursorFor(folders);

    const takes: Record<string, number[]> = { "ohmail/Screener": [], "ohmail/Quarantine": [] };
    for (let cycle = 1; cycle <= 5; cycle++) {
      const batch = await adapter.changesSince(cursor);
      thread(cursor, batch.newCursor);
      if (cycle === 1) continue;   // the FIFO cycle: no drain is on record yet
      for (const f of Object.keys(takes)) {
        takes[f]!.push(batch.flagChanges.filter((c) => c.locator.folder === f).length);
      }
    }

    // Both folders owe far more than the budget on every cycle, so a fixed schedule would hand
    // each of them the identical number every time.
    for (const [f, seq] of Object.entries(takes)) {
      expect(new Set(seq).size, `${f}'s share of the cycle changes as the lead rotates`)
        .toBeGreaterThan(1);
    }
    // …and the budget is still fully spent, whoever leads.
    for (let i = 0; i < takes["ohmail/Screener"]!.length; i++) {
      expect(takes["ohmail/Screener"]![i]! + takes["ohmail/Quarantine"]![i]!).toBe(50);
    }
  });

  /**
   * THE ORDINARY BUDGET EXHAUSTION STILL RESUMES EXACTLY WHERE IT STOPPED — the property the
   * fix must not trade away, asserted here across the folder boundary that
   * `imap.changes.flagbudget.test.ts` cannot reach.
   */
  it("still resumes at the first UID it had no budget for, when the budget was its own", async () => {
    const folders: Record<string, FakeFolder> = {
      INBOX: {
        uidValidity: 100n, uidNext: 26, serverModseq: 60n,
        uids: Array.from({ length: 25 }, (_, i) => i + 1),
        changed: changedRun(25, 1, 51n),
      },
    };
    const fake = makeFakeClient(folders);
    const adapter = makeAdapter(fake, 10);
    await adapter.connect();
    const cursor = cursorFor(folders);

    const seen: number[] = [];
    for (let cycle = 0; cycle < 4; cycle++) {
      const batch = await adapter.changesSince(cursor);
      for (const c of batch.flagChanges) seen.push(Number(c.locator.ref.split(":")[1]));
      thread(cursor, batch.newCursor);
      if (!batch.hasBacklog) break;
    }

    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(rangesFor(fake, "INBOX")).toEqual(["1:*", "11:*", "21:*"]);
    // Every pass read against the modseq the drain STARTED on.
    expect(new Set(fake.ranges.filter((r) => r.folder === "INBOX").map((r) => String(r.since))))
      .toEqual(new Set(["50"]));
  });
});
