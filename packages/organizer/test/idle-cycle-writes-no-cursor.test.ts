import { describe, it, expect } from "vitest";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import type { ChangeBatch, ImapCursor, MailboxAdapter, PersistedFolderCursor } from "@trafficflow/core/adapters/imap";
import type { WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { runSyncCycle } from "../src/sync.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * A CYCLE WRITES A FOLDER CURSOR ONLY WHEN IT MOVED. Every folder's row was rewritten every cycle,
 * one fenced transaction each; now the cycle compares the pass's cursor with the row it read at
 * the start and writes the folders that differ, all of them in one fenced group.
 */

type Stored = { folder: string } & PersistedFolderCursor;

async function cycle(stored: Stored[], folders: Record<string, PersistedFolderCursor>): Promise<{
  groups: Array<Array<{ folder: string; cursor: PersistedFolderCursor }>>; threw: unknown;
}> {
  const groups: Array<Array<{ folder: string; cursor: PersistedFolderCursor }>> = [];
  const stub = {
    mailboxStatusForWrite: async (): Promise<string> => "connected",
    getMailboxFolders: async () => stored,
    listKnownLocators: async () => [],
    listMessageFailures: async () => [],
    claimMessageFailures: async () => [],
    upsertMailboxFolder: async (_mb: string, folder: string, cursor: PersistedFolderCursor) => { groups.push([{ folder, cursor }]); },
    upsertMailboxFolders: async (_mb: string, entries: Array<{ folder: string; cursor: PersistedFolderCursor }>) => { groups.push([...entries]); },
    setMailboxBudgetStop: async () => {},
    listPendingFolderStates: async () => [],
    listPendingFlagStates: async () => [],
    recordAudit: async () => {},
  };
  const repo = { ...stub, transaction: async (fn: (r: WorkerRepo) => Promise<unknown>) => fn(stub as unknown as WorkerRepo) };
  const adapter = {
    changesSince: async (_c: ImapCursor) => ({
      creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders }, hasBacklog: false,
    }) as unknown as ChangeBatch,
  } as unknown as MailboxAdapter;
  let threw: unknown = null;
  try {
    await runSyncCycle({
      writeAuthority: FIXTURE_LEASE, repo: repo as unknown as WorkerRepo, adapter,
      accountId: "acct", mailboxId: "mb", role: "organizer", trustedAuthservIds: new Set<string>(),
      storageCap: UNMETERED_STORAGE_CAP,
    });
  } catch (err) { threw = err; }
  return { groups, threw };
}

const INBOX: Stored = { folder: "INBOX", uidValidity: "42", uidNext: 900, highestModseq: "7", serverExists: 880 };
const ARCHIVE: Stored = { folder: "Archive", uidValidity: "42", uidNext: 300, highestModseq: "3", serverExists: 290 };
const cursorOf = ({ folder: _f, ...c }: Stored): PersistedFolderCursor => c;

describe("the folder cursor write", () => {
  it("an idle cycle over unchanged folders writes no cursor row", async () => {
    const r = await cycle([INBOX, ARCHIVE], { INBOX: cursorOf(INBOX), Archive: cursorOf(ARCHIVE) });
    expect(r.threw).toBeNull();
    expect(r.groups).toEqual([]);
    // The passive fast path reports no count: absent leaves the stored one, so it is no change either.
    const passive = await cycle([INBOX], { INBOX: { uidValidity: "42", uidNext: 900, highestModseq: "7" } });
    expect(passive.groups).toEqual([]);
  });

  it("one moved folder is one write, and every moved folder rides one group", async () => {
    const one = await cycle([INBOX, ARCHIVE], { INBOX: { ...cursorOf(INBOX), uidNext: 901 }, Archive: cursorOf(ARCHIVE) });
    expect(one.groups).toEqual([[{ folder: "INBOX", cursor: { ...cursorOf(INBOX), uidNext: 901 } }]]);

    const three = await cycle([INBOX, ARCHIVE], {
      INBOX: { ...cursorOf(INBOX), highestModseq: "8" },
      Archive: { ...cursorOf(ARCHIVE), serverExists: 291 },
      "Sent Items": { uidValidity: "9", uidNext: 12, highestModseq: "0" },
    });
    expect(three.groups).toHaveLength(1);
    expect(three.groups[0]!.map((e) => e.folder).sort()).toEqual(["Archive", "INBOX", "Sent Items"]);
  });

  it("a new epoch is a write even where the watermarks look the same", async () => {
    const r = await cycle([INBOX], { INBOX: { ...cursorOf(INBOX), uidValidity: "43" } });
    expect(r.groups.flat().map((e) => e.folder)).toEqual(["INBOX"]);
  });
});
