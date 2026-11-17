import { UNMETERED_STORAGE_CAP, createLogger } from "@trafficflow/core/mail";
import { describe, it, expect } from "vitest";
import type { NativeLocator } from "@trafficflow/core";
import type { ChangeBatch, ImapCursor, MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { runSyncCycle, DELETE_EVIDENCE_PER_CYCLE } from "../src/sync.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * A CYCLE MAY ONLY RECORD ITS BUDGET OF DISAPPEARANCES.
 *
 * Every believed delete is its own fenced write, and a bulk expunge in the LIVE epoch produces one
 * per previously known UID — thousands of sequential writes ahead of the ingest loop, so the
 * mailbox stops receiving new mail until the backlog drains. The cap loses nothing: an instance
 * this cycle did not forget is still in the next cursor's known-set, so the adapter reports it
 * again, and the cap raises `hasBacklog` so the caller re-kicks instead of waiting out the poll.
 *
 * The budget is counted over the deletes the cycle BELIEVES. A UIDVALIDITY reset's prior-epoch
 * refs are refused before the counter (see `absence-evidence.test.ts` for that rule), and letting
 * them spend the budget would make a reset — the very event this bound exists for — starve the
 * real disappearances behind it.
 */
function adapterOf(batch: Partial<ChangeBatch>): MailboxAdapter {
  return {
    changesSince: async (_c: ImapCursor) => ({
      creates: [], moves: [], flagChanges: [], deletes: [],
      newCursor: { folders: {} }, hasBacklog: false, ...batch,
    }) as ChangeBatch,
  } as unknown as MailboxAdapter;
}

function repoOf(forgotten: string[]): WorkerRepo {
  const stub = {
    // The removal fence reads this inside every write transaction; the double answers what a live
    // mailbox answers (see `assertMailboxStillHere`), because absent it the fence is a TypeError.
    mailboxStatusForWrite: async (): Promise<string> => "connected",
    getMailboxFolders: async () => [],
    listKnownLocators: async () => [],
    listMessageFailures: async () => [],
    claimMessageFailures: async () => [],
    forgetInstanceAt: async (_mb: string, locator: NativeLocator) => { forgotten.push(locator.ref); },
    upsertMailboxFolder: async () => {},
    upsertMailboxFolders: async () => {},
    listPendingFolderStates: async () => [],
    listPendingFlagStates: async () => [],
    recordAudit: async () => {},
  };
  return {
    ...stub,
    transaction: async (fn: (r: WorkerRepo) => Promise<unknown>) => fn(stub as unknown as WorkerRepo),
  } as unknown as WorkerRepo;
}

const del = (ref: string) => ({ type: "delete" as const, locator: { folder: "INBOX", ref } });
const refs = (n: number, epoch: string) =>
  Array.from({ length: n }, (_, i) => del(`${epoch}:${i + 1}`));

async function run(batch: Partial<ChangeBatch>) {
  const forgotten: string[] = [];
  const lines: string[] = [];
  const out = await runSyncCycle({
    // A FIXTURE HOLDS NO ORGANIZER LEASE, and `SyncDeps.writeAuthority` is required, so it
    // says so rather than leaving the field out — an omission is the shape that let a
    // hosted cycle write to a mailbox whose lease it had never asked about.
    writeAuthority: FIXTURE_LEASE,
    repo: repoOf(forgotten), adapter: adapterOf(batch), accountId: "acct", mailboxId: "mb",
    // `role` and `trustedAuthservIds` are REQUIRED by `SyncDeps` and are named here rather than
    // cast away: an omitted role reads as ORGANIZER, which is the field's own doc's point.
    role: "organizer", trustedAuthservIds: new Set<string>(), storageCap: UNMETERED_STORAGE_CAP,
    log: createLogger({ service: "worker", level: "info", sink: (l) => lines.push(l) }),
  });
  return { forgotten, lines, out };
}

const LIVE = { folders: { INBOX: { uidValidity: "42", uidNext: 9_999, highestModseq: "9" } } };

describe("delete evidence is bounded per cycle", () => {
  it("records the budget, leaves the rest, and re-kicks", async () => {
    const over = DELETE_EVIDENCE_PER_CYCLE + 25;
    const { forgotten, lines, out } = await run({ deletes: refs(over, "42"), newCursor: LIVE });

    expect(forgotten.length).toBe(DELETE_EVIDENCE_PER_CYCLE);
    // The FIRST of the batch, in order — a cap that dropped the head would lose the oldest
    // evidence and keep re-reading it.
    expect(forgotten[0]).toBe("42:1");
    expect(forgotten.at(-1)).toBe(`42:${DELETE_EVIDENCE_PER_CYCLE}`);
    // `hasBacklog` is what makes "the rest" a promise rather than a loss: the caller re-kicks.
    expect(out.hasBacklog).toBe(true);
    const capped = lines.filter((l) => l.includes("sync_delete_evidence_capped"));
    expect(capped).toHaveLength(1);
    expect(Object.keys(JSON.parse(capped[0]!)).sort()).toEqual(
      ["accountId", "considered", "event", "level", "mailboxId", "reason", "service", "ts"],
    );
  });

  it("POSITIVE CONTROL — a cycle inside the budget records every one and reports no backlog", async () => {
    const { forgotten, lines, out } = await run({ deletes: refs(3, "42"), newCursor: LIVE });
    expect(forgotten).toEqual(["42:1", "42:2", "42:3"]);
    expect(out.hasBacklog).toBe(false);
    expect(lines.filter((l) => l.includes("sync_delete_evidence_capped"))).toEqual([]);
  });

  it("a folder the adapter re-bootstrapped is LOGGED, and the folder name is a label", async () => {
    // The adapter has no logger and reports the names on the batch; this is the line that owes
    // them a record. `INBOX` is one of the six ohmail organizes so it is named; a folder the
    // person made is `"other"`, because the field census exists to keep a person's own words out
    // of a log. This case also drives the log site at all — `folderLabel` is declared far below
    // it in the module, and a binding read before its declaration is evaluated would throw here.
    const { lines } = await run({
      deletes: [], newCursor: LIVE, rebootstrapped: ["INBOX", "Family"],
    });
    const unreadable = lines
      .filter((l) => l.includes("folder_cursor_unreadable"))
      .map((l) => JSON.parse(l) as { folderLabel: string });
    expect(unreadable.map((l) => l.folderLabel)).toEqual(["INBOX", "other"]);
  });

  it("a UIDVALIDITY reset's prior-epoch refs do not spend the budget", async () => {
    // Every one of these is refused as evidence (the epoch is not the live one), so the cycle has
    // recorded nothing and owes nothing — the reset is not a backlog.
    const { forgotten, out } = await run({
      deletes: refs(DELETE_EVIDENCE_PER_CYCLE + 25, "41"), newCursor: LIVE,
    });
    expect(forgotten).toEqual([]);
    expect(out.hasBacklog).toBe(false);
  });
});
