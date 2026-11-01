import { describe, it, expect } from "vitest";
import type { NativeLocator } from "@trafficflow/core";
// The SAME module `sync.ts` imports these from — a second copy of the class would make every
// `instanceof` answer false and this file would be testing nothing.
import {
  FILING_BATCH_MAX, MessageGoneError, type MailboxAdapter, type MoveManyResult, type UidsHeldAnswer,
} from "@trafficflow/core/adapters/imap";
import type { WorkerRepo, PendingFolderState, PendingFlagState } from "@trafficflow/core/adapters/drizzle-repo";
import { reconcileMailbox, RECONCILE_MOVES_PER_CYCLE } from "../src/sync.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * ── FILING IS BATCHED, AND THE BATCH IS INDISTINGUISHABLE FROM THE LOOP IT REPLACED ─────────
 *
 * `reconcileFolders` moved one message per IMAP conversation: five commands each, every one a network round trip
 * against real hosts, and one long production screening session therefore held the
 * worker's SERIAL cycle for minutes while every other mailbox on it received no mail at all.
 *
 * The fix groups pending rows by (source folder → destination) and hands each chunk to
 * `moveMany`. Everything below is about the two things that has to preserve:
 *
 *  1. **The database ends up the same.** Same locators, same `folder_state` rows, same audit
 *     rows — a batched pass and a per-message pass are the same pass.
 *  2. **A group the adapter will not batch is filed the old way, exactly once.** `moveMany`
 *     answers `declined` for anything it cannot prove equivalent, BEFORE writing, so the fallback
 *     is a whole-chunk retry and never a half-filed group — and its third answer,
 *     `moved_unmapped`, is the one the fallback must refuse to take, because there the mail has
 *     already moved.
 *
 * …plus the bound that was missing entirely: `listPendingFolderStates` had no limit, which is what
 * let one mailbox's backlog monopolise the queue.
 */

const LOC = (folder: string, ref: string): NativeLocator => ({ folder, ref });

interface Recorded {
  /** Every `moveMany` call, as (source folder → destination, refs). */
  batches: Array<{ from: string; to: string; refs: string[] }>;
  /** Every single-message `move` call. */
  singles: Array<{ ref: string; to: string }>;
  locators: Array<{ messageId: string; locator: NativeLocator }>;
  folderStates: Array<{ messageId: string; desired: string; observed: string }>;
  flagStates: Array<{ messageId: string; desired: boolean; observed: boolean }>;
  audits: Array<{ action: string; messageId: string | null }>;
  /** Every conditional ADOPT — the writer that may move `desired_folder`. */
  adopted: Array<{ messageId: string; desired: string; observed: string; expectDesiredFolder: string }>;
  /** Every Trash drop asked for. */
  dropped: Array<{ messageId: string; locator: NativeLocator; expectDesired: string }>;
  /** Every body emptied, and every audit row's `refound`. */
  husked: string[];
  refound: string[];
  /** The limit the reconciler asked the repo for — the per-cycle budget. */
  askedLimit: number | undefined;
}

function blank(): Recorded {
  return {
    batches: [], singles: [], locators: [], folderStates: [], flagStates: [], audits: [],
    adopted: [], dropped: [], husked: [], refound: [], askedLimit: undefined,
  };
}

function repoOf(rec: Recorded, pending: PendingFolderState[], opts: {
  auditMany?: boolean;
  /** Message ids whose DISAPPEARANCE is durably on record — `primaryInstanceVanished` truth. */
  vanished?: ReadonlySet<string>;
  pendingFlags?: PendingFlagState[];
  /** This mailbox's Trash path, so a restore OUT of it can be told from a delete INTO it. */
  trashFolder?: string;
  /** Message ids whose gone locator is their ONLY recorded instance — `onlyInstanceAt` truth. */
  onlyInstance?: ReadonlySet<string>;
} = {}): WorkerRepo {
  const pushAudit = (action: string, payload: unknown) => {
    const messageId = payload && typeof payload === "object" && "messageId" in payload
      ? String((payload as { messageId: unknown }).messageId) : null;
    rec.audits.push({ action, messageId });
    if ((payload as { refound?: boolean } | null)?.refound === true) rec.refound.push(messageId!);
  };
  const stub: Record<string, unknown> = {
    listPendingFolderStates: async (_mailboxId: string, limit?: number) => {
      rec.askedLimit = limit;
      return limit != null ? pending.slice(0, limit) : pending;
    },
    listPendingFlagStates: async () => opts.pendingFlags ?? [],
    updateLocator: async (messageId: string, locator: NativeLocator) => { rec.locators.push({ messageId, locator }); },
    upsertFolderState: async (messageId: string, s: { desiredFolder: string; observedFolder: string }) => {
      rec.folderStates.push({ messageId, desired: s.desiredFolder, observed: s.observedFolder });
    },
    // The reconciler's completion path writes here, conditionally on the desire it read (see
    // `WorkerRepo.completeFolderState`). Recorded into the SAME array under the same two keys —
    // this file's subject is batching and grouping, not the write's conditionality, which is
    // proven in `junk-filing.test.ts` and `folder-completion-cas.pg.test.ts`. `true` because a
    // stub has no competing writer; the decline arm is a real-Postgres claim.
    completeFolderState: async (
      messageId: string, c: { expectDesiredFolder: string; observedFolder: string },
    ) => {
      rec.folderStates.push({ messageId, desired: c.expectDesiredFolder, observed: c.observedFolder });
      return true;
    },
    completeFlagState: async (
      messageId: string, c: { expectDesiredSeen: boolean; observedSeen: boolean },
    ) => {
      rec.flagStates.push({ messageId, desired: c.expectDesiredSeen, observed: c.observedSeen });
      return true;
    },
    primaryInstanceVanished: async (messageId: string) => opts.vanished?.has(messageId) ?? false,
    ...(opts.onlyInstance === undefined ? {} : {
      onlyInstanceAt: async (messageId: string) => opts.onlyInstance?.has(messageId) ?? false,
    }),
    ...(opts.trashFolder === undefined ? {} : {
      getMailboxSpecialFolders: async () => ({ junkFolder: null, trashFolder: opts.trashFolder ?? null }),
    }),
    adoptFolderState: async (
      messageId: string, st: { desiredFolder: string; observedFolder: string }, expectDesiredFolder: string,
    ) => {
      rec.adopted.push({ messageId, desired: st.desiredFolder, observed: st.observedFolder, expectDesiredFolder });
      return true;
    },
    dropGoneFromTrash: async (_a: string, _m: string, _trash: string, gone: Recorded["dropped"]) => {
      rec.dropped.push(...gone);
      return gone.map((g) => g.messageId);
    },
    huskBody: async (_a: string, messageId: string) => { rec.husked.push(messageId); return true; },
    forgetInstanceAt: async () => null,
    letterIdentities: async (_a: string, ids: readonly string[]) => new Map(ids.map((id) => [id, {
      messageIdHeader: `${id}@x.example`, dedupKey: `fp1:${id}`,
      legacy: { messageIdHeader: `${id}@x.example`, bodyHash: "h", subject: "s", fromAddress: "a@x.example" },
    }])),
    recordAudit: async (_a: string, action: string, payload: unknown) => { pushAudit(action, payload); },
    deferFolderReconcile: async () => {},
    deferFlagReconcile: async () => {},
    // The reconciler's completion writes are ONE GROUP (`fencedGroup`), so an unfenced caller
    // opens a transaction around them. Running the callback against this same object is all a
    // sequencing stub can offer; whether the group is genuinely atomic is a question about
    // Postgres and is answered in `reconcile-atomicity.pg.test.ts`.
    transaction: async (fn: (r: WorkerRepo) => Promise<unknown>) => fn(stub as unknown as WorkerRepo),
    // The removal fence reads this inside every write transaction; the double answers what a live
    // mailbox answers (see `assertMailboxStillHere`), because absent it the fence is a TypeError.
    mailboxStatusForWrite: async (): Promise<string> => "connected",
  };
  // Present or absent on purpose: `recordAudits` fans out to whichever shape the deployment has,
  // and both must write the same rows.
  if (opts.auditMany !== false) {
    stub.recordAuditMany = async (
      _a: string, rows: ReadonlyArray<{ action: string; payload: unknown }>,
    ) => { for (const r of rows) pushAudit(r.action, r.payload); };
  }
  return stub as unknown as WorkerRepo;
}

/** Rows moving `count` messages from `from` to `to`, ids prefixed by `tag`. */
function rows(tag: string, from: string, to: string, count: number, firstUid = 1): PendingFolderState[] {
  return Array.from({ length: count }, (_, i) => ({
    messageId: `${tag}-${i}`,
    desiredFolder: to,
    observedFolder: from,
    lastSetBy: "us" as const,
    nativeLocator: LOC(from, `1:${firstUid + i}`),
  }));
}

/** An adapter that batches everything, mapping each source uid to `9:<uid>` at the destination. */
function batchingAdapter(rec: Recorded, over: Partial<{
  answer: (locators: readonly NativeLocator[], to: string) => MoveManyResult | Error;
}> = {}): MailboxAdapter {
  return {
    moveMany: async (locators: readonly NativeLocator[], to: string): Promise<MoveManyResult> => {
      rec.batches.push({ from: locators[0]!.folder, to, refs: locators.map((l) => l.ref) });
      const custom = over.answer?.(locators, to);
      if (custom instanceof Error) throw custom;
      if (custom) return custom;
      const moved = new Map<string, NativeLocator>();
      for (const l of locators) moved.set(l.ref, LOC(to, `9:${l.ref.split(":")[1]}`));
      return { outcome: "batched", moved, gone: [] };
    },
    move: async (locator: NativeLocator, to: string) => {
      rec.singles.push({ ref: locator.ref, to });
      return LOC(to, `9:${locator.ref.split(":")[1]}`);
    },
    setFlags: async () => {},
  } as unknown as MailboxAdapter;
}

const run = async (repo: WorkerRepo, adapter: MailboxAdapter) =>
  reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo, adapter, accountId: "acct-1", mailboxId: "mb-1" } as never);

describe("reconcileFolders — filing is batched by (source → destination)", () => {
  it("groups by source and destination and never exceeds one chunk per call", async () => {
    const rec = blank();
    // The shape a real screening session has: two sources, several destinations, and a group
    // larger than one chunk.
    const pending = [
      ...rows("a", "ohmail/Screener", "INBOX", FILING_BATCH_MAX + 7),
      ...rows("b", "ohmail/Screener", "ohmail/News", 9, 500),
      ...rows("c", "INBOX", "ohmail/News", 4, 900),
    ];
    await run(repoOf(rec, pending), batchingAdapter(rec));

    // Every call is one source folder and one destination — the precondition `moveMany` throws on.
    for (const b of rec.batches) expect(b.refs.length).toBeLessThanOrEqual(FILING_BATCH_MAX);
    expect(rec.batches.map((b) => `${b.from}->${b.to}:${b.refs.length}`)).toEqual([
      `ohmail/Screener->INBOX:${FILING_BATCH_MAX}`,
      "ohmail/Screener->INBOX:7",
      "ohmail/Screener->ohmail/News:9",
      "INBOX->ohmail/News:4",
    ]);
    // …and not one message went round the per-message path.
    expect(rec.singles).toEqual([]);
    // The whole queue is filed: one locator, one folder_state and one audit row each.
    expect(rec.locators).toHaveLength(pending.length);
    expect(rec.folderStates).toHaveLength(pending.length);
    expect(rec.audits.filter((a) => a.action === "reconcile.move")).toHaveLength(pending.length);
  });

  /**
   * THE EQUIVALENCE, ASSERTED AS AN EQUALITY RATHER THAN DESCRIBED.
   *
   * The same pending queue is filed twice — once by an adapter that batches, once by an adapter
   * that refuses to — and the three write streams must match row for row. This is the test that
   * fails if the batched path ever writes a different locator, a different `folder_state`, or a
   * different audit action from the loop it replaced.
   */
  it("writes exactly what the per-message path writes", async () => {
    const pending = [
      ...rows("a", "ohmail/Screener", "INBOX", 5),
      ...rows("b", "INBOX", "ohmail/Quarantine", 3, 400),
    ];

    const batched = blank();
    await run(repoOf(batched, pending), batchingAdapter(batched));

    const perMessage = blank();
    await run(
      repoOf(perMessage, pending),
      batchingAdapter(perMessage, { answer: () => ({ outcome: "declined", moved: new Map(), gone: [] }) }),
    );

    expect(batched.locators).toEqual(perMessage.locators);
    expect(batched.folderStates).toEqual(perMessage.folderStates);
    expect(batched.audits).toEqual(perMessage.audits);
    // …and they really did take different paths, or the equality above proves nothing.
    expect(batched.singles).toEqual([]);
    expect(perMessage.singles).toHaveLength(pending.length);
  });

  it("falls back to one-at-a-time for the WHOLE chunk when the adapter refuses, filing each once", async () => {
    const rec = blank();
    const pending = rows("a", "ohmail/Screener", "INBOX", 6);
    await run(
      repoOf(rec, pending),
      batchingAdapter(rec, { answer: () => ({ outcome: "declined", moved: new Map(), gone: [] }) }),
    );

    expect(rec.singles.map((s) => s.ref)).toEqual(pending.map((p) => p.nativeLocator!.ref));
    // EXACTLY once each: a refusal that had written half the group would show up here as six
    // singles on top of a batch that already moved some of them.
    expect(rec.locators).toHaveLength(6);
  });

  it("falls back when the adapter THROWS, so each message still earns its own verdict", async () => {
    const rec = blank();
    const pending = rows("a", "ohmail/Screener", "INBOX", 4);
    await run(repoOf(rec, pending), batchingAdapter(rec, { answer: () => new Error("connection reset") }));

    expect(rec.batches).toHaveLength(1);
    expect(rec.singles).toHaveLength(4);
    expect(rec.locators).toHaveLength(4);
  });

  /**
   * THE THIRD ANSWER, which the fallback must NOT take. `moved_unmapped` is the server saying it
   * moved the group and then not saying where each message landed — nothing was written, and the
   * mail is no longer at the source. Re-filing it one at a time spends a command per member on a
   * source that is already empty and reports landed work as gone; the row is simply left pending
   * and due, and `changesSince` adopts what the server shows.
   */
  it("a batch the server MOVED but would not map writes nothing and re-files nothing", async () => {
    const rec = blank();
    const pending = rows("u", "ohmail/Screener", "INBOX", 5);
    // `vanished` is what makes this case DISCRIMINATE. Without the third answer the chunk falls
    // into the batched body with an empty `moved` map, every member reads as the batch's
    // gone-member shape, and `voidGoneFiling` then VOIDS the filing of each one whose
    // disappearance is on record — rows marked converged for mail whose destination we never
    // learned. With it, the chunk is handled and nothing at all is written.
    await run(
      repoOf(rec, pending, { vanished: new Set(pending.map((p) => p.messageId)) }),
      batchingAdapter(rec, { answer: () => ({ outcome: "moved_unmapped", moved: new Map(), gone: [] }) }),
    );

    expect(rec.batches).toHaveLength(1);
    expect(rec.singles, "the mail has moved; asking the empty source again is the defect").toEqual([]);
    expect(rec.locators, "nothing may be recorded — the server named no destination uid").toEqual([]);
    expect(rec.folderStates, "a void here marks the row converged on a destination nobody named").toEqual([]);
    expect(rec.audits).toEqual([]);
  });

  it("POSITIVE CONTROL — the same chunk DECLINED still goes to the per-message path", async () => {
    const rec = blank();
    const pending = rows("u", "ohmail/Screener", "INBOX", 5);
    await run(
      repoOf(rec, pending),
      batchingAdapter(rec, { answer: () => ({ outcome: "declined", moved: new Map(), gone: [] }) }),
    );

    expect(rec.singles).toHaveLength(5);
    expect(rec.locators).toHaveLength(5);
  });

  /**
   * A member the source no longer holds keeps its row PENDING and writes nothing — the batch's
   * form of the `MessageGoneError` skip. Writing a locator for it would point the row at a UID the
   * server never confirmed; `changesSince` is what adopts whatever really happened.
   */
  it("leaves a gone member pending and files the rest", async () => {
    const rec = blank();
    const pending = rows("a", "ohmail/Screener", "INBOX", 3);
    const missing = pending[1]!.nativeLocator!;
    await run(repoOf(rec, pending), batchingAdapter(rec, {
      answer: (locators, to) => {
        const moved = new Map<string, NativeLocator>();
        for (const l of locators) if (l.ref !== missing.ref) moved.set(l.ref, LOC(to, `9:${l.ref.split(":")[1]}`));
        return { outcome: "batched", moved, gone: [missing] };
      },
    }));

    expect(rec.locators.map((l) => l.messageId)).toEqual(["a-0", "a-2"]);
    expect(rec.folderStates.map((f) => f.messageId)).toEqual(["a-0", "a-2"]);
    expect(rec.audits.map((a) => a.messageId)).toEqual(["a-0", "a-2"]);
  });

  it("writes the same audit rows when the repo has no batched insert", async () => {
    const pending = rows("a", "ohmail/Screener", "INBOX", 4);
    const withMany = blank();
    await run(repoOf(withMany, pending), batchingAdapter(withMany));
    const without = blank();
    await run(repoOf(without, pending, { auditMany: false }), batchingAdapter(without));
    expect(without.audits).toEqual(withMany.audits);
  });

  /** An adapter with no `moveMany` at all — an alternative backend, or any existing test fake. */
  it("files normally against an adapter that cannot batch", async () => {
    const rec = blank();
    const pending = rows("a", "ohmail/Screener", "INBOX", 3);
    const noBatch = {
      move: async (locator: NativeLocator, to: string) => {
        rec.singles.push({ ref: locator.ref, to });
        return LOC(to, `9:${locator.ref.split(":")[1]}`);
      },
      setFlags: async () => {},
    } as unknown as MailboxAdapter;

    await run(repoOf(rec, pending), noBatch);
    expect(rec.singles).toHaveLength(3);
    expect(rec.locators).toHaveLength(3);
  });

  /**
   * A row whose locator ALREADY names its destination reaches neither the batch nor `move`: a move
   * there finds the letter itself at the destination and expunges the only copy. It is completed
   * where it is, with one audit row.
   */
  it("never hands a same-folder row to the batch or to move", async () => {
    const rec = blank();
    const pending: PendingFolderState[] = [{
      messageId: "already-there", desiredFolder: "ohmail/News", observedFolder: "INBOX",
      lastSetBy: "us", nativeLocator: LOC("ohmail/News", "1:5"),
    }];
    await run(repoOf(rec, pending), batchingAdapter(rec));
    expect(rec.batches).toEqual([]);
    expect(rec.singles, "a same-folder row was sent to the server").toEqual([]);
    expect(rec.folderStates).toEqual([{ messageId: "already-there", desired: "ohmail/News", observed: "ohmail/News" }]);
    expect(rec.audits).toEqual([{ action: "reconcile.move.same_folder", messageId: "already-there" }]);
  });
});

describe("reconcileFolders — the per-cycle filing budget", () => {
  it("asks the repo for one row more than the budget, so 'there is more' is a fact", async () => {
    const rec = blank();
    await run(repoOf(rec, rows("a", "ohmail/Screener", "INBOX", 10)), batchingAdapter(rec));
    expect(rec.askedLimit).toBe(RECONCILE_MOVES_PER_CYCLE + 1);
  });

  it("files the budget and reports that it owes more, so the caller re-kicks", async () => {
    const rec = blank();
    const pending = rows("a", "ohmail/Screener", "INBOX", RECONCILE_MOVES_PER_CYCLE + 120);
    const { owesMore } = await run(repoOf(rec, pending), batchingAdapter(rec));

    expect(owesMore, "a queue past the budget must announce itself or the mailbox stalls").toBe(true);
    // EXACTLY the budget, not the budget plus the probe row.
    expect(rec.locators).toHaveLength(RECONCILE_MOVES_PER_CYCLE);
    expect(rec.locators.at(-1)!.messageId).toBe(`a-${RECONCILE_MOVES_PER_CYCLE - 1}`);
  });

  it("does not claim to owe more when the queue fits exactly", async () => {
    const rec = blank();
    const pending = rows("a", "ohmail/Screener", "INBOX", RECONCILE_MOVES_PER_CYCLE);
    const { owesMore } = await run(repoOf(rec, pending), batchingAdapter(rec));
    expect(owesMore).toBe(false);
    expect(rec.locators).toHaveLength(RECONCILE_MOVES_PER_CYCLE);
  });

  /**
   * THE COUNTER IS HONEST BECAUSE THE WORK IS.
   *
   * `MailboxDTO.pendingMoves` counts the rows this pass did not settle, so "Filing N messages on
   * your mail server" decrements only as filings actually land. A budgeted pass must therefore
   * leave exactly the unfiled remainder behind — no more (which would make the strip claim work
   * that is done) and no fewer (which would make it claim work that is not).
   */
  it("leaves exactly the unfiled remainder pending", async () => {
    const rec = blank();
    const total = RECONCILE_MOVES_PER_CYCLE + 37;
    const pending = rows("a", "ohmail/Screener", "INBOX", total);
    await run(repoOf(rec, pending), batchingAdapter(rec));

    const settled = new Set(rec.folderStates.map((f) => f.messageId));
    const stillPending = pending.filter((p) => !settled.has(p.messageId));
    expect(stillPending).toHaveLength(37);
  });
});

/**
 * ── A FILING WHOSE MESSAGE IS GONE FROM THE SERVER IS VOIDED, NOT RETRIED FOR EVER ──────────
 *
 * "Gone from the source" has two readings and the reconciler must not conflate them. MID-MOVE
 * (a prior run's IMAP move that crashed before the DB write, an external move whose create is a
 * batch behind) the row must stay pending — `changesSince` adopts the completed move. EXPUNGED
 * OUTRIGHT there is no adoption event coming, ever, and "leave it pending" is a permanent wedge:
 * measured in production, one message screened into `ohmail/Screener`, deleted from the server
 * by its author, then filed back to INBOX by the user held `MailboxDTO.pendingMoves` at 1 for
 * ten hours — "Filing 1 message on your mail server…" across sign-outs and a full mirror wipe —
 * with no `reconcile.move.failed` row, because the skip writes nothing at all.
 *
 * `primaryInstanceVanished` is what tells the readings apart: true only once the server's
 * DELETE has been durably observed (`forgetInstanceAt`, epoch-guarded) and nothing has been
 * adopted since. It is the same predicate ingest already treats as adoption evidence.
 */
describe("reconcileFolders — a gone message with its disappearance on record is voided", () => {
  /** An adapter whose batch reports `missing` gone and moves the rest; Trash answers `trash` when asked. */
  const goneFromBatch = (
    rec: Recorded, missing: NativeLocator,
    trash: UidsHeldAnswer = { k: "held", uidValidity: "1", present: new Set() },
  ) => ({
    ...batchingAdapter(rec, {
      answer: (locators, to) => {
        const moved = new Map<string, NativeLocator>();
        for (const l of locators) {
          if (l.ref !== missing.ref) moved.set(l.ref, LOC(to, `9:${l.ref.split(":")[1]}`));
        }
        return { outcome: "batched", moved, gone: [missing] };
      },
    }),
    uidsHeld: async () => trash,
  }) as MailboxAdapter;

  /**
   * A RESTORE OUT OF TRASH WHOSE COPY THE SERVER PURGED never completes (`observed := desired` would
   * record the message back in INBOX while the server holds nothing anywhere), and it does not go
   * back to Trash either: the batch and a whole read of Trash found the copy absent under its epoch,
   * so the letter leaves Trash.
   */
  it("a purged RESTORE drops the letter from Trash: no adopt, no completion, no locator", async () => {
    const rec = blank();
    const pending = rows("r", "Trash", "INBOX", 1);
    await run(
      repoOf(rec, pending, { vanished: new Set(["r-0"]), trashFolder: "Trash" }),
      goneFromBatch(rec, pending[0]!.nativeLocator!),
    );

    expect(rec.dropped).toEqual([{ messageId: "r-0", locator: LOC("Trash", "1:1"), expectDesired: "INBOX" }]);
    expect(rec.adopted, "a gone copy was put back into Trash").toEqual([]);
    expect(
      rec.folderStates,
      "a completion here would write observed := INBOX about mail no server holds",
    ).toEqual([]);
    expect(rec.locators, "nothing landed, so nothing is repointed").toEqual([]);
    expect(rec.audits.map((a) => a.action)).toEqual(["reconcile.move.voided"]);
  });

  it("CONTROL — a stale UIDVALIDITY proves nothing: the restore goes back to Trash", async () => {
    const rec = blank();
    const pending = rows("r", "Trash", "INBOX", 1);
    const adapter = {
      move: async () => { throw new MessageGoneError(pending[0]!.nativeLocator!, false, "8"); },
      setFlags: async () => {},
    } as unknown as MailboxAdapter;
    await run(repoOf(rec, pending, { vanished: new Set(["r-0"]), trashFolder: "Trash" }), adapter);

    expect(rec.dropped, "a renumbered folder was read as the copy gone").toEqual([]);
    expect(rec.adopted).toEqual([{ messageId: "r-0", desired: "Trash", observed: "Trash", expectDesiredFolder: "INBOX" }]);
    expect(rec.audits.map((a) => a.action)).toEqual(["reconcile.move.voided"]);
  });

  it("CONTROL — the move's reading alone proves nothing: unless Trash answers whole without the copy, it goes back", async () => {
    const answers: UidsHeldAnswer[] = [
      { k: "unanswered" }, { k: "renumbered", uidValidity: "2" },
      { k: "held", uidValidity: "1", present: new Set([1]) },
    ];
    for (const trash of answers) {
      const rec = blank();
      const pending = rows("r", "Trash", "INBOX", 1);
      await run(
        repoOf(rec, pending, { vanished: new Set(["r-0"]), trashFolder: "Trash" }),
        goneFromBatch(rec, pending[0]!.nativeLocator!, trash),
      );
      expect(rec.dropped, `Trash answered ${trash.k} and the letter left Trash`).toEqual([]);
      expect(rec.adopted).toEqual([{ messageId: "r-0", desired: "Trash", observed: "Trash", expectDesiredFolder: "INBOX" }]);
    }
  });

  it("a RESTORE parked at a copy outside Trash goes back to Trash when that copy is gone: nothing is dropped", async () => {
    const rec = blank();
    const pending = [{ ...rows("r", "Trash", "INBOX", 1)[0]!, nativeLocator: LOC("ohmail/News", "1:5") }];
    await run(
      repoOf(rec, pending, { vanished: new Set(["r-0"]), trashFolder: "Trash" }),
      goneFromBatch(rec, pending[0]!.nativeLocator!),
    );

    expect(rec.dropped, "the letter is in Trash under another UID").toEqual([]);
    expect(rec.adopted).toEqual([{ messageId: "r-0", desired: "Trash", observed: "Trash", expectDesiredFolder: "INBOX" }]);
    expect(rec.audits.map((a) => a.action)).toEqual(["reconcile.move.voided"]);
  });

  it("POSITIVE CONTROL — a purged DELETE into Trash still completes, exactly as before", async () => {
    const rec = blank();
    const pending = rows("d", "INBOX", "Trash", 1);
    await run(
      repoOf(rec, pending, { vanished: new Set(["d-0"]), trashFolder: "Trash" }),
      goneFromBatch(rec, pending[0]!.nativeLocator!),
    );

    expect(rec.adopted, "a delete's void is the completion, not an adopt").toEqual([]);
    expect(rec.dropped).toEqual([]);
    expect(rec.folderStates).toEqual([{ messageId: "d-0", desired: "Trash", observed: "Trash" }]);
    expect(rec.audits.map((a) => a.action)).toEqual(["reconcile.move.voided"]);
  });

  it("batch path: the void is a completion write plus an audit, and never a locator", async () => {
    const rec = blank();
    const pending = rows("a", "ohmail/Screener", "INBOX", 3);
    await run(
      repoOf(rec, pending, { vanished: new Set(["a-1"]) }),
      goneFromBatch(rec, pending[1]!.nativeLocator!),
    );

    // No locator write for the voided row: pointing it at a UID no server confirmed is exactly
    // what the gone-skip exists to prevent. The row is completed in place instead.
    expect(rec.locators.map((l) => l.messageId)).toEqual(["a-0", "a-2"]);
    expect(rec.folderStates).toContainEqual({ messageId: "a-1", desired: "INBOX", observed: "INBOX" });
    expect(rec.audits).toContainEqual({ action: "reconcile.move.voided", messageId: "a-1" });
    // …and the voided row earns no `reconcile.move` audit — it did not move.
    expect(rec.audits.filter((a) => a.action === "reconcile.move").map((a) => a.messageId))
      .toEqual(["a-0", "a-2"]);
  });

  it("batch path: a gone member that may be MID-MOVE stays pending — changesSince owns it", async () => {
    const rec = blank();
    const pending = rows("a", "ohmail/Screener", "INBOX", 3);
    await run(repoOf(rec, pending), goneFromBatch(rec, pending[1]!.nativeLocator!));

    expect(rec.folderStates.map((f) => f.messageId)).toEqual(["a-0", "a-2"]);
    expect(rec.audits.some((a) => a.action === "reconcile.move.voided")).toBe(false);
  });

  it("per-message path: MessageGoneError with the disappearance on record is voided the same way", async () => {
    const rec = blank();
    const pending = rows("a", "ohmail/Screener", "INBOX", 1);
    const adapter = {
      move: async () => { throw new MessageGoneError(pending[0]!.nativeLocator!); },
      setFlags: async () => {},
    } as unknown as MailboxAdapter;
    await run(repoOf(rec, pending, { vanished: new Set(["a-0"]) }), adapter);

    expect(rec.locators).toEqual([]);
    expect(rec.folderStates).toEqual([{ messageId: "a-0", desired: "INBOX", observed: "INBOX" }]);
    expect(rec.audits).toContainEqual({ action: "reconcile.move.voided", messageId: "a-0" });
  });

  it("per-message path: without the record, the gone skip stays a silent leave-pending", async () => {
    const rec = blank();
    const pending = rows("a", "ohmail/Screener", "INBOX", 1);
    const adapter = {
      move: async () => { throw new MessageGoneError(pending[0]!.nativeLocator!); },
      setFlags: async () => {},
    } as unknown as MailboxAdapter;
    await run(repoOf(rec, pending), adapter);

    expect(rec.folderStates).toEqual([]);
    expect(rec.audits).toEqual([]);
  });

  it("a pending \\Seen on a vanished message is voided too — the flag twin of the same wedge", async () => {
    const rec = blank();
    const flag: PendingFlagState = {
      messageId: "f-0", desiredSeen: true, observedSeen: false,
      lastSetBy: "us", nativeLocator: LOC("INBOX", "1:9"),
    };
    const adapter = {
      move: async () => { throw new Error("unreachable: no pending folder rows"); },
      setFlags: async () => { throw new MessageGoneError(flag.nativeLocator!); },
    } as unknown as MailboxAdapter;

    await run(repoOf(blank(), [], { pendingFlags: [flag] }), adapter);
    // Without the record: untouched (the retry-on-refresh race is real for a live message).

    await run(repoOf(rec, [], { pendingFlags: [flag], vanished: new Set(["f-0"]) }), adapter);
    expect(rec.flagStates).toEqual([{ messageId: "f-0", desired: true, observed: true }]);
    expect(rec.audits).toContainEqual({ action: "reconcile.flags.voided", messageId: "f-0" });
  });
});

/**
 * THE MOVE'S OWN READING CLOSES A FILING WHOSE ONLY COPY IS GONE. Ingest can miss a delete (the
 * 0.25.2 Sent scan did), and the row then stayed due for ever with no attempt. An absence the
 * server stated for the locator's epoch, on the message's only recorded copy, is voided at once;
 * a second copy on record, or a stale epoch, still waits for ingest.
 */
describe("reconcileFolders — a gone message whose only copy the move found absent is voided", () => {
  const goneFromBatch = (rec: Recorded, missing: NativeLocator) =>
    batchingAdapter(rec, { answer: () => ({ outcome: "batched", moved: new Map(), gone: [missing] }) });

  it("batch path: the only copy absent ⇒ the completion write and the void, no refusal", async () => {
    const rec = blank();
    const pending = rows("g", "Sent", "Trash", 1);
    await run(repoOf(rec, pending, { onlyInstance: new Set(["g-0"]) }), goneFromBatch(rec, pending[0]!.nativeLocator!));

    expect(rec.folderStates).toEqual([{ messageId: "g-0", desired: "Trash", observed: "Trash" }]);
    expect(rec.audits).toEqual([{ action: "reconcile.move.voided", messageId: "g-0" }]);
    expect(rec.locators, "a void points the row at no UID").toEqual([]);
  });

  it("CONTROL — batch path: another copy on record keeps the row for ingest", async () => {
    const rec = blank();
    const pending = rows("g", "Sent", "Trash", 1);
    await run(repoOf(rec, pending, { onlyInstance: new Set() }), goneFromBatch(rec, pending[0]!.nativeLocator!));

    expect(rec.folderStates).toEqual([]);
    expect(rec.audits).toEqual([]);
  });

  it("per-message path: an absence at the locator's epoch voids the only copy's filing", async () => {
    const rec = blank();
    const pending = rows("g", "INBOX", "ohmail/News", 1);
    const adapter = {
      move: async () => { throw new MessageGoneError(pending[0]!.nativeLocator!, true); },
      setFlags: async () => {},
    } as unknown as MailboxAdapter;
    await run(repoOf(rec, pending, { onlyInstance: new Set(["g-0"]) }), adapter);

    expect(rec.folderStates).toEqual([{ messageId: "g-0", desired: "ohmail/News", observed: "ohmail/News" }]);
    expect(rec.audits).toEqual([{ action: "reconcile.move.voided", messageId: "g-0" }]);
  });

  it("CONTROL — per-message path: a stale epoch is no absence; the message may be there renumbered", async () => {
    const rec = blank();
    const pending = rows("g", "INBOX", "ohmail/News", 1);
    const adapter = {
      move: async () => { throw new MessageGoneError(pending[0]!.nativeLocator!); },
      setFlags: async () => {},
    } as unknown as MailboxAdapter;
    await run(repoOf(rec, pending, { onlyInstance: new Set(["g-0"]) }), adapter);

    expect(rec.folderStates).toEqual([]);
    expect(rec.audits).toEqual([]);
  });
});

/**
 * A DELETE'S MOVE THAT LANDED WITH ITS ANSWER LOST: the next pass finds the source gone. Before the
 * delete of a gone letter empties it, the letter is looked for in Trash by its own bytes: found, it
 * is parked there as the landed move it was; absent, the gone delete closes as before; undecided, it
 * stays in Trash with its text; unanswered, nothing is written.
 */
describe("reconcileFolders — a delete whose source is gone looks for its letter in Trash first", () => {
  const deletes = (n = 1) => rows("d", "INBOX", "Trash", n).map((p) => ({ ...p, trashedFrom: "INBOX", serverMissing: false }));
  type Answer = Awaited<ReturnType<NonNullable<MailboxAdapter["findLetters"]>>>;
  const read = (v: Record<string, { k: "absent" | "undecided" } | { k: "found"; locator: NativeLocator }>): Answer =>
    ({ k: "read", uidValidity: "5", verdicts: new Map(Object.entries(v)) });
  const ANSWERS: Record<string, Answer> = {
    found: read({ "d-0": { k: "found", locator: LOC("Trash", "5:77") } }),
    absent: read({ "d-0": { k: "absent" } }),
    undecided: read({ "d-0": { k: "undecided" } }),
    unanswered: { k: "unanswered" },
  };
  /** The batch reports every member gone, or the single move throws the absence. */
  const adapters = (rec: Recorded, answer: Answer, asked: string[][]) => {
    const findLetters = async (_f: string, asks: ReadonlyArray<{ key: string }>) => { asked.push(asks.map((a) => a.key)); return answer; };
    return {
      batch: { ...batchingAdapter(rec, { answer: (ls) => ({ outcome: "batched", moved: new Map(), gone: [...ls] }) }), findLetters } as MailboxAdapter,
      single: {
        move: async (l: NativeLocator) => { throw new MessageGoneError(l, true); }, setFlags: async () => {}, findLetters,
      } as unknown as MailboxAdapter,
    };
  };
  const opts = { vanished: new Set(["d-0"]), trashFolder: "Trash" };

  for (const path of ["batch", "single"] as const) {
    it(`${path}: found in Trash, the letter is parked there with its text and an audit that says so`, async () => {
      const rec = blank();
      const asked: string[][] = [];
      await run(repoOf(rec, deletes(), opts), adapters(rec, ANSWERS.found!, asked)[path]);
      expect(asked).toEqual([["d-0"]]);
      expect(rec.locators).toEqual([{ messageId: "d-0", locator: LOC("Trash", "5:77") }]);
      expect(rec.folderStates).toEqual([{ messageId: "d-0", desired: "Trash", observed: "Trash" }]);
      expect(rec.refound).toEqual(["d-0"]);
      expect(rec.husked, "a letter found in Trash was emptied").toEqual([]);
      expect(rec.adopted).toEqual([]);
    });

    it(`${path}: absent from Trash, the delete of a gone letter closes as before`, async () => {
      const rec = blank();
      await run(repoOf(rec, deletes(), opts), adapters(rec, ANSWERS.absent!, [])[path]);
      expect(rec.adopted).toEqual([{ messageId: "d-0", desired: "INBOX", observed: "INBOX", expectDesiredFolder: "Trash" }]);
      expect(rec.husked).toEqual(["d-0"]);
      expect(rec.locators).toEqual([]);
    });

    it(`${path}: undecided, the letter stays in Trash with its text`, async () => {
      const rec = blank();
      await run(repoOf(rec, deletes(), opts), adapters(rec, ANSWERS.undecided!, [])[path]);
      expect(rec.husked, "an unproven letter was emptied").toEqual([]);
      expect(rec.adopted).toEqual([]);
      expect(rec.folderStates).toEqual([{ messageId: "d-0", desired: "Trash", observed: "Trash" }]);
      expect(rec.locators, "an unproven copy was bound").toEqual([]);
      expect(rec.audits.map((a) => a.action)).toEqual(["reconcile.move.voided"]);
    });

    it(`${path}: unanswered, nothing is written and the row stays due`, async () => {
      const rec = blank();
      await run(repoOf(rec, deletes(), opts), adapters(rec, ANSWERS.unanswered!, [])[path]);
      expect([rec.locators, rec.folderStates, rec.adopted, rec.husked, rec.audits]).toEqual([[], [], [], [], []]);
    });

    // A move whose FETCH was throttled reads its letter as gone; only a SEARCH of the folder decides.
    const HELD: Record<string, [UidsHeldAnswer, "kept" | "closed"]> = {
      present: [{ k: "held", uidValidity: "1", present: new Set([1]) }, "kept"],
      unanswered: [{ k: "unanswered" }, "kept"],
      renumbered: [{ k: "renumbered", uidValidity: "2" }, "kept"],
      missing: [{ k: "held", uidValidity: "1", present: new Set() }, "closed"],
      "a folder gone": [{ k: "absent" }, "closed"],
    };
    for (const [read, [held, outcome]] of Object.entries(HELD)) {
      it(`${path}: absent from Trash and ${read} in its folder, the delete is ${outcome}`, async () => {
        const rec = blank();
        const asked: number[][] = [];
        const adapter = { ...adapters(rec, ANSWERS.absent!, [])[path], uidsHeld: async (_f: string, _v: string, uids: readonly number[]) => {
          asked.push([...uids]); return held;
        } } as MailboxAdapter;
        await run(repoOf(rec, deletes(), opts), adapter);
        expect(rec.husked, "a letter its folder may still hold was emptied").toEqual(outcome === "kept" ? [] : ["d-0"]);
        if (outcome === "kept") expect([rec.locators, rec.folderStates, rec.adopted, rec.audits]).toEqual([[], [], [], []]);
        expect(asked).toEqual([[1]]);
      });
    }

    it(`${path}: undecided and still in its folder, nothing is written; the retried move lands in Trash`, async () => {
      const rec = blank();
      let throttled = true;
      const twice = path === "batch"
        ? batchingAdapter(rec, { answer: (ls) => (throttled ? ((throttled = false), { outcome: "batched", moved: new Map(), gone: [...ls] }) : undefined) as never })
        : { move: async (l: NativeLocator, to: string) => {
          if (throttled) { throttled = false; throw new MessageGoneError(l, true); }
          return LOC(to, `9:${l.ref.split(":")[1]}`);
        }, setFlags: async () => {} } as unknown as MailboxAdapter;
      const adapter = {
        ...twice, findLetters: async () => ANSWERS.undecided!,
        uidsHeld: async (_f: string, uidValidity: string, uids: readonly number[]) => ({ k: "held", uidValidity, present: new Set(uids) }),
      } as MailboxAdapter;
      const repo = repoOf(rec, deletes(), opts);
      await run(repo, adapter);
      expect([rec.locators, rec.folderStates, rec.adopted, rec.husked, rec.audits]).toEqual([[], [], [], [], []]);
      await run(repo, adapter);
      expect(rec.locators).toEqual([{ messageId: "d-0", locator: LOC("Trash", "9:1") }]);
      expect(rec.folderStates).toEqual([{ messageId: "d-0", desired: "Trash", observed: "Trash" }]);
      expect(rec.husked).toEqual([]);
    });
  }

  it("moved_unmapped into Trash: what is found is parked at once, the rest stays due", async () => {
    const rec = blank();
    const asked: string[][] = [];
    const answer = read({
      "d-0": { k: "found", locator: LOC("Trash", "5:70") }, "d-1": { k: "found", locator: LOC("Trash", "5:71") }, "d-2": { k: "undecided" },
    });
    const adapter = {
      ...batchingAdapter(rec, { answer: () => ({ outcome: "moved_unmapped", moved: new Map(), gone: [] }) }),
      findLetters: async (_f: string, asks: ReadonlyArray<{ key: string }>) => { asked.push(asks.map((a) => a.key)); return answer; },
    } as MailboxAdapter;
    await run(repoOf(rec, deletes(3), { trashFolder: "Trash" }), adapter);
    expect(asked).toEqual([["d-0", "d-1", "d-2"]]);
    expect(rec.locators.map((l) => [l.messageId, l.locator.ref])).toEqual([["d-0", "5:70"], ["d-1", "5:71"]]);
    expect(rec.refound).toEqual(["d-0", "d-1"]);
    expect(rec.folderStates.map((f) => f.messageId), "an undecided member was written").toEqual(["d-0", "d-1"]);
    expect(rec.singles).toEqual([]);
  });

  it("a Restore of a letter left in Trash at its gone origin copy goes back to Trash, never settled in place", async () => {
    const rec = blank();
    // The undecided delete's completion: Trash/Trash with the origin's gone locator; then Restore.
    const pending = [{ ...rows("r", "Trash", "INBOX", 1)[0]!, nativeLocator: LOC("INBOX", "1:1") }];
    await run(repoOf(rec, pending, { vanished: new Set(["r-0"]), trashFolder: "Trash" }), batchingAdapter(rec));
    expect(rec.folderStates, "the letter was settled in INBOX, where no copy is").toEqual([]);
    expect(rec.adopted).toEqual([{ messageId: "r-0", desired: "Trash", observed: "Trash", expectDesiredFolder: "INBOX" }]);
    expect(rec.audits.map((a) => a.action)).toEqual(["reconcile.move.voided"]);
    expect([rec.batches, rec.singles]).toEqual([[], []]);
  });

  it("CONTROL — moved_unmapped into INBOX never asks Trash", async () => {
    const rec = blank();
    let asked = 0;
    const adapter = {
      ...batchingAdapter(rec, { answer: () => ({ outcome: "moved_unmapped", moved: new Map(), gone: [] }) }),
      findLetters: async () => { asked++; return { k: "unanswered" as const }; },
    } as MailboxAdapter;
    await run(repoOf(rec, rows("u", "ohmail/Screener", "INBOX", 5), { trashFolder: "Trash" }), adapter);
    expect(asked).toBe(0);
    expect(rec.folderStates).toEqual([]);
  });
});
