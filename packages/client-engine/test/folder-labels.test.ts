import { describe, expect, it } from "vitest";
import { guardFrom, PUBLIC_GUARD, type GuardLists } from "@ohmail/testing";
import { FOLDER_OF_VIEW, VIEW_OF_FOLDER, folderLeaf, type Folder } from "@ohmail/client-engine";
import { maskEntries, privateGuardText, privateModeIt } from "../../../test/support/guard-list.js";

const guard = guardFrom(privateGuardText());

/** The entries a folder path carries, by INDEX. */
function bannedIn(folder: string, lists: GuardLists): number[] {
  const path = folder.toLowerCase();
  return lists.shared.flatMap((term, i) => (path.includes(term) ? [i] : []));
}

/** A red's lines, `<folder>: entry #<i>`: the folder IS what carries the entry, so it is masked. */
const hitLines = (folders: readonly string[], lists: GuardLists): string[] =>
  folders.flatMap((folder) => bannedIn(folder, lists).map((i) => `${maskEntries(folder, lists)}: entry #${i}`));

/**
 * The entries a red would QUOTE: each planted alone, upper-cased, in a folder name that also carries
 * the first shared entry (so a corpus-only plant reds too). The red names each shared plant by its
 * index and quotes no entry at all.
 */
function quotedInRed(lists: GuardLists): number[] {
  const all = [...lists.shared, ...lists.corpusOnly];
  expect(lists.shared.length).toBeGreaterThan(0);
  return all.flatMap((term, i) => {
    const lines = hitLines([`ohmail/${lists.shared[0]!.toUpperCase()} ${term.toUpperCase()} Archive`], lists);
    const named = i >= lists.shared.length || lines.some((l) => l.endsWith(`: entry #${i}`));
    const quoted = all.some((t) => lines.join("\n").toLowerCase().includes(t));
    return lines.length > 0 && named && !quoted ? [] : [i];
  });
}

/** The entries the scan MISSED when each was planted alone, upper-cased, in a folder path. */
function missedWhenPlanted(lists: GuardLists): number[] {
  expect(lists.shared.length).toBeGreaterThan(0);
  return lists.shared.flatMap((term, i) =>
    bannedIn(`ohmail/${term.toUpperCase()} Archive`, lists).includes(i) ? [] : [i],
  );
}

/**
 * The IMAP folder namespace is the most durable copy the product writes: these
 * folders are created inside the customer's own mailbox and stay there after
 * they leave. It was renamed from the pre-rebrand company name to `ohmail/…`
 * on 2026-07-31, while zero real mailboxes were connected (see "Folder
 * namespace rebrand" in the project's design notes).
 *
 * Two properties are pinned here. First, the namespace itself is the product's
 * own vocabulary — no banned term anywhere in the PATH, not merely in the leaf,
 * so a regression cannot reintroduce a prefix that only the fallback hides.
 * Second, the rule that made the old namespace survivable is kept because it is
 * good regardless: no view may ever put a raw folder string on screen.
 */
describe("folder labels never leak the namespace", () => {
  const allFolders = Object.values(FOLDER_OF_VIEW) as Folder[];

  it("covers every folder the client knows", () => {
    // Guards the tests below against silently thinning out if a folder is added. VIEW_OF_FOLDER
    // carries ONE extra key since 0.22: the News pile's legacy spelling, admitted for mirror
    // rows written before the folder rename — a read-side alias, not a folder a view files to.
    expect(allFolders.length).toBe(Object.keys(VIEW_OF_FOLDER).length - 1);
    expect(allFolders.length).toBeGreaterThanOrEqual(6);
  });

  it("the FULL path of every declared folder is free of every banned term", () => {
    // Strictly stronger than the leaf check this test used to make: the whole
    // string, because the prefix is what the customer sees in Apple Mail.
    expect(hitLines(allFolders, guard)).toEqual([]);
  });

  privateModeIt(
    "PRIVATE MODE — every private entry planted in a folder path is caught",
    () => {
      expect(guard.mode, "the run names the private list, and this scan reads it").toBe("private");
      expect(missedWhenPlanted(guard), "private entries missed, by index").toEqual([]);
    },
  );

  it("PUBLIC SET — every synthetic entry planted in a folder path is caught", () => {
    expect(missedWhenPlanted(PUBLIC_GUARD), "synthetic entries missed, by index").toEqual([]);
  });

  privateModeIt(
    "PRIVATE MODE — a red masks a private entry in a folder name and quotes none",
    () => {
      expect(guard.mode, "the run names the private list, and this scan reads it").toBe("private");
      expect(quotedInRed(guard), "private entries quoted, by index").toEqual([]);
    },
  );

  it("PUBLIC SET — a red masks a synthetic entry in a folder name and quotes none", () => {
    expect(quotedInRed(PUBLIC_GUARD), "synthetic entries quoted, by index").toEqual([]);
  });

  it("every namespaced folder sits under the product's own prefix", () => {
    const namespaced = allFolders.filter((f) => f.includes("/"));
    expect(namespaced.length).toBe(allFolders.length - 1); // all but INBOX
    for (const folder of namespaced) expect(folder.startsWith("ohmail/")).toBe(true);
  });

  it("the leaves are the product's words, not another product's", () => {
    // Feed → Reads and Paper Trail → Receipts landed with the namespace.
    expect(allFolders).toContain("ohmail/News");
    expect(allFolders).toContain("ohmail/Receipts");
    expect(allFolders as string[]).not.toContain("ohmail/Feed");
    expect(allFolders as string[]).not.toContain("ohmail/Paper Trail");
  });

  it("keeps the readable part of the name", () => {
    expect(folderLeaf("ohmail/Receipts")).toBe("Receipts");
    expect(folderLeaf("ohmail/Quarantine")).toBe("Quarantine");
    expect(folderLeaf("INBOX")).toBe("INBOX");
  });

  it("survives the folder shapes a real server sends", () => {
    // Unknown folders are expected (contract §8), and users nest their own.
    expect(folderLeaf("Archive/2026/Q1")).toBe("Q1");
    expect(folderLeaf("Archive/2026/")).toBe("2026"); // trailing delimiter
    expect(folderLeaf("INBOX.Sent")).toBe("INBOX.Sent"); // dot-delimited server
    expect(folderLeaf("/")).toBe("/"); // degenerate input still renders something
    expect(folderLeaf("")).toBe("");
  });
});
