import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect } from "vitest";
import type { ChangeBatch, ImapCursor, MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { runSyncCycle, LeaderFencedError, type JunkSweepCommandPort } from "../src/sync.js";
import { assertMayWriteToMailbox } from "../src/lease.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * THE SWEEP COMMAND'S CONSUMPTION INSIDE THE CYCLE (FOLDERS-SPEC.md §16.1) — the seam
 * `sync.ts` owns, driven through a recording port.
 *
 * What is pinned, each watched red under a mutation before landing (2026-08-27):
 *
 *  · NO STAMP ⇒ NOTHING RUNS. `requested()` answering null runs no sweep and clears nothing —
 *    the cycle with no press is the cycle that existed before (mutation: run unconditionally ⇒
 *    red).
 *  · A STAMP ⇒ run, then clear THE OBSERVED TOKEN — the same text `requested()` answered, never
 *    a fresh `now()` (mutation: clear with a different token ⇒ red).
 *  · The run receives BOTH fences — a leadership `guard` and a `write` group — and the cycle's
 *    `changesSince` still happens afterwards (the sweep sits before the cursor is built, like the
 *    folder verbs).
 *  · A THROWING run leaves the stamp STANDING (no clear) and the mail flow continues — the
 *    ordinary failure boundary the folder-ops pass has (mutation: clear in a `finally` ⇒ red).
 *  · A FENCE REFUSAL out of the run propagates — proof of lost leadership is never swallowed
 *    into a warning (mutation: catch it like any other error ⇒ red).
 *  · ABSENT PORT ⇒ the field is optional and the cycle is byte-identical to before.
 */

function adapterOf(rec: string[]): MailboxAdapter {
  return {
    changesSince: async (_c: ImapCursor) => {
      rec.push("changesSince");
      return {
        creates: [], moves: [], flagChanges: [], deletes: [],
        newCursor: { folders: {} }, hasBacklog: false,
      } as ChangeBatch;
    },
  } as unknown as MailboxAdapter;
}

function repoOf(): WorkerRepo {
  const stub = {
    // The removal fence reads this inside every write transaction; the double answers what a live
    // mailbox answers (see `assertMailboxStillHere`), because absent it the fence is a TypeError.
    mailboxStatusForWrite: async (): Promise<string> => "connected",
    getMailboxFolders: async () => [],
    listKnownLocators: async () => [],
    listMessageFailures: async () => [],
    claimMessageFailures: async () => [],
    forgetInstanceAt: async () => {},
    findByDedupKey: async () => null,
    upsertMailboxFolder: async () => {},
    upsertMailboxFolders: async () => {},
    listPendingFolderStates: async () => [],
    listPendingFlagStates: async () => [],
    listPendingFolderOps: async () => [],
    recordAudit: async () => {},
    listRules: async () => [],
    knownSenders: async () => ({ addresses: new Set<string>(), inferred: new Set<string>(), lists: new Map() }),
    ownAddresses: async () => new Set<string>(),
    releaseOwnMailAtGate: async () => 0,
  };
  return {
    ...stub,
    transaction: async (fn: (r: WorkerRepo) => Promise<unknown>) => fn(stub as unknown as WorkerRepo),
  } as unknown as WorkerRepo;
}

interface Port { port: JunkSweepCommandPort; rec: string[]; cleared: string[]; seenCommands: string[] }

function portOf(opts: {
  stamp: string | null; fail?: Error; moved?: string[]; remaining?: number; examinedAll?: boolean;
  /** Members skipped because their SOURCE LOCATOR was stale — see the deferral case below. */
  deferred?: number;
  /** Whether those deferrals should still hold the press open (the bounded exemption). */
  deferralsHold?: boolean;
}): Port {
  const rec: string[] = [];
  const cleared: string[] = [];
  const seenCommands: string[] = [];
  const port: JunkSweepCommandPort = {
    requested: async () => { rec.push("requested"); return opts.stamp; },
    run: async (hooks) => {
      rec.push("run");
      if (opts.fail) throw opts.fail;
      // The fences arrive and are usable: an authority the predicate admits, a write group that
      // runs its fn. `assertMayWriteToMailbox` is the ONE thing every write site asks.
      seenCommands.push(hooks.command);
      await assertMayWriteToMailbox(hooks.writeAuthority, "move");
      await hooks.write(async () => { rec.push("write"); return 1; });
      return {
        moved: opts.moved ?? ["m1"], skipped: [], junkFolder: "INBOX/Junk",
        deferred: opts.deferred ?? 0,
        deferralsHold: opts.deferralsHold ?? (opts.deferred ?? 0) > 0,
        examinedAll: opts.examinedAll ?? true,
      };
    },
    remaining: async () => { rec.push("remaining"); return opts.remaining ?? 0; },
    clear: async (observed) => { rec.push("clear"); cleared.push(observed); },
  };
  return { port, rec, cleared, seenCommands };
}

let lastOwesFiling = false;
async function cycle(p: Port | null): Promise<string[]> {
  const rec = p?.rec ?? [];
  const out = await runSyncCycle({
    repo: repoOf(), adapter: adapterOf(rec), accountId: "acct", mailboxId: "mb",
    storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE,
    ...(p ? { junkSweep: p.port } : {}),
  });
  lastOwesFiling = out.owesFiling;
  return rec;
}

describe("the sweep command inside the cycle", () => {
  it("no stamp: asked once, ran nothing, cleared nothing, and the cycle went on", async () => {
    const p = portOf({ stamp: null });
    expect(await cycle(p)).toEqual(["requested", "changesSince"]);
    expect(p.cleared).toEqual([]);
  });

  it("a stamp: run under both fences, then — pile DRAINED — the OBSERVED token cleared, before the cursor read", async () => {
    const p = portOf({ stamp: "2026-08-27 10:00:00.123456+00", remaining: 0 });
    expect(await cycle(p)).toEqual(["requested", "run", "write", "remaining", "clear", "changesSince"]);
    expect(p.cleared).toEqual(["2026-08-27 10:00:00.123456+00"]);
    expect(lastOwesFiling).toBe(false);
  });

  it("a slice that LANDED with more left keeps the stamp and re-kicks the mailbox (owesFiling)", async () => {
    const p = portOf({ stamp: "2026-08-27 10:00:00+00", moved: ["m1", "m2"], remaining: 7 });
    expect(await cycle(p)).toEqual(["requested", "run", "write", "remaining", "changesSince"]);
    expect(p.cleared).toEqual([]);
    expect(lastOwesFiling).toBe(true);
  });

  it("a FULL scan that moved NOTHING with members left is STUCK — retired rather than retried every cycle", async () => {
    const p = portOf({ stamp: "2026-08-27 10:00:00+00", moved: [], remaining: 3, examinedAll: true });
    expect(await cycle(p)).toEqual(["requested", "run", "write", "remaining", "clear", "changesSince"]);
    expect(p.cleared).toEqual(["2026-08-27 10:00:00+00"]);
    expect(lastOwesFiling).toBe(false);
  });

  /**
   * The second arm. THE CASE THAT LOOKS EXACTLY LIKE "STUCK" AND IS ITS OPPOSITE.
   *
   * Every other input here is identical to the STUCK case above — a full scan, of a non-empty
   * pile, that moved nothing. The single difference is WHY nothing moved: the members were not
   * refused, they were not at the locator the mirror holds. That happens wholesale when a provider
   * recreates `ohmail/Quarantine` under a new UIDVALIDITY, and it clears itself on the next
   * `changesSince`, which re-finds every one of them by Message-ID.
   *
   * Retiring the press here consumed a user's one-time command for a condition that would have
   * gone away, and then offered it back to them as though the mail needed pressing for again.
   *
   * MUTATION WATCHED: drop `!res.deferralsHold` from `stuck` in `sync.ts` and this goes red on the
   * `clear` — which is exactly the shipped behaviour it describes.
   */
  it("a full scan that moved nothing because every member's LOCATOR was stale is NOT stuck — the press survives", async () => {
    const p = portOf({
      stamp: "2026-08-27 10:00:00+00", moved: [], deferred: 3, remaining: 3, examinedAll: true,
    });
    expect(await cycle(p)).toEqual(["requested", "run", "write", "remaining", "changesSince"]);
    expect(p.cleared).toEqual([]);
    // Re-kicked rather than left to a poll interval: the deferrals resolve as adoption repoints
    // them, so the sooner the next window runs the sooner the pile actually drains.
    expect(lastOwesFiling).toBe(true);
  });

  /**
   * THE BOUND, AT THIS SEAM. Deferrals hold the press open — but not for ever, and the cycle reads
   * one field for that rather than inferring it from the count. Three consecutive barren scans
   * spend the exemption (`SWEEP_MAX_DEFERRED_SCANS`), after which a still-deferring pile retires
   * exactly like a refused one. Without this the retirement rule was unbounded through a new door.
   */
  it("once the deferral exemption is spent, a deferring pile retires like a refused one", async () => {
    const p = portOf({
      stamp: "2026-08-27 10:00:00+00", moved: [], deferred: 3, deferralsHold: false,
      remaining: 3, examinedAll: true,
    });
    expect(await cycle(p)).toEqual(["requested", "run", "write", "remaining", "clear", "changesSince"]);
    expect(p.cleared).toEqual(["2026-08-27 10:00:00+00"]);
  });

  it("a window that moved nothing WITHOUT having examined the whole pile is an unfinished scan — stamp stands, re-kicked", async () => {
    const p = portOf({ stamp: "2026-08-27 10:00:00+00", moved: [], remaining: 3, examinedAll: false });
    expect(await cycle(p)).toEqual(["requested", "run", "write", "remaining", "changesSince"]);
    expect(p.cleared).toEqual([]);
    expect(lastOwesFiling).toBe(true);
  });

  it("a run that throws leaves the stamp STANDING and does not wedge the mail flow", async () => {
    const p = portOf({ stamp: "2026-08-27 10:00:00+00", fail: new Error("SEARCH failed") });
    expect(await cycle(p)).toEqual(["requested", "run", "changesSince"]);
    expect(p.cleared).toEqual([]);
  });

  it("a fence refusal out of the run PROPAGATES — never swallowed into a warning", async () => {
    const p = portOf({ stamp: "2026-08-27 10:00:00+00", fail: new LeaderFencedError("fenced") });
    await expect(cycle(p)).rejects.toBeInstanceOf(LeaderFencedError);
    expect(p.cleared).toEqual([]);
  });

  it("an absent port is the cycle as it was", async () => {
    expect(await cycle(null)).toEqual(["changesSince"]);
  });
});
