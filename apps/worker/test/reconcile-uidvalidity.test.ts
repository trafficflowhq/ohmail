import { describe, it, expect } from "vitest";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import type { NativeLocator } from "@trafficflow/core";
import type { WorkerRepo, PendingFolderState, PendingFlagState } from "@trafficflow/core/adapters/drizzle-repo";
import { reconcileMailbox } from "../src/sync.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ORGANIZER STANDS DOWN WHEN THE FOLDER IT PLANNED AGAINST HAS BEEN RECYCLED
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * proven through BOTH layers rather than at the adapter alone.
 *
 * The sequence needs no attacker, no unusual account and no concurrency between our own writers:
 *
 *  1. A user files message A. The row is pending with a source locator `E:U` (epoch, then UID).
 *  2. The provider purges and recreates that folder on its own schedule — ordinary IMAP. The
 *     folder's UIDVALIDITY changes and its UIDs are re-issued from the bottom, so UID U now
 *     belongs to an UNRELATED message B.
 *  3. The reconcile pass runs and issues `UID MOVE U` / `UID STORE U`.
 *
 * Step 3 used to move B — a message the user never touched, in their real mailbox, which is the
 * master. Every path was affected: `move` was called without the opt-in epoch flag, `moveMany`
 * reduced each locator to a bare UID, and `setFlags` discarded the epoch half of the ref.
 *
 * ── WHY THIS TEST USES A REAL `ImapAdapter` ─────────────────────────────────────────────────
 *
 * The other files in this directory drive `reconcileMailbox` with a hand-written adapter, which
 * is right for testing the reconciler's bookkeeping and useless here: a fake adapter would
 * enforce whatever epoch rule the fake was written with, so the test would be asserting its own
 * stub. The guard lives in `ImapAdapter`, so the adapter is real and the IMAP CLIENT is the fake
 * — the same seam `packages/core/test/adapters/imap.epoch-guard.test.ts` uses, one layer down.
 * What this file adds is the half that is the worker's: that a refusal leaves the user's intent
 * INTACT and RE-RESOLVABLE rather than recorded as done.
 *
 * The recycled folder deliberately still HOLDS a message at the same UID. A folder that answered
 * nothing would refuse through the ordinary gone-at-source probe and prove nothing about epochs.
 *
 * MUTATIONS WATCHED RED AND RESTORED (2026-08-31):
 *  · `ImapAdapter#locatorEpochStale` → `return false` ⇒ every refusal case red, and red by
 *    OBSERVING THE WRONG MESSAGE MOVE (`messageMove [2] → INBOX` in `imap`), not by a return value;
 *  · drop `moveMany`'s step-1 decline ⇒ the batch case red the same way.
 */

const LOC = (folder: string, ref: string): NativeLocator => ({ folder, ref });
const SRC = "ohmail/Screener";

interface Recorded {
  /** Every IMAP command the fake client was asked to perform that CHANGES the mailbox. */
  imap: string[];
  locators: Array<{ messageId: string; locator: NativeLocator }>;
  folderStates: Array<{ messageId: string; desired: string; observed: string }>;
  flagStates: Array<{ messageId: string; desired: boolean; observed: boolean }>;
  audits: string[];
  deferred: Array<{ messageId: string; attempts: number; errorClass: string }>;
}

const blank = (): Recorded => ({ imap: [], locators: [], folderStates: [], flagStates: [], audits: [], deferred: [] });

function repoOf(rec: Recorded, opts: {
  pending?: PendingFolderState[];
  pendingFlags?: PendingFlagState[];
  /** Message ids whose disappearance is durably on record — `primaryInstanceVanished` truth. */
  vanished?: ReadonlySet<string>;
} = {}): WorkerRepo {
  const stub: Record<string, unknown> = {
    listPendingFolderStates: async () => opts.pending ?? [],
    listPendingFlagStates: async () => opts.pendingFlags ?? [],
    updateLocator: async (messageId: string, locator: NativeLocator) => { rec.locators.push({ messageId, locator }); },
    upsertFolderState: async (messageId: string, s: { desiredFolder: string; observedFolder: string }) => {
      rec.folderStates.push({ messageId, desired: s.desiredFolder, observed: s.observedFolder });
    },
    // The completion path's conditional write — same two keys into the same array; see
    // `filing-batch.test.ts`'s note for why this file does not re-prove the conditionality.
    completeFolderState: async (
      messageId: string, c: { expectDesiredFolder: string; observedFolder: string },
    ) => {
      rec.folderStates.push({ messageId, desired: c.expectDesiredFolder, observed: c.observedFolder });
      return true;
    },
    upsertFlagState: async (messageId: string, s: { desiredSeen: boolean; observedSeen: boolean }) => {
      rec.flagStates.push({ messageId, desired: s.desiredSeen, observed: s.observedSeen });
    },
    primaryInstanceVanished: async (messageId: string) => opts.vanished?.has(messageId) ?? false,
    recordAudit: async (_a: string, action: string) => { rec.audits.push(action); },
    recordAuditMany: async (_a: string, batch: ReadonlyArray<{ action: string }>) => {
      for (const r of batch) rec.audits.push(r.action);
    },
    deferFolderReconcile: async (messageId: string, d: { attempts: number; errorClass: string }) => {
      rec.deferred.push({ messageId, attempts: d.attempts, errorClass: d.errorClass });
    },
    deferFlagReconcile: async () => {},
    transaction: async (fn: (r: WorkerRepo) => Promise<unknown>) => fn(stub as unknown as WorkerRepo),
    // The removal fence reads this inside every write transaction; the double answers what a live
    // mailbox answers (see `assertMailboxStillHere`), because absent it the fence is a TypeError.
    mailboxStatusForWrite: async (): Promise<string> => "connected",
  };
  return stub as unknown as WorkerRepo;
}

/**
 * An imapflow stand-in whose folders report a UIDVALIDITY and still hold a message at every UID
 * asked for — the recycled folder's twin.
 */
function fakeClient(rec: Recorded, epochs: Record<string, bigint>) {
  const client = {
    usable: true,
    capabilities: new Map<string, boolean>([["IDLE", true], ["UIDPLUS", true], ["MOVE", true]]),
    mailbox: false as unknown,
    async list() {
      return Object.keys(epochs).map((path) => ({
        path, name: path, delimiter: "/", flags: new Set<string>(),
      }));
    },
    async getMailboxLock(path: string) {
      client.mailbox = { path, exists: 9, uidValidity: epochs[path] ?? 1n };
      return { path, release() { /* nothing */ } };
    },
    async search() { return [] as number[]; },
    async fetchOne(range: string) {
      return { uid: Number(range), envelope: { messageId: `<twin-${range}@x>` }, source: undefined };
    },
    async fetchAll(range: string) {
      return String(range).split(",").map((u) => ({ uid: Number(u), envelope: { messageId: `<twin-${u}@x>` } }));
    },
    async messageMove(uids: number[] | number, to: string) {
      const list = Array.isArray(uids) ? uids : [uids];
      rec.imap.push(`messageMove ${JSON.stringify(list)} → ${to}`);
      return { uidValidity: 100n, uidMap: new Map(list.map((u) => [u, u + 1000])) };
    },
    async messageCopy(uids: number[], to: string) {
      rec.imap.push(`messageCopy ${JSON.stringify(uids)} → ${to}`);
      return { uidValidity: 100n, uidMap: new Map(uids.map((u) => [u, u + 1000])) };
    },
    async messageDelete(uids: number[]) { rec.imap.push(`messageDelete ${JSON.stringify(uids)}`); return true; },
    async messageFlagsAdd(uids: number[]) { rec.imap.push(`flagsAdd ${JSON.stringify(uids)}`); return true; },
    async messageFlagsRemove(uids: number[]) { rec.imap.push(`flagsRemove ${JSON.stringify(uids)}`); return true; },
    async logout() { /* nothing */ },
    close() { /* nothing */ },
  };
  return client;
}

async function adapterOver(rec: Recorded, epochs: Record<string, bigint>) {
  const adapter = new ImapAdapter(
    { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } },
    { client: fakeClient(rec, epochs) },
  );
  await adapter.connect();
  return adapter;
}

const run = async (rec: Recorded, repo: WorkerRepo, epochs: Record<string, bigint>) =>
  reconcileMailbox({ writeAuthority: FIXTURE_LEASE,
    repo, adapter: await adapterOver(rec, epochs), accountId: "acct-1", mailboxId: "mb-1",
  } as never);

/** `n` pending moves out of the recycled folder, all carrying epoch `epoch`. */
const moves = (epoch: number, n: number): PendingFolderState[] =>
  Array.from({ length: n }, (_, i) => ({
    messageId: `m-${i}`,
    desiredFolder: "INBOX",
    observedFolder: SRC,
    lastSetBy: "us" as const,
    nativeLocator: LOC(SRC, `${epoch}:${i + 1}`),
  }));

describe("a recycled source folder — the per-message filing path", () => {
  it("REFUSES: no IMAP write, no locator, no completion — the intent survives for the next scan", async () => {
    const rec = blank();
    // One pending move, so the chunk is below the batching threshold in neither direction — the
    // batch is tried first and declines, then `fileOne` refuses. Both halves are exercised.
    await run(rec, repoOf(rec, { pending: moves(7, 1) }), { [SRC]: 9n, INBOX: 1n });

    // THE ASSERTION THE ROW EXISTS FOR: the twin now wearing UID 1 was not touched.
    expect(rec.imap).toEqual([]);
    // Nothing was written down either, so the user's intent is still pending and DUE. The next
    // `changesSince` re-enumerates the recycled folder and re-resolves the message by its
    // Message-ID — the row is deferred, never lost.
    expect(rec.locators).toEqual([]);
    expect(rec.folderStates).toEqual([]);
    // …and it is NEVER SILENT (mail 0164): with no copy under the live epoch on record, the row is
    // deferred on the ladder under `stale_locator` — the folder's event, not the server's refusal —
    // with its audit row, and the next scan re-resolves the message by its Message-ID.
    expect(rec.audits).toEqual(["reconcile.move.failed"]);
    expect(rec.deferred).toEqual([{ messageId: "m-0", attempts: 1, errorClass: "stale_locator" }]);
  });

  it("ACTS on a matching epoch — the healthy path files exactly as before", async () => {
    const rec = blank();
    await run(rec, repoOf(rec, { pending: moves(9, 1) }), { [SRC]: 9n, INBOX: 1n });

    expect(rec.imap).toEqual(["messageMove [1] → INBOX"]);
    expect(rec.locators).toEqual([{ messageId: "m-0", locator: { folder: "INBOX", ref: "100:1001" } }]);
    expect(rec.folderStates).toEqual([{ messageId: "m-0", desired: "INBOX", observed: "INBOX" }]);
    expect(rec.audits).toEqual(["reconcile.move"]);
  });

  it("a DURABLY vanished message is voided rather than left pending, exactly as an expunge is", async () => {
    // The one write a refusal may make: when the instance is already known gone, nothing will
    // ever adopt this row, so it is closed instead of re-attempted every cycle for ever.
    const rec = blank();
    await run(
      rec,
      repoOf(rec, { pending: moves(7, 1), vanished: new Set(["m-0"]) }),
      { [SRC]: 9n, INBOX: 1n },
    );
    expect(rec.imap).toEqual([]);
    expect(rec.folderStates).toEqual([{ messageId: "m-0", desired: "INBOX", observed: "INBOX" }]);
    expect(rec.audits).toEqual(["reconcile.move.voided"]);
  });
});

describe("a recycled source folder — the BATCHED filing path", () => {
  it("a whole chunk of stale locators moves nothing, on either the batch or the fallback", async () => {
    // The batch declines (`outcome: "declined"`), the caller re-files the chunk one message at a time,
    // and each of those refuses. The failure this guards against is a single `UID MOVE 1,2,…,40`
    // relocating forty of somebody else's messages in one command.
    const rec = blank();
    await run(rec, repoOf(rec, { pending: moves(7, 40) }), { [SRC]: 9n, INBOX: 1n });
    expect(rec.imap).toEqual([]);
    expect(rec.locators).toEqual([]);
    expect(rec.folderStates).toEqual([]);
  });

  it("the same chunk at a MATCHING epoch batches into ONE command", async () => {
    const rec = blank();
    await run(rec, repoOf(rec, { pending: moves(9, 40) }), { [SRC]: 9n, INBOX: 1n });
    expect(rec.imap).toHaveLength(1);
    expect(rec.imap[0]).toMatch(/^messageMove \[1,2,3,/);
    expect(rec.locators).toHaveLength(40);
  });
});

describe("a recycled source folder — the `\\Seen` mirror", () => {
  const flags = (epoch: number): PendingFlagState[] => [{
    messageId: "f-0",
    desiredSeen: true,
    observedSeen: false,
    lastSetBy: "us" as const,
    nativeLocator: LOC(SRC, `${epoch}:1`),
    attempts: 0,
  } as PendingFlagState];

  it("REFUSES a stale-epoch STORE — a stranger's message is never marked read in the user's mailbox", async () => {
    const rec = blank();
    await run(rec, repoOf(rec, { pendingFlags: flags(7) }), { [SRC]: 9n, INBOX: 1n });
    expect(rec.imap).toEqual([]);
    // Not converged: `desired_seen` is untouched, so the intent survives the folder's renumbering
    // and lands once the scan has re-resolved the locator — recorded and deferred, never silent.
    expect(rec.flagStates).toEqual([]);
    expect(rec.audits).toEqual(["reconcile.flags.failed"]);
  });

  it("ACTS on a matching epoch", async () => {
    const rec = blank();
    await run(rec, repoOf(rec, { pendingFlags: flags(9) }), { [SRC]: 9n, INBOX: 1n });
    expect(rec.imap).toEqual(["flagsAdd [1]"]);
  });
});
