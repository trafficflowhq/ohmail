import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect } from "vitest";
import type { NativeLocator } from "@trafficflow/core";
import type { ChangeBatch, ImapCursor, MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { runSyncCycle } from "../src/sync.js";

/**
 * THE ONLY PLACE A DISAPPEARANCE IS WRITTEN DOWN.
 *
 * `batch.deletes` was consumed by NOTHING before this slice. It was described as a cursor-only
 * signal, and that description is what left `classifyDedup` unable to tell a user's move from a
 * stranger's delivery: a sender can make a locator APPEAR, only the user can make a stored locator
 * DISAPPEAR, and the disappearance was being thrown away (a review finding, and the reason the earlier repair worked).
 *
 * ── WHAT THIS FILE IS ACTUALLY GUARDING ────────────────────────────────────────────────────
 *
 * Two properties that pull in opposite directions, which is why both need a test:
 *
 *  · a delete at the LIVE epoch must be recorded, or a real user move that `correlateMoves` cannot
 *    pair (no Message-ID at all; a delete and a create in different batches) is never adopted and
 *    `reconcileFolders` drags it straight back — the ruling's risk 3.
 *  · a delete at a STALE epoch must NOT be, because a UIDVALIDITY change emits every prior UID as a
 *    delete while re-enumerating every one of them. Recording those would hand a whole folder's
 *    worth of adoption evidence to whatever create is processed first. **On an epoch change all
 *    evidence is void.**
 *
 * And the ORDER: absence is recorded BEFORE the ingest loop, so this cycle's deletes are evidence
 * for this cycle's creates.
 */

/** A minimal adapter that returns one prepared batch and records nothing else. */
function adapterOf(batch: Partial<ChangeBatch>): MailboxAdapter {
  return {
    changesSince: async (_c: ImapCursor) => ({
      creates: [], moves: [], flagChanges: [], deletes: [],
      newCursor: { folders: {} }, hasBacklog: false, ...batch,
    }) as ChangeBatch,
  } as unknown as MailboxAdapter;
}

interface Recorded { order: string[]; forgotten: Array<{ folder: string; ref: string }> }

/**
 * A repo that records the ORDER of the calls this loop makes, and nothing more.
 *
 * Deliberately hand-built rather than a `FakeRepo`: the property under test is the SEQUENCE of two
 * loops inside `runSyncCycle`, and a repo that stores state would let a passing assertion depend on
 * that state instead of on the order.
 */
function repoOf(rec: Recorded): WorkerRepo {
  let n = 0;
  const stub = {
    getMailboxFolders: async () => [],
    listKnownLocators: async () => [],
    // The durable failure ledger (mail 0041). `runSyncCycle` hydrates from it before it builds the
    // cursor, and it does NOT catch a throw there — a cycle that cannot say which UIDs are still
    // owed must not publish a watermark — so a stub that omits this method fails the whole loop
    // rather than the assertion under test.
    listMessageFailures: async () => [],
    claimMessageFailures: async () => [],
    forgetInstanceAt: async (_mb: string, locator: NativeLocator) => {
      rec.order.push(`forget:${locator.folder}#${locator.ref}`);
      rec.forgotten.push({ folder: locator.folder, ref: locator.ref });
    },
    findByDedupKey: async () => { rec.order.push("ingest"); return null; },
    upsertMailboxFolder: async () => { rec.order.push("cursor"); },
    upsertMailboxFolders: async () => { rec.order.push("cursor"); },
    listPendingFolderStates: async () => [],
    listPendingFlagStates: async () => [],
    recordAudit: async () => {},
    // Everything the ingest of one create touches, as no-ops. Present so a create reaches `commit`
    // and the ORDER assertion has two real events to compare.
    listRules: async () => [],
    knownSenders: async () => ({ addresses: new Set<string>(), inferred: new Set<string>(), lists: new Map() }),
    ownAddresses: async () => new Set<string>(),
    releaseOwnMailAtGate: async () => 0,
    getFolderState: async () => null,
    insertMessage: async () => ({
      id: `m-${++n}`, dedupKey: "fp1:x", nativeLocator: { folder: "INBOX", ref: "1:1" },
      threadId: "t", messageIdHeader: null, bodyHash: "h", subject: "s", fromAddress: "a@b.test",
    }),
    insertMessageBody: async () => {},
    insertAttachments: async () => {},
    upsertFolderState: async () => {},
    completeFolderState: async () => true,
    updateLocator: async () => {},
    recordChange: async () => 1n,
    recordChanges: async (cs: readonly unknown[]) => cs.map(() => 1n),
    recordInstance: async () => {},
    primaryInstanceVanished: async () => false,
    upgradeDedupKey: async () => false,
    setFolderConflict: async () => {},
    findThreadParent: async () => null,
    upsertThread: async () => ({ id: "t", created: false }),
    mergeThreadMessage: async () => false,
    setMessageThread: async () => false,
    // The ingest asks this inside its own transaction before it commits; `connected` is "the
    // mailbox is still here", which is what every case in this file is about.
    mailboxStatusForWrite: async () => "connected",
  };
  return {
    ...stub,
    transaction: async (fn: (r: WorkerRepo) => Promise<unknown>) => fn(stub as unknown as WorkerRepo),
  } as unknown as WorkerRepo;
}

const del = (folder: string, ref: string) =>
  ({ type: "delete" as const, locator: { folder, ref } });

/** One parseable message, so a create really reaches the ingest path. */
const RAW = Buffer.from([
  "Message-ID: <abs-1@x.test>", "From: anna@x.test", "To: mila@lichtgrat.example",
  "Subject: s", "Content-Type: text/plain; charset=utf-8", "", "body",
].join("\r\n"));

async function run(batch: Partial<ChangeBatch>): Promise<Recorded> {
  const rec: Recorded = { order: [], forgotten: [] };
  await runSyncCycle({
    repo: repoOf(rec), adapter: adapterOf(batch), accountId: "acct", mailboxId: "mb", storageCap: UNMETERED_STORAGE_CAP,
  });
  return rec;
}

describe("the worker records a DISAPPEARANCE, and only a real one", () => {
  it("forgets an instance whose epoch matches the epoch the server just reported", async () => {
    // The live epoch is read off the locators the adapter minted this pass (`epochsObserved`), which
    // is the server's own answer rather than a remembered one.
    const rec = await run({
      creates: [{ type: "create", locator: { folder: "INBOX", ref: "42:11" }, raw: RAW }],
      deletes: [del("INBOX", "42:7")],
      newCursor: { folders: { INBOX: { uidValidity: "42", uidNext: 12, highestModseq: "9" } } },
    });
    expect(rec.forgotten).toEqual([{ folder: "INBOX", ref: "42:7" }]);
  });

  it("falls back to the cursor's epoch for a folder that produced no create — the SOURCE folder", async () => {
    // The ordinary shape of an external move: the delete is in the source folder and the create is in
    // the destination, so the source folder contributes nothing to `epochsObserved`. Requiring an
    // observation there would refuse the evidence in exactly the case it is needed, and the user's
    // move would never be adopted.
    const rec = await run({
      creates: [{ type: "create", locator: { folder: "ohmail/News", ref: "7:3" }, raw: RAW }],
      deletes: [del("INBOX", "42:7")],
      newCursor: {
        folders: {
          INBOX: { uidValidity: "42", uidNext: 12, highestModseq: "9" },
          "ohmail/News": { uidValidity: "7", uidNext: 4, highestModseq: "1" },
        },
      },
    });
    expect(rec.forgotten).toEqual([{ folder: "INBOX", ref: "42:7" }]);
  });

  it("IGNORES a delete whose epoch is not the live one — a UIDVALIDITY change voids all evidence", async () => {
    // A reset emits every prior UID as a delete, carrying the PRIOR epoch, while re-enumerating every
    // one of them in the same batch. Those UIDs did not vanish, they were renumbered. Delete the
    // epoch comparison in `sync.ts` and this reports two forgotten instances — a whole folder's worth
    // of forged adoption evidence.
    const rec = await run({
      creates: [{ type: "create", locator: { folder: "INBOX", ref: "43:1" }, raw: RAW }],
      deletes: [del("INBOX", "42:7"), del("INBOX", "42:8")],
      newCursor: { folders: { INBOX: { uidValidity: "43", uidNext: 2, highestModseq: "0" } } },
    });
    expect(rec.forgotten).toEqual([]);
  });

  it("IGNORES a delete when no epoch can be named at all", async () => {
    // The sentinel `"0"` means "no epoch known" — a cold or truncated drain persists it deliberately.
    // Believing a delete against it would be believing a UID number with no epoch behind it, which is
    // the same class of mistake as that change one layer up. Losing evidence is the safe direction.
    const rec = await run({
      deletes: [del("INBOX", "42:7")],
      newCursor: { folders: { INBOX: { uidValidity: "0", uidNext: 0, highestModseq: "0" } } },
    });
    expect(rec.forgotten).toEqual([]);

    const unknownFolder = await run({
      deletes: [del("Archive", "42:7")],
      newCursor: { folders: { INBOX: { uidValidity: "42", uidNext: 1, highestModseq: "0" } } },
    });
    expect(unknownFolder.forgotten).toEqual([]);
  });

  it("records the disappearance BEFORE the ingest loop, so this cycle's deletes are evidence", async () => {
    // The ordering IS the fix for the two shapes `correlateMoves` cannot pair. Move the loop below
    // the ingest loop and a same-batch uncorrelated delete+create becomes an `external_copy` no-op:
    // the user's move is never adopted and `reconcileFolders` moves it back.
    const rec = await run({
      creates: [{ type: "create", locator: { folder: "ohmail/News", ref: "42:11" }, raw: RAW }],
      deletes: [del("INBOX", "42:7")],
      newCursor: {
        folders: {
          INBOX: { uidValidity: "42", uidNext: 12, highestModseq: "9" },
          "ohmail/News": { uidValidity: "42", uidNext: 12, highestModseq: "9" },
        },
      },
    });
    expect(rec.order.indexOf("forget:INBOX#42:7")).toBeGreaterThanOrEqual(0);
    expect(rec.order.indexOf("ingest")).toBeGreaterThanOrEqual(0);
    expect(rec.order.indexOf("forget:INBOX#42:7")).toBeLessThan(rec.order.indexOf("ingest"));
    // …and before the cursor write, which is the acknowledgement.
    expect(rec.order.indexOf("forget:INBOX#42:7")).toBeLessThan(rec.order.indexOf("cursor"));
  });
});
