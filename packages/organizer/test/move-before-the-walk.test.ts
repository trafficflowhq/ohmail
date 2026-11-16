import { UNMETERED_STORAGE_CAP, createLogger } from "@trafficflow/core/mail";
import { describe, it, expect } from "vitest";
import type { NativeLocator } from "@trafficflow/core";
// The SAME module `sync.ts` imports these from, so `instanceof` answers as it does there.
import { MessageGoneError, type ChangeBatch, type ImapCursor, type MailboxAdapter, type MoveManyResult } from "@trafficflow/core/adapters/imap";
import type { WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { OrganizerStandDownError } from "../src/lease.js";
import { runSyncCycle, type SyncDeps } from "../src/sync.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * A MOVE PENDING WHEN A LOCAL ORGANIZER DRAIN STARTS REACHES THE WIRE BEFORE ITS FOLDER WALK.
 *
 * The cycle filed pending moves only in `reconcileMailbox`, after `buildCursor`, `changesSince` and
 * ingest, so on a standalone install a press waited out the whole walk (7.6 s median on the phone
 * rig). Every adapter and repo call the order is about goes on ONE list, so the order is the
 * assertion. The real-server arms are `move-before-the-walk.imap.test.ts`.
 */

const LOC = (folder: string, ref: string): NativeLocator => ({ folder, ref });

interface Opts {
  /** `listPendingFolderStates` throws this on its FIRST call. */
  pendingThrows?: unknown;
  /** No `moveMany`; `move` throws `MessageGoneError(absent)` — the per-message path. */
  goneOnMove?: boolean;
  /** Nothing pending; the special-folder reads and the adapter's capabilities are counted here. */
  idle?: { special: number; caps: number };
  /** One owed `\Seen` write of ours. */
  seen?: boolean;
  /** The pending move is a restore out of Trash, whose park left no copy on record. */
  restoreGone?: boolean;
}

function repoOf(calls: string[], o: Opts): WorkerRepo {
  let first = true;
  const stub = {
    mailboxStatusForWrite: async (): Promise<string> => "connected",
    getMailboxFolders: async () => [],
    listKnownLocators: async () => [],
    listMessageFailures: async () => [],
    claimMessageFailures: async () => [],
    upsertMailboxFolder: async () => {},
    upsertMailboxFolders: async () => {},
    listPendingFolderStates: async () => {
      calls.push("listPending");
      if (o.idle !== undefined) return [];
      if (first && o.pendingThrows !== undefined) { first = false; throw o.pendingThrows; }
      first = false;
      if (o.restoreGone === true) {
        return [{ messageId: "m-1", desiredFolder: "INBOX", observedFolder: "Trash", lastSetBy: "us" as const, nativeLocator: LOC("Trash", "42:1") }];
      }
      return [
        { messageId: "m-1", desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us" as const, nativeLocator: LOC("INBOX", "42:1") },
      ];
    },
    listPendingFlagStates: async () => {
      if (o.seen !== true) return [];
      calls.push("listPendingFlags");
      return [{ messageId: "m-2", desiredSeen: true, observedSeen: false, lastSetBy: "us" as const, nativeLocator: LOC("INBOX", "42:2") }];
    },
    completeFlagState: async () => { calls.push("completeFlagState"); return true; },
    updateLocator: async () => {},
    upsertFolderState: async () => {},
    completeFolderState: async () => { calls.push("completeFolderState"); return true; },
    upsertFlagState: async () => {},
    primaryInstanceVanished: async () => o.restoreGone === true,
    onlyInstanceAt: async () => true,
    recordAudit: async () => {},
    recordAuditMany: async () => {},
    deferFolderReconcile: async () => {},
    deferFlagReconcile: async () => {},
    ...(o.idle === undefined ? {} : {
      getMailboxSpecialFolders: async () => { o.idle!.special += 1; return { junkFolder: null, trashFolder: null }; },
    }),
    ...(o.restoreGone !== true ? {} : {
      getMailboxSpecialFolders: async () => ({ junkFolder: null, trashFolder: "Trash" }),
      adoptFolderState: async () => { calls.push("adoptFolderState"); return true; },
      dropGoneFromTrash: async (_a: string, _m: string, _t: string, rows: Array<{ messageId: string }>) => {
        calls.push("dropGoneFromTrash");
        return rows.map((r) => r.messageId);
      },
    }),
  };
  return {
    ...stub,
    transaction: async (fn: (r: WorkerRepo) => Promise<unknown>) => fn(stub as unknown as WorkerRepo),
  } as unknown as WorkerRepo;
}

function adapterOf(calls: string[], o: Opts): MailboxAdapter {
  return {
    changesSince: async (_c: ImapCursor) => {
      calls.push("changesSince");
      return { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} }, hasBacklog: false } as ChangeBatch;
    },
    ...(o.goneOnMove === true ? {} : {
      moveMany: async (locators: readonly NativeLocator[], toFolder: string): Promise<MoveManyResult> => {
        calls.push("moveMany");
        return {
          outcome: "batched",
          moved: new Map(locators.map((l, i) => [l.ref, LOC(toFolder, `7:${100 + i}`)])),
          gone: [],
        } as MoveManyResult;
      },
    }),
    move: async (l: NativeLocator) => {
      calls.push("move");
      if (o.goneOnMove === true) throw new MessageGoneError(l, true);
      return LOC("ohmail/News", "7:999");
    },
    setFlags: async () => { calls.push("setFlags"); },
    ...(o.idle === undefined ? {} : { capabilities: async () => { o.idle!.caps += 1; return {}; } }),
    ...(o.restoreGone !== true ? {} : {
      uidsHeld: async (_f: string, v: string) => { calls.push("uidsHeld"); return { k: "held", uidValidity: v, present: new Set() }; },
    }),
  } as unknown as MailboxAdapter;
}

async function order(extra: Partial<SyncDeps>, o: Opts = {}): Promise<{ calls: string[]; lines: string[]; err: unknown }> {
  const calls: string[] = [];
  const lines: string[] = [];
  let err: unknown = null;
  try {
    await runSyncCycle({
      repo: repoOf(calls, o), adapter: adapterOf(calls, o), accountId: "acct", mailboxId: "mb",
      role: "organizer", trustedAuthservIds: new Set<string>(), storageCap: UNMETERED_STORAGE_CAP,
      writeAuthority: FIXTURE_LEASE,
      log: createLogger({ service: "worker", level: "info", sink: (l) => lines.push(l) }),
      ...extra,
    } as SyncDeps);
  } catch (e) { err = e; }
  return { calls, lines, err };
}

const wire = (calls: readonly string[]) => calls.filter((c) => c !== "listPending" && c !== "completeFolderState");

describe("a move pending at the drain's start reaches the wire before the folder walk", () => {
  it("with the local door's flag set, moveMany comes before the first changesSince", async () => {
    const { calls, err } = await order({ fileBeforeWalk: true });
    expect(err).toBeNull();
    expect(calls).toContain("moveMany");
    expect(calls.indexOf("moveMany")).toBeLessThan(calls.indexOf("changesSince"));
  });

  it("flag off: the hosted order is unchanged, the walk first and the move after it", async () => {
    const { calls } = await order({});
    expect(wire(calls)).toEqual(["changesSince", "moveMany"]);
    const { calls: explicit } = await order({ fileBeforeWalk: false });
    expect(wire(explicit)).toEqual(["changesSince", "moveMany"]);
  });

  it("a reader skips the early pass: it asks for no pending move and moves nothing", async () => {
    const { calls, err } = await order({
      fileBeforeWalk: true, role: "reader", writeAuthority: { noLease: "reader" } as SyncDeps["writeAuthority"],
    });
    expect(err).toBeNull();
    expect(calls).toEqual(["changesSince"]);
  });

  it("a refusal in the early pass ends the cycle before the walk", async () => {
    const refusal = new OrganizerStandDownError({ organize: false, reason: "organized_elsewhere:local", state: "held" } as never);
    const { calls, err } = await order({ fileBeforeWalk: true }, { pendingThrows: refusal });
    expect(err).toBe(refusal);
    expect(calls).not.toContain("changesSince");
  });

  it("any other failure is contained and named: the walk runs, and the tail files the move", async () => {
    const { calls, lines, err } = await order({ fileBeforeWalk: true }, { pendingThrows: new Error("the store did not answer") });
    expect(err).toBeNull();
    expect(lines.some((l) => l.includes("\"filing_before_walk_failed\""))).toBe(true);
    expect(wire(calls)).toEqual(["changesSince", "moveMany"]);
  });

  it("a member absent from its source is not voided before the walk; the tail decides after it", async () => {
    const { calls, err } = await order({ fileBeforeWalk: true }, { goneOnMove: true });
    expect(err).toBeNull();
    // Two attempts — before and after the walk — and the void (`completeFolderState`) only after it.
    expect(calls.filter((c) => c === "move")).toHaveLength(2);
    expect(calls.indexOf("completeFolderState")).toBeGreaterThan(calls.indexOf("changesSince"));
  });

  it("a restore whose Trash copy the move finds absent leaves Trash before the walk; the walk never reads Trash", async () => {
    const { calls, err } = await order({ fileBeforeWalk: true }, { goneOnMove: true, restoreGone: true });
    expect(err).toBeNull();
    expect(calls).toContain("dropGoneFromTrash");
    expect(calls.indexOf("uidsHeld"), "dropped on the move's reading alone").toBeGreaterThan(-1);
    expect(calls.indexOf("uidsHeld")).toBeLessThan(calls.indexOf("dropGoneFromTrash"));
    expect(calls.indexOf("dropGoneFromTrash")).toBeLessThan(calls.indexOf("changesSince"));
    expect(calls, "the gone copy was put back into Trash").not.toContain("adoptFolderState");
  });

  /* AN IDLE EARLY PASS ASKS FOR THE PENDING LIST AND NOTHING ELSE. With nothing to file it returns
     before the special-folder read and the adapter's capabilities, so an idle local drain reads
     those as often as the hosted order; the pending list is the one question the pass adds. */
  it("an idle drain's early pass reads the pending list and returns", async () => {
    const hosted = { special: 0, caps: 0 };
    const local = { special: 0, caps: 0 };
    const a = await order({}, { idle: hosted });
    const b = await order({ fileBeforeWalk: true }, { idle: local });
    expect([a.err, b.err]).toEqual([null, null]);
    expect(hosted).toEqual({ special: 1, caps: 1 });
    expect(local).toEqual(hosted);
    const pending = (calls: readonly string[]) => calls.filter((c) => c === "listPending").length;
    expect(pending(b.calls)).toBe(pending(a.calls) + 1);
  });
});

/* THE LOCAL DOOR'S PUSH AFTER A READ PRESS: the tail's `\Seen` writes alone, as a reader. */
describe("a seen-only cycle", () => {
  const reader = { role: "reader", writeAuthority: { noLease: "reader" } as SyncDeps["writeAuthority"] } as const;

  it("sends the owed \\Seen write and nothing else: no walk, no move, no other pass", async () => {
    const { calls, err } = await order({ ...reader, seenOnly: true }, { seen: true });
    expect(err).toBeNull();
    expect(calls).toEqual(["listPendingFlags", "setFlags", "completeFlagState"]);
  });

  it("a reader cycle without the flag still walks first", async () => {
    const { calls } = await order({ ...reader }, { seen: true });
    expect(calls.indexOf("changesSince")).toBeLessThan(calls.indexOf("setFlags"));
  });

  it("is refused for an organizer before anything reaches the wire", async () => {
    const { calls, err } = await order({ seenOnly: true }, { seen: true });
    expect(err).toBeInstanceOf(Error);
    expect(calls).toEqual([]);
  });
});
