import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect } from "vitest";
import { MessageGoneError, WriteDeclinedError } from "@trafficflow/core/adapters/imap";
import type { ChangeBatch, ImapCursor, MailboxAdapter, NativeLocator, WriteDoor } from "@trafficflow/core/adapters/imap";
import type { PendingJunkRescue, WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { runSyncCycle, LeaderFencedError, type SyncDeps } from "../src/sync.js";
import { JUNK_RESCUE_MAX_ATTEMPTS } from "../src/junk-rescue.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * THE JUNK RESCUE INSIDE THE CYCLE (FOLDERS-SPEC.md §16.2) — driven through `runSyncCycle` with a
 * fake repo and a recording adapter, which is the point of the case rather than its convenience.
 *
 * What is pinned, each watched red under a mutation before landing (2026-09-17):
 *
 *  · NO PORT, NO WIRING. The cycle is given nothing but a repo, and the pass still runs — that is
 *    the whole difference from `junk_sweep`, whose consumer is an optional `SyncDeps` port wired
 *    in `apps/worker/src/index.ts` alone and therefore never drained on the desktop and standalone
 *    doors (mutation: make the pass an optional port like `junkSweep` ⇒ every case here goes green
 *    without the pass running, which is why the adapter RECORDS its calls in order).
 *  · BEFORE THE CURSOR. The move is issued before `changesSince`, so the same cycle ingests the
 *    arrival with its bytes (mutation: move the slot below the cursor build ⇒ the order assertion
 *    reddens).
 *  · A READER MOVES NOTHING and the row STANDS — a demoted install may not execute a command
 *    recorded when it was the organizer (mutation: drop `!readerMode` ⇒ red).
 *  · A FIXTURE THAT CANNOT COMPLY is driven at least once: an adapter whose `move` refuses the way
 *    a mail server refuses, one whose folder is gone, and one whose host is unreachable — three
 *    endings, three different rows.
 *  · The ladder's ceiling is `JUNK_RESCUE_MAX_ATTEMPTS` and the refused row is KEPT, so the window
 *    can say so.
 */

const ROW: PendingJunkRescue = {
  id: "r1", accountId: "acct", mailboxId: "mb",
  folder: "INBOX/Junk", uidValidity: "7", uid: 42, attempts: 0, foldersOff: false,
};

interface Recorder {
  calls: string[];
  moves: Array<{ from: NativeLocator; to: string }>;
  resolved: string[];
  deferred: Array<{ id: string; attempts: number; errorClass: string }>;
  refused: Array<{ id: string; attempts: number; errorClass: string }>;
}

function adapterOf(rec: Recorder, move: () => Promise<unknown>): MailboxAdapter {
  return {
    // Asks the door the way the real adapter does: a declined move is never issued.
    move: async (from: NativeLocator, to: string, door: WriteDoor) => {
      const answer = door.ask("move");
      if (!answer.admit) throw new WriteDeclinedError("move", answer.reason);
      rec.calls.push("move");
      rec.moves.push({ from, to });
      return move();
    },
    changesSince: async (_c: ImapCursor) => {
      rec.calls.push("changesSince");
      return {
        creates: [], moves: [], flagChanges: [], deletes: [],
        newCursor: { folders: {} }, hasBacklog: false,
      } as ChangeBatch;
    },
  } as unknown as MailboxAdapter;
}

function repoOf(rec: Recorder, rows: PendingJunkRescue[], foldersOffNow: () => boolean): WorkerRepo {
  const stub = {
    getMailbox: async () => ({ id: "mb", accountId: "acct", address: "a@b.test", kickstartAt: null, foldersOff: foldersOffNow() }),
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
    listFolderOps: async () => [],
    recordAudit: async () => {},
    listRules: async () => [],
    knownSenders: async () => ({ addresses: new Set<string>(), inferred: new Set<string>(), lists: new Map() }),
    ownAddresses: async () => new Set<string>(),
    releaseOwnMailAtGate: async () => 0,
    listPendingJunkRescues: async () => { rec.calls.push("listPendingJunkRescues"); return rows; },
    resolveJunkRescue: async (id: string) => { rec.calls.push("resolve"); rec.resolved.push(id); },
    deferJunkRescue: async (id: string, attempts: number, _at: Date, errorClass: string) => {
      rec.calls.push("defer");
      rec.deferred.push({ id, attempts, errorClass });
    },
    refuseJunkRescue: async (id: string, attempts: number, errorClass: string) => {
      rec.calls.push("refuse");
      rec.refused.push({ id, attempts, errorClass });
    },
  };
  return {
    ...stub,
    transaction: async (fn: (r: WorkerRepo) => Promise<unknown>) => fn(stub as unknown as WorkerRepo),
  } as unknown as WorkerRepo;
}

async function cycle(opts: {
  rows?: PendingJunkRescue[];
  move?: () => Promise<unknown>;
  role?: "organizer" | "reader";
  foldersOffNow?: () => boolean;
}): Promise<Recorder & { owesFiling: boolean }> {
  const rec: Recorder = { calls: [], moves: [], resolved: [], deferred: [], refused: [] };
  /* EVERY REQUIRED FIELD STATED, none inherited from an omission. `role` in particular: an
     omitted one reads as ORGANIZER by design, and a fixture that relies on that is silent about
     the thing this file is testing. `writeAuthority` names the reason it holds none, which is the
     field's own contract — absent and "there is no such thing here" are different facts. */
  const deps: SyncDeps = {
    repo: repoOf(rec, opts.rows ?? [ROW], opts.foldersOffNow ?? (() => false)),
    adapter: adapterOf(rec, opts.move ?? (async () => ({ folder: "INBOX", ref: "1:9" }))),
    accountId: "acct", mailboxId: "mb",
    storageCap: UNMETERED_STORAGE_CAP,
    trustedAuthservIds: new Set<string>(),
    writeAuthority: FIXTURE_LEASE,
    role: opts.role ?? "organizer",
  };
  const out = await runSyncCycle(deps);
  return { ...rec, owesFiling: out.owesFiling };
}

describe("the junk rescue inside the cycle", () => {
  it("drains a pending command with NO port wired, and moves it BEFORE the cursor is built", async () => {
    const rec = await cycle({});
    // The order IS the claim: read, move, delete the row, and only then the change scan — so the
    // same cycle ingests the arrival in INBOX with its bytes.
    expect(rec.calls).toEqual(["listPendingJunkRescues", "move", "resolve", "changesSince"]);
    expect(rec.moves).toEqual([{ from: { folder: "INBOX/Junk", ref: "7:42" }, to: "INBOX" }]);
    expect(rec.resolved).toEqual(["r1"]);
  });

  it("no pending command: one read and nothing else", async () => {
    const rec = await cycle({ rows: [] });
    expect(rec.calls).toEqual(["listPendingJunkRescues", "changesSince"]);
  });

  it("a READER moves nothing and the row STANDS — the organizer's own cycle serves it", async () => {
    // The press was recorded by an install that was the organizer at the time, and the API does
    // not refuse it once recorded — so without this gate a demotion between the press and the
    // cycle turns a queued command into a real move on somebody else's mailbox.
    const rec = await cycle({ role: "reader" });
    expect(rec.calls).toEqual(["changesSince"]);
    expect(rec.resolved).toEqual([]);
    expect(rec.deferred).toEqual([]);
  });

  it("a folder switched OFF under Use folders voids the command without moving anything", async () => {
    const rec = await cycle({ rows: [{ ...ROW, foldersOff: true }] });
    expect(rec.calls).toEqual(["listPendingJunkRescues", "resolve", "changesSince"]);
    expect(rec.moves).toEqual([]);
  });

  it("Use folders switched OFF after the first press: the next press is dropped, never moved", async () => {
    // The listing said on; the person switches folders off while the pass is between presses.
    let off = false;
    const rows = [{ ...ROW, id: "r1", uid: 42 }, { ...ROW, id: "r2", uid: 43 }];
    const rec = await cycle({
      rows, foldersOffNow: () => off,
      move: async () => { off = true; return { folder: "INBOX", ref: "1:9" }; },
    });
    expect(rec.moves.map((m) => m.from.ref), "a press moved after the mailbox was switched off").toEqual(["7:42"]);
    expect(rec.resolved).toEqual(["r1", "r2"]);
    expect([rec.deferred, rec.refused]).toEqual([[], []]);
  });

  /**
   * THE FIXTURE THAT CANNOT COMPLY, three ways — the double fails the way production fails, with
   * the same classes the reconciler's own refusal vocabulary raises.
   */
  it("a mail server that REFUSES the move defers the row with the refusal's class", async () => {
    const refusal = Object.assign(new Error("NO [NOPERM] move refused"), { serverResponseCode: "NOPERM" });
    const rec = await cycle({ move: async () => { throw refusal; } });
    expect(rec.calls).toEqual(["listPendingJunkRescues", "move", "defer", "changesSince"]);
    expect(rec.deferred).toEqual([{ id: "r1", attempts: 1, errorClass: "read_only" }]);
    expect(rec.resolved).toEqual([]);
  });

  it("a folder that no longer holds the message RESOLVES the row — the live window is the re-find", async () => {
    // The epoch guard raises this for a rebuilt folder as much as for a deleted message, and both
    // mean the same thing here: this coordinate names nothing, so the command is finished. Nothing
    // searches by Message-ID — the window restarts under the new epoch and the person presses the
    // fresh row.
    const gone = new MessageGoneError({ folder: "INBOX/Junk", ref: "7:42" });
    const rec = await cycle({ move: async () => { throw gone; } });
    expect(rec.calls).toEqual(["listPendingJunkRescues", "move", "resolve", "changesSince"]);
  });

  it("an unreachable host leaves the row EXACTLY as it was — not this message's refusal", async () => {
    const outage = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const rec = await cycle({ move: async () => { throw outage; } });
    expect(rec.calls).toEqual(["listPendingJunkRescues", "move", "changesSince"]);
    expect([rec.resolved, rec.deferred, rec.refused]).toEqual([[], [], []]);
  });

  it("the ladder's last rung answers REFUSED and keeps the row, so the window can say so", async () => {
    // The server's tagged NO, as imapflow carries it: only that reads as `refused` (mail 0164).
    const refusal = Object.assign(new Error("NO move refused"), { responseStatus: "NO" });
    const rec = await cycle({
      rows: [{ ...ROW, attempts: JUNK_RESCUE_MAX_ATTEMPTS - 1 }],
      move: async () => { throw refusal; },
    });
    expect(rec.calls).toEqual(["listPendingJunkRescues", "move", "refuse", "changesSince"]);
    expect(rec.refused).toEqual([
      { id: "r1", attempts: JUNK_RESCUE_MAX_ATTEMPTS, errorClass: "refused" },
    ]);
    // …and it is a REFUSE, not a resolve: the row stays.
    expect(rec.resolved).toEqual([]);
  });

  it("a fence refusal PROPAGATES — lost leadership is never a per-row failure", async () => {
    await expect(cycle({ move: async () => { throw new LeaderFencedError("fenced"); } }))
      .rejects.toBeInstanceOf(LeaderFencedError);
  });

  it("more commands than one cycle may spend re-kicks the mailbox", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ ...ROW, id: `r${i}`, uid: 100 + i }));
    const rec = await cycle({ rows: many });
    // The pass asks for one row OVER its budget, so "there is more" is a fact about the queue
    // rather than a guess from a full page; it spends the budget and the caller re-kicks.
    expect(rec.moves).toHaveLength(20);
    expect(rec.owesFiling).toBe(true);
  });
});
