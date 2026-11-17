import { describe, it, expect } from "vitest";
import type { KnownLocator, WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { buildCursor, newCycleCensus } from "../src/sync.js";
import { KnownSetCache, watchKnownSet } from "../src/known-set.js";

/**
 * AN IDLE CYCLE'S COST IS PROPORTIONAL TO WHAT CHANGED, AND WHEN NOTHING CHANGED IT IS A
 * COMPARISON.
 *
 * `buildCursor` used to read the whole projection and re-derive every folder's known list on every
 * cycle. With the memo warm and its derivation still valid it now reads nothing, walks no rows and
 * rebuilds no array — and the counters say so, which is what makes the claim checkable from a log
 * line on a real install rather than from this file alone.
 *
 * Every refusal below has its positive control beside it: a mailbox that MOVED still pays the full
 * price, because the alternative to a slow idle tick is mail that never arrives.
 */

type FolderRow = { folder: string; uidValidity: string; uidNext: number; highestModseq: string };

/** The rows `buildCursor` reads, and a count of how often it went for them. */
function repoOf(folders: FolderRow[], known: KnownLocator[]): {
  repo: WorkerRepo; reads: () => number;
} {
  let reads = 0;
  const repo = {
    getMailboxFolders: async () => folders,
    listKnownLocators: async () => { reads += 1; return known; },
    // One DIRTY method, so the memo can be moved the way production moves it.
    insertMessage: async () => undefined,
  } as unknown as WorkerRepo;
  return { repo, reads: () => reads };
}

const FOLDERS: FolderRow[] = [
  { folder: "INBOX", uidValidity: "42", uidNext: 900, highestModseq: "7" },
  { folder: "Archive", uidValidity: "42", uidNext: 300, highestModseq: "3" },
];

/** A mailbox big enough that "proportional to the mailbox" is a different number from "a few". */
const LOCATORS: KnownLocator[] = Array.from({ length: 4000 }, (_, i) => ({
  folder: i % 4 === 0 ? "Archive" : "INBOX",
  uid: i + 1,
  uidValidity: "42",
  messageId: `m${i}@rig.test`,
  seen: false,
})) as unknown as KnownLocator[];

describe("an idle cycle over an unchanged mailbox", () => {
  it("reads nothing, walks no rows and derives nothing the second time", async () => {
    const { repo, reads } = repoOf(FOLDERS, LOCATORS);
    const cache = new KnownSetCache("mb");
    const watched = watchKnownSet(repo, cache);

    const first = newCycleCensus();
    const a = await buildCursor(watched, "mb", undefined, first, cache);
    expect(first.locatorReads).toBe(1);
    expect(first.locatorRows).toBe(LOCATORS.length);
    // The two folders that NAME an epoch. The rest of the watched set has no row and no locator,
    // so no epoch can be named and nothing may be presented as known — there is nothing to derive.
    expect(first.cursorFolders).toBe(FOLDERS.length);
    expect(reads()).toBe(1);

    const second = newCycleCensus();
    const b = await buildCursor(watched, "mb", undefined, second, cache);
    // THE WHOLE CLAIM, in four numbers.
    expect(second.locatorReads).toBe(0);
    expect(second.locatorRows).toBe(0);
    expect(second.cursorFolders).toBe(0);
    expect(reads()).toBe(1);

    // And it is the same answer, not a cheaper one: the arrays a folder that names an epoch is
    // handed are the very objects, and every folder's light half is rebuilt from the rows as it
    // always was. A folder that names no epoch is handed a fresh empty list either way — there is
    // nothing there to memoize and nothing it could cost.
    for (const name of Object.keys(a.folders)) {
      const held = a.folders[name]!.known;
      if (held.length > 0) expect(b.folders[name]!.known).toBe(held);
      else expect(b.folders[name]!.known).toEqual([]);
      expect(b.folders[name]!.uidNext).toBe(a.folders[name]!.uidNext);
      expect(b.folders[name]!.uidValidity).toBe(a.folders[name]!.uidValidity);
    }
    expect(a.folders["INBOX"]!.known.length).toBeGreaterThan(0);
  });

  it("still does the whole thing when the mailbox moved", async () => {
    const { repo, reads } = repoOf(FOLDERS, LOCATORS);
    const cache = new KnownSetCache("mb");
    const watched = watchKnownSet(repo, cache) as unknown as
      WorkerRepo & { insertMessage: () => Promise<void> };

    await buildCursor(watched, "mb", undefined, newCycleCensus(), cache);
    expect(reads()).toBe(1);
    // A write the projection can see — exactly what drops the memo in production.
    await watched.insertMessage();

    const after = newCycleCensus();
    await buildCursor(watched, "mb", undefined, after, cache);
    expect(after.locatorReads).toBe(1);
    expect(after.locatorRows).toBe(LOCATORS.length);
    expect(after.cursorFolders).toBe(FOLDERS.length);
    expect(reads()).toBe(2);
  });

  it("still does the whole thing when a folder's epoch moved", async () => {
    const folders = FOLDERS.map((f) => ({ ...f }));
    const { repo, reads } = repoOf(folders, LOCATORS);
    const cache = new KnownSetCache("mb");
    const watched = watchKnownSet(repo, cache);

    await buildCursor(watched, "mb", undefined, newCycleCensus(), cache);
    expect(reads()).toBe(1);
    // The server reset INBOX's uidvalidity. Nothing wrote to the store, so the memo still holds —
    // and the derivation it holds is for the OLD epoch, which may not be handed over.
    folders[0]!.uidValidity = "43";

    const after = newCycleCensus();
    const c = await buildCursor(watched, "mb", undefined, after, cache);
    // No STORE read — nothing wrote, so the memo still answers — but every row is walked again
    // and every folder rebuilt, because the arrays it holds are for an epoch that is gone.
    expect(after.locatorReads).toBe(0);
    expect(after.locatorRows).toBe(LOCATORS.length);
    // ONE folder, not both: the derivation is keyed per folder AND epoch, so Archive — which did
    // not move — is still handed over from the memo.
    expect(after.cursorFolders).toBe(1);
    expect(c.folders["INBOX"]!.uidValidity).toBe("43");
    // Nothing remembered belongs to the new epoch, so nothing is presented as known.
    expect(c.folders["INBOX"]!.known).toEqual([]);
  });

  /**
   * THE DIRECTION AN OMISSION MUST FAIL IN. A caller that supplies no memo — the reconcile
   * backstop, every test that predates one — reads and derives on every call, byte for byte what
   * this function did before any of this existed.
   */
  it("reads and derives every time for a caller with no memo", async () => {
    const { repo, reads } = repoOf(FOLDERS, LOCATORS);
    for (let i = 1; i <= 3; i++) {
      const census = newCycleCensus();
      await buildCursor(repo, "mb", undefined, census, undefined);
      expect(census.locatorReads).toBe(1);
      expect(census.locatorRows).toBe(LOCATORS.length);
      expect(census.cursorFolders).toBe(FOLDERS.length);
      expect(reads()).toBe(i);
    }
  });
});
