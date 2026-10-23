import { describe, it, expect } from "vitest";
import type { NativeLocator } from "@trafficflow/core";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { reconcileMailbox } from "../src/sync.js";
import { physicalDestination, junkAuditCode, SPAM_PILE, NO_SPECIAL_FOLDERS } from "../src/junk-filing.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * ═══ THE SPAM VERDICT'S NATIVE-\Junk FILING, AND THE CLAIM THAT MUST FOLLOW THE MOVE ═════════
 *
 * The product rule (imap-types.ts, 2026-08-22 amendment): a spam verdict files the message to
 * the provider's own \Junk when the mailbox has one; the mirror's copy is husked (`junk_filed`);
 * the pile stays `ohmail/Quarantine` and the folder_state records the physical truth as
 * FULFILMENT (`satisfiedBy`). A mailbox with no \Junk keeps the prior behaviour byte-for-byte.
 *
 * ── THE GUARD THAT MATTERS MOST ─────────────────────────────────────────────────────────────
 *
 * A verdict that CLAIMS Junk-filed while the IMAP move failed is the mirror lying about the
 * mailbox — the husk says "your bytes live in Junk" about bytes that are still in the Imbox, and
 * nothing downstream can tell. So the ordering is load-bearing: every write that asserts the
 * filing (husk, satisfied folder_state, parked instance) happens only in the completion group,
 * which only runs after `adapter.move`/`moveMany` returned. The failure test below is the
 * red-provable form: make the adapter refuse and assert NOTHING was claimed.
 *
 * ── MUTATIONS WATCHED (each restored) ───────────────────────────────────────────────────────
 *
 *  · call `completeFiling` in `fileOne` BEFORE `adapter.move` (the claim-first shape)
 *      ⇒ "a refused move claims nothing" red: huskBody and upsertFolderState recorded despite
 *        the refusal. Run 2026-08-22: 2 tests red (`junk claims nothing`, `no-junk fallback`),
 *        restored, suite green.
 *  · drop `satisfiedBy` from `completeFiling`'s parked write ⇒ the fulfilment test red (the
 *        folder_state write no longer names the junk path as satisfaction). Run 2026-08-22:
 *        1 test red, restored.
 *  · make `physicalDestination` map the pile even when `junkFolder` is null ⇒ the byte-identical
 *        fallback test red (the adapter is asked to move to `null`). Run 2026-08-22: 3 tests
 *        red, restored.
 *  · call `unDeleteOnLandedMove` regardless of what `settle` returned (the pre-fix shape)
 *      ⇒ "a SUPERSEDED non-Trash completion clears NOTHING" red on both assertions, with the
 *        claiming case still green. Run 2026-09-10, restored.
 */

const LOC = (folder: string, ref: string): NativeLocator => ({ folder, ref });
const JUNK = "[Gmail]/Spam";
const TRASH = "Trash";

interface Recorded {
  moves: Array<{ from: string; to: string }>;
  locators: Array<{ messageId: string; folder: string }>;
  folderStates: Array<{ messageId: string; s: Record<string, unknown> }>;
  husks: Array<{ messageId: string; reason: string }>;
  forgotten: Array<{ folder: string; ref: string }>;
  audits: Array<{ action: string; payload: Record<string, unknown> }>;
  /** Every `clearDeletedOnAdopt` — the tombstone clear a landed non-Trash move performs. */
  undeleted: string[];
  /** The `change_log` rows the completion group wrote, so a clear without its delta shows. */
  changes: Array<{ entityId: string; op: string }>;
}

const fresh = (): Recorded => ({
  moves: [], locators: [], folderStates: [], husks: [], forgotten: [], audits: [],
  undeleted: [], changes: [],
});

function repoOf(rec: Recorded, opts: {
  pending: Array<{ messageId: string; desiredFolder: string; observedFolder: string; ref: string }>;
  special?: { junkFolder: string | null; trashFolder: string | null } | null;
  withOptionalMethods?: boolean;
  aiAuthored?: string[];
  /** What the park's `forgetInstanceAt` promotes — the surviving watched copy, when one exists. */
  promote?: NativeLocator | null;
  /**
   * A COMPETING WRITER COMMITTED A NEW DESIRE DURING THE IMAP MOVE — `completeFolderState`
   * answers false, exactly as the real conditional write does when its witness misses.
   */
  casLost?: boolean;
  /** Is there a tombstone to clear? The real method is conditional on `deleted_at IS NOT NULL`. */
  tombstoned?: boolean;
}): WorkerRepo {
  const stub: Record<string, unknown> = {
    listPendingFolderStates: async () => opts.pending.map((p) => ({
      messageId: p.messageId, desiredFolder: p.desiredFolder, observedFolder: p.observedFolder,
      lastSetBy: "us" as const, nativeLocator: LOC(p.observedFolder, p.ref),
    })),
    listPendingFlagStates: async () => [],
    updateLocator: async (messageId: string, loc: NativeLocator) => {
      rec.locators.push({ messageId, folder: loc.folder });
    },
    // The completion path writes through `completeFolderState` and NOT `upsertFolderState` — the
    // conditional write that cannot clobber a desire committed during the move. Recorded
    // VERBATIM (witness key and all) rather than mapped back to the old shape, so the assertions
    // below say which value is the compare-and-set witness and which values are payload; a
    // revert to the unconditional upsert makes every one of them red on a missing record.
    completeFolderState: async (messageId: string, c: Record<string, unknown>) => {
      rec.folderStates.push({ messageId, s: c });
      return opts.casLost !== true;
    },
    /* THE TOMBSTONE CLEAR, with the real method's own condition: it matches only a row that
       carries `deleted_at`, and answers false otherwise. Recorded rather than stubbed to true so
       a clear this pass had no right to make is visible as a call. */
    clearDeletedOnAdopt: async (messageId: string) => {
      if (opts.tombstoned !== true) return false;
      rec.undeleted.push(messageId);
      return true;
    },
    recordChange: async (c: { entityId: string; op: string }) => {
      rec.changes.push({ entityId: c.entityId, op: c.op });
      return 1n;
    },
    recordChanges: async (cs: ReadonlyArray<{ entityId: string; op: string }>) => {
      for (const c of cs) rec.changes.push({ entityId: c.entityId, op: c.op });
      return cs.map(() => 1n);
    },
    upsertFolderState: async (messageId: string, s: Record<string, unknown>) => {
      rec.folderStates.push({ messageId, s: { unconditional: true, ...s } });
    },
    forgetInstanceAt: async (_mailboxId: string, loc: NativeLocator) => {
      rec.forgotten.push({ folder: loc.folder, ref: loc.ref });
      return opts.promote ?? null;
    },
    primaryInstanceVanished: async () => false,
    recordAudit: async (_a: string, action: string, payload: Record<string, unknown>) => {
      rec.audits.push({ action, payload });
    },
    deferFolderReconcile: async () => {},
    deferFlagReconcile: async () => {},
    transaction: async <T,>(fn: (r: WorkerRepo) => Promise<T>): Promise<T> => fn(stub as unknown as WorkerRepo),
    // The removal fence reads this inside every write transaction; the double answers what a live
    // mailbox answers (see `assertMailboxStillHere`), because absent it the fence is a TypeError.
    mailboxStatusForWrite: async (): Promise<string> => "connected",
  };
  if (opts.withOptionalMethods !== false) {
    if (opts.special !== null) {
      stub.getMailboxSpecialFolders = async () => opts.special ?? NO_SPECIAL_FOLDERS;
    }
    stub.huskBody = async (_accountId: string, messageId: string, reason: string) => {
      rec.husks.push({ messageId, reason });
      return true;
    };
    stub.listAiAutoAppliedQuarantine = async (_accountId: string, _ids: readonly string[]) => opts.aiAuthored ?? [];
  }
  return stub as unknown as WorkerRepo;
}

/** A per-message adapter (no moveMany ⇒ the fileOne path) that lands or refuses every move. */
function adapterOf(
  rec: Recorded,
  opts: { refuse?: boolean; sentFolder?: string; watchedSentFolder?: string } = {},
): MailboxAdapter {
  return {
    move: async (loc: NativeLocator, toFolder: string) => {
      if (opts.refuse) throw new Error("NO [CANNOT] move refused by server");
      rec.moves.push({ from: loc.folder, to: toFolder });
      return { folder: toFolder, ref: "9:900" };
    },
    setFlags: async () => {},
    ...(opts.sentFolder !== undefined || opts.watchedSentFolder !== undefined
      ? {
          capabilities: async () => ({
            sentFolder: opts.sentFolder ?? null,
            ...(opts.watchedSentFolder !== undefined
              ? { watchedSentFolder: opts.watchedSentFolder }
              : {}),
          }),
        }
      : {}),
  } as unknown as MailboxAdapter;
}

function deps(rec: Recorded, repoOpts: Parameters<typeof repoOf>[1], adapterOpts: Parameters<typeof adapterOf>[1] = {}) {
  return { writeAuthority: FIXTURE_LEASE,
    repo: repoOf(rec, repoOpts), adapter: adapterOf(rec, adapterOpts),
    accountId: "acct-1", mailboxId: "mb-1", trustedAuthservIds: new Set<string>(),
    ohboxPolicy: "trusted_only" as const, ohboxBar: 0.9,
  } as unknown as Parameters<typeof reconcileMailbox>[0];
}

const verdictRow = { messageId: "m1", desiredFolder: SPAM_PILE, observedFolder: "INBOX", ref: "1:10" };

describe("junk-filing — the spam verdict files to native \\Junk", () => {
  it("moves to the provider's junk folder, parks the instance, husks, and records fulfilment", async () => {
    const rec = fresh();
    await reconcileMailbox(deps(rec, {
      pending: [verdictRow], special: { junkFolder: JUNK, trashFolder: TRASH },
    }));
    // The IMAP command named the PHYSICAL folder, not the pile.
    expect(rec.moves).toEqual([{ from: "INBOX", to: JUNK }]);
    // The instance parked — removed at the junk locator, so a user restore later has evidence.
    expect(rec.forgotten).toEqual([{ folder: JUNK, ref: "9:900" }]);
    // The folder_state records both facts: the pile, the server's truth, and the fulfilment.
    expect(rec.folderStates).toEqual([{
      messageId: "m1",
      s: { expectDesiredFolder: SPAM_PILE, observedFolder: JUNK, lastSetBy: "us", satisfiedBy: JUNK, physicalObservation: true },
    }]);
    // The mirror's copy is a husk; the bytes live on in Junk, which is the master.
    expect(rec.husks).toEqual([{ messageId: "m1", reason: "junk_filed" }]);
    // The audit says where the mail went and that the verdict was junk-filed.
    const move = rec.audits.find((a) => a.action === "reconcile.move");
    expect(move?.payload.to).toBe(JUNK);
    expect(move?.payload.junk).toBe("filed_to_junk");
  });

  it("a refused move claims NOTHING — no husk, no folder_state, no park", async () => {
    const rec = fresh();
    await reconcileMailbox(deps(
      rec,
      { pending: [verdictRow], special: { junkFolder: JUNK, trashFolder: TRASH } },
      { refuse: true },
    ));
    expect(rec.moves).toEqual([]);
    expect(rec.husks).toEqual([]);
    expect(rec.folderStates).toEqual([]);
    expect(rec.forgotten).toEqual([]);
    expect(rec.locators).toEqual([]);
    // The refusal is on record against the PHYSICAL destination the server actually refused.
    const failed = rec.audits.find((a) => a.action === "reconcile.move.failed");
    expect(failed?.payload.to).toBe(JUNK);
  });

  it("no junk folder ⇒ the prior behaviour byte-for-byte, under the closed code", async () => {
    const rec = fresh();
    await reconcileMailbox(deps(rec, {
      pending: [verdictRow], special: { junkFolder: null, trashFolder: null },
    }));
    expect(rec.moves).toEqual([{ from: "INBOX", to: SPAM_PILE }]);
    // The exact pre-0065 completion: converged on the pile, no satisfiedBy key, no park, no husk.
    expect(rec.folderStates).toEqual([{
      messageId: "m1",
      s: { expectDesiredFolder: SPAM_PILE, observedFolder: SPAM_PILE, lastSetBy: "us", physicalObservation: true },
    }]);
    expect(rec.husks).toEqual([]);
    expect(rec.forgotten).toEqual([]);
    const move = rec.audits.find((a) => a.action === "reconcile.move");
    expect(move?.payload.junk).toBe("no_junk_folder");
  });

  it("a repo that predates the discovery methods keeps the prior behaviour and never throws", async () => {
    const rec = fresh();
    await reconcileMailbox(deps(rec, { pending: [verdictRow], special: null, withOptionalMethods: false }));
    expect(rec.moves).toEqual([{ from: "INBOX", to: SPAM_PILE }]);
    expect(rec.folderStates).toEqual([{
      messageId: "m1",
      s: { expectDesiredFolder: SPAM_PILE, observedFolder: SPAM_PILE, lastSetBy: "us", physicalObservation: true },
    }]);
    expect(rec.husks).toEqual([]);
  });

  it("an ordinary move (not a verdict) is untouched by the mapping", async () => {
    const rec = fresh();
    await reconcileMailbox(deps(rec, {
      pending: [{ messageId: "m2", desiredFolder: "ohmail/News", observedFolder: "INBOX", ref: "1:11" }],
      special: { junkFolder: JUNK, trashFolder: TRASH },
    }));
    expect(rec.moves).toEqual([{ from: "INBOX", to: "ohmail/News" }]);
    expect(rec.folderStates).toEqual([{
      messageId: "m2",
      s: { expectDesiredFolder: "ohmail/News", observedFolder: "ohmail/News", lastSetBy: "us", physicalObservation: true },
    }]);
    expect(rec.husks).toEqual([]);
    expect(rec.forgotten).toEqual([]);
  });

  it("an AI AUTO-APPLIED placement is NOT user-commanded: it keeps the pile, under its own code", async () => {
    const rec = fresh();
    await reconcileMailbox(deps(rec, {
      pending: [verdictRow], special: { junkFolder: JUNK, trashFolder: TRASH }, aiAuthored: ["m1"],
    }));
    // The pre-0065 behaviour byte-for-byte — the provider's filter is never trained and the
    // mirror body never husked on the organizer's own initiative.
    expect(rec.moves).toEqual([{ from: "INBOX", to: SPAM_PILE }]);
    expect(rec.folderStates).toEqual([{
      messageId: "m1",
      s: { expectDesiredFolder: SPAM_PILE, observedFolder: SPAM_PILE, lastSetBy: "us", physicalObservation: true },
    }]);
    expect(rec.husks).toEqual([]);
    expect(rec.forgotten).toEqual([]);
    const move = rec.audits.find((a) => a.action === "reconcile.move");
    expect(move?.payload.junk).toBe("ai_authored");
  });

  it("a delete (desired = the trash path) parks the instance and never husks", async () => {
    const rec = fresh();
    await reconcileMailbox(deps(rec, {
      pending: [{ messageId: "m3", desiredFolder: TRASH, observedFolder: "INBOX", ref: "1:12" }],
      special: { junkFolder: JUNK, trashFolder: TRASH },
    }));
    expect(rec.moves).toEqual([{ from: "INBOX", to: TRASH }]);
    expect(rec.forgotten).toEqual([{ folder: TRASH, ref: "9:900" }]);
    // Desired and observed agree (the API wrote the trash path verbatim): no satisfiedBy needed.
    expect(rec.folderStates).toEqual([{
      messageId: "m3",
      s: { expectDesiredFolder: TRASH, observedFolder: TRASH, lastSetBy: "us", physicalObservation: true },
    }]);
    // The body is deliberately KEPT: a user restore from Trash keeps its content.
    expect(rec.husks).toEqual([]);
  });

  it("a delete whose park PROMOTES A SURVIVOR keeps the row pending at the survivor's folder", async () => {
    // The tombstoned row's surviving watched copy is a KNOWN locator: no scan will ever emit the
    // create that resurrects a tombstone, so a converged completion here is a message the server
    // still holds that no client can ever show again. The completion must instead leave the move
    // owed — observed at the survivor — so the next pass files that copy to Trash too.
    const rec = fresh();
    const { owesMore } = await reconcileMailbox(deps(rec, {
      pending: [{ messageId: "m4", desiredFolder: TRASH, observedFolder: "INBOX", ref: "1:13" }],
      special: { junkFolder: JUNK, trashFolder: TRASH },
      promote: LOC("ohmail/News", "1:41"),
    }));
    // The re-open is more due work CREATED INSIDE this pass — the pre-pass queue length cannot
    // see it, so the completion's answer must reach the scheduler or the surviving copy waits a
    // whole poll (and a drain that stops on backlog alone never reaches it).
    expect(owesMore, "a re-opened row must re-kick the scheduler").toBe(true);
    expect(rec.moves).toEqual([{ from: "INBOX", to: TRASH }]);
    expect(rec.forgotten).toEqual([{ folder: TRASH, ref: "9:900" }]);
    // Claimed at Trash first, then re-opened PENDING at the survivor's folder with no
    // satisfiedBy — `reconcileStatusFor` reads that as a move still owed.
    expect(rec.folderStates).toEqual([{
      messageId: "m4",
      s: { expectDesiredFolder: TRASH, observedFolder: TRASH, lastSetBy: "us", physicalObservation: true },
    }, {
      messageId: "m4",
      s: { expectDesiredFolder: TRASH, observedFolder: "ohmail/News", lastSetBy: "us", physicalObservation: true },
    }]);
    expect(rec.husks).toEqual([]);
  });

  it("a delete completion that lost its CAS does not park: the copy stays watched for the move back", async () => {
    // A Restore cancelled the delete while its move was in flight. Parking here would forget the
    // only watched copy of a live letter, and the reaper would take it.
    const rec = fresh();
    const { owesMore } = await reconcileMailbox(deps(rec, {
      pending: [{ messageId: "m8", desiredFolder: TRASH, observedFolder: "INBOX", ref: "1:22" }],
      special: { junkFolder: JUNK, trashFolder: TRASH },
      casLost: true,
    }));
    expect(rec.moves).toEqual([{ from: "INBOX", to: TRASH }]);
    expect(rec.forgotten, "nothing parked").toEqual([]);
    expect(rec.audits.map((a) => a.action)).toContain("reconcile.move.superseded");
    expect(owesMore, "the newer desire owes the move back").toBe(true);
  });

  it("a \\Sent survivor is NEVER re-opened onto: the completion converges, and owes nothing", async () => {
    // Sent is enumerated from a UID watermark and its deletes below it are never reported, so a
    // recorded Sent instance can be STALE — re-opening onto it would retry MessageGoneError for
    // ever (the stale row is primary now, so voidGoneFiling's predicate never fires). And the
    // product half: deleting the received copy leaves the record of what you sent.
    const rec = fresh();
    const { owesMore } = await reconcileMailbox(deps(
      rec,
      {
        pending: [{ messageId: "m5", desiredFolder: TRASH, observedFolder: "INBOX", ref: "1:14" }],
        special: { junkFolder: JUNK, trashFolder: TRASH },
        promote: LOC("Sent", "1:5"),
      },
      { sentFolder: "Sent" },
    ));
    expect(owesMore).toBe(false);
    expect(rec.moves).toEqual([{ from: "INBOX", to: TRASH }]);
    // The pre-fix converged park, byte-for-byte — no pending row against Sent's silent deletes.
    expect(rec.folderStates).toEqual([{
      messageId: "m5",
      s: { expectDesiredFolder: TRASH, observedFolder: TRASH, lastSetBy: "us", physicalObservation: true },
    }]);
    expect(rec.husks).toEqual([]);
  });

  it("the Sent exclusion reads the SCAN-resolved path — a name-fallback Sent still excludes", async () => {
    // On a server without SPECIAL-USE the watched Sent path lives only in the name fallback
    // (`watchedSentFolder`); `sentFolder` is null there. Excluding against `sentFolder` alone
    // would leave exactly those providers open to the stale-Sent-row retry wedge.
    const rec = fresh();
    const { owesMore } = await reconcileMailbox(deps(
      rec,
      {
        pending: [{ messageId: "m6", desiredFolder: TRASH, observedFolder: "INBOX", ref: "1:15" }],
        special: { junkFolder: JUNK, trashFolder: TRASH },
        promote: LOC("Sent Mail", "1:6"),
      },
      { watchedSentFolder: "Sent Mail" },
    ));
    expect(owesMore).toBe(false);
    expect(rec.folderStates).toEqual([{
      messageId: "m6",
      s: { expectDesiredFolder: TRASH, observedFolder: TRASH, lastSetBy: "us", physicalObservation: true },
    }]);
  });

  it("a SPAM park with a survivor still converges — nothing is hidden on that path", async () => {
    // The verdict's row is never tombstoned: it stays on the Quarantine pile in every client, so
    // the surviving copy hides nothing and the satisfied completion stands unchanged.
    const rec = fresh();
    await reconcileMailbox(deps(rec, {
      pending: [verdictRow], special: { junkFolder: JUNK, trashFolder: TRASH },
      promote: LOC("ohmail/News", "1:41"),
    }));
    expect(rec.moves).toEqual([{ from: "INBOX", to: JUNK }]);
    expect(rec.folderStates).toEqual([{
      messageId: "m1",
      s: { expectDesiredFolder: SPAM_PILE, observedFolder: JUNK, lastSetBy: "us", satisfiedBy: JUNK, physicalObservation: true },
    }]);
    expect(rec.husks).toEqual([{ messageId: "m1", reason: "junk_filed" }]);
  });

  /* ═══ THE TOMBSTONE IS THE WINNER'S TO DECIDE ═══════════════════════════════════════════════
   *
   * A restore writes `desired = <origin>` and leaves `deleted_at` standing; the landed move out
   * of Trash is what clears it. The pair below is the whole of the invariant: the completion that
   * WON the row clears the tombstone, and the completion that LOST it clears nothing.
   *
   * The sequence the second case stands for: Restore's IMAP move is in flight when a stale second
   * tab re-deletes the row, which writes `desired = Trash` and stamps `deleted_at` again. The
   * restore's completion then lands, misses its witness — and if it clears anyway, the newer
   * delete's tombstone is gone with nothing left to re-stamp it: the delete's own completion parks
   * and never touches `deleted_at`, so the copy sits in the server's Trash while the mirror shows
   * it in neither the live piles nor the Trash list.
   */
  it("a landed non-Trash move that CLAIMED the row clears the tombstone and emits its delta", async () => {
    const rec = fresh();
    await reconcileMailbox(deps(rec, {
      pending: [{ messageId: "m6", desiredFolder: "INBOX", observedFolder: TRASH, ref: "1:20" }],
      special: { junkFolder: JUNK, trashFolder: TRASH },
      tombstoned: true,
    }));
    expect(rec.moves).toEqual([{ from: TRASH, to: "INBOX" }]);
    expect(rec.undeleted, "the restore's own landing un-deletes").toEqual(["m6"]);
    expect(rec.changes, "and re-materializes the row in every mirror")
      .toEqual([{ entityId: "m6", op: "update" }]);
  });

  it("a SUPERSEDED non-Trash completion clears NOTHING — the newer delete's tombstone stands", async () => {
    const rec = fresh();
    await reconcileMailbox(deps(rec, {
      pending: [{ messageId: "m7", desiredFolder: "INBOX", observedFolder: TRASH, ref: "1:21" }],
      special: { junkFolder: JUNK, trashFolder: TRASH },
      tombstoned: true,
      casLost: true,
    }));
    // The move DID land and the physical fact is still recorded — that half is unchanged.
    expect(rec.moves).toEqual([{ from: TRASH, to: "INBOX" }]);
    expect(rec.folderStates).toEqual([{
      messageId: "m7",
      s: { expectDesiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us", physicalObservation: true },
    }]);
    expect(rec.audits.map((a) => a.action)).toContain("reconcile.move.superseded");
    // …and the tombstone is left exactly as the writer that won the row wrote it.
    expect(rec.undeleted, "a completion that lost its CAS may not un-delete").toEqual([]);
    expect(rec.changes, "and emits no resurrection delta").toEqual([]);
  });
});

describe("junk-filing — the pure mapping", () => {
  it("maps only the spam pile, and only when a junk folder exists", () => {
    const special = { junkFolder: JUNK, trashFolder: TRASH };
    expect(physicalDestination(SPAM_PILE, special)).toBe(JUNK);
    expect(physicalDestination(SPAM_PILE, NO_SPECIAL_FOLDERS)).toBe(SPAM_PILE);
    expect(physicalDestination("ohmail/News", special)).toBe("ohmail/News");
    expect(physicalDestination(TRASH, special)).toBe(TRASH);
  });

  it("annotates only spam-verdict audits, with the closed set of codes", () => {
    const special = { junkFolder: JUNK, trashFolder: TRASH };
    expect(junkAuditCode(SPAM_PILE, JUNK, special)).toBe("filed_to_junk");
    expect(junkAuditCode(SPAM_PILE, SPAM_PILE, NO_SPECIAL_FOLDERS)).toBe("no_junk_folder");
    expect(junkAuditCode(SPAM_PILE, SPAM_PILE, special)).toBe("ai_authored");
    expect(junkAuditCode("ohmail/News", "ohmail/News", special)).toBeNull();
    expect(junkAuditCode(TRASH, TRASH, special)).toBeNull();
  });

  it("the mapping is refused for an AI-authored placement", () => {
    const special = { junkFolder: JUNK, trashFolder: TRASH };
    expect(physicalDestination(SPAM_PILE, special, { aiAuthored: true })).toBe(SPAM_PILE);
    expect(physicalDestination(SPAM_PILE, special, { aiAuthored: false })).toBe(JUNK);
  });
});
