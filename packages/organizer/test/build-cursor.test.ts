import { describe, it, expect } from "vitest";
import type { KnownLocator, WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { buildCursor } from "../src/sync.js";
import { DeadLetterLedger } from "../src/dead-letter.js";

type FolderRow = { folder: string; uidValidity: string; uidNext: number; highestModseq: string };

/** `buildCursor` reads exactly two things; a fake that offers more would prove less. */
function repoOf(folders: FolderRow[], known: KnownLocator[]): WorkerRepo {
  return {
    getMailboxFolders: async () => folders,
    listKnownLocators: async () => known,
  } as unknown as WorkerRepo;
}

const loc = (uid: number, uidValidity: string, messageId: string | null = null): KnownLocator =>
  ({ folder: "INBOX", uid, uidValidity, messageId });

/**
 * The epoch arithmetic of that change, at the level where every branch is reachable. The GreenMail file
 * (`uidvalidity-reset.e2e.test.ts`) proves the three states that can actually occur against a
 * server; this one reaches the branch that only a crash window produces.
 */
describe("buildCursor — the known-set names an epoch", () => {
  it("hands over only the entries of the epoch the folder row names", async () => {
    const cursor = await buildCursor(
      repoOf([{ folder: "INBOX", uidValidity: "20", uidNext: 9, highestModseq: "5" }],
        [loc(1, "20", "keep@x"), loc(2, "19", "stale@x"), loc(3, "20", "keep2@x")]),
      "mb",
    );
    expect(cursor.folders["INBOX"]).toMatchObject({ uidValidity: "20", uidNext: 9, highestModseq: "5" });
    expect(cursor.folders["INBOX"]!.known.map((k) => k.uid).sort()).toEqual([1, 3]);
  });

  it("takes the epoch from the locators when the row is the sentinel", async () => {
    const cursor = await buildCursor(
      repoOf([{ folder: "INBOX", uidValidity: "0", uidNext: 0, highestModseq: "0" }],
        [loc(1, "20"), loc(2, "20")]),
      "mb",
    );
    // The whole point: the cursor now CAN express a mismatch, which the sentinel never could.
    expect(cursor.folders["INBOX"]!.uidValidity).toBe("20");
    expect(cursor.folders["INBOX"]!.known.map((k) => k.uid).sort()).toEqual([1, 2]);
  });

  /**
   * The branch only a crash produces: commits from two epochs, no cursor write between them. No
   * epoch can be named, so nothing may be presented as known — one pass of re-enumeration, and
   * `runSyncCycle` then persists the epoch it observed so the next pass can name it. Re-fetching is
   * the recoverable mistake; presenting an old epoch's number as known under the new one is not.
   */
  it("trusts nothing when the remembered locators disagree about the epoch", async () => {
    const cursor = await buildCursor(
      repoOf([{ folder: "INBOX", uidValidity: "0", uidNext: 0, highestModseq: "0" }],
        [loc(1, "19"), loc(2, "20")]),
      "mb",
    );
    expect(cursor.folders["INBOX"]!.uidValidity).toBe("0");
    expect(cursor.folders["INBOX"]!.known).toEqual([]);
  });

  it("still starts cold when nothing is remembered at all", async () => {
    const cursor = await buildCursor(repoOf([], []), "mb");
    expect(cursor.folders["INBOX"]).toEqual({ uidValidity: "0", uidNext: 0, highestModseq: "0", known: [] });
  });

  it("merges written-off UIDs into the known-set of their own epoch only", async () => {
    const ledger = new DeadLetterLedger();
    ledger.record({ folder: "INBOX", ref: "20:7" }, { code: "mime_too_large", deterministic: true });
    ledger.record({ folder: "INBOX", ref: "19:8" }, { code: "mime_too_large", deterministic: true });

    const cursor = await buildCursor(
      repoOf([{ folder: "INBOX", uidValidity: "20", uidNext: 9, highestModseq: "5" }], [loc(1, "20")]),
      "mb", ledger,
    );
    expect(cursor.folders["INBOX"]!.known.map((k) => k.uid).sort()).toEqual([1, 7]);
  });
});
