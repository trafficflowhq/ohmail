/**
 * THE FOLDER RAIL's PURE DERIVATIONS, held where the seated folder's rail and shelf read them
 * (`folder/shelf.ts`, `folder/FolderRail.tsx`): the cases of today's rail test
 * (`apps/webapp/test/folders-rail.test.tsx`, "the pure derivations behind the rows"), by their names, over the same
 * module, unchanged. They stand here because their first file mounts today's rail, which leaves with today's shell.
 */
import { describe, expect, it } from "vitest";
import type { FolderEntity } from "@ohmail/wire";
import {
  folderMatches,
  folderTailVerdict,
  folderTree,
  folderUnreadCounts,
  folderUnreadDeep,
  visibleFolderRows,
} from "../../src/lists/folders.js";

function folder(name: string, mailboxId = "mb1", mailbox = "a@x.example"): FolderEntity {
  return { id: `f-${mailboxId}-${name}`, name, mailboxId, mailbox };
}

describe("the pure derivations behind the rows", () => {
  it("folderUnreadCounts is one pass, keyed by mailbox — two mailboxes' same-named folders never merge", () => {
    const counts = folderUnreadCounts([
      { mailboxId: "mb1", folder: "Projects", unread: true },
      { mailboxId: "mb2", folder: "Projects", unread: true },
      { mailboxId: "mb1", folder: "Projects", unread: false },
    ] as never[]);
    expect(counts.get("mb1|Projects")).toBe(1);
    expect(counts.get("mb2|Projects")).toBe(1);
  });

  it("folderUnreadDeep counts descendants once and never a sibling's", () => {
    const folders = [folder("A"), folder("A/B"), folder("AB")];
    const counts = new Map([
      ["mb1|A", 1],
      ["mb1|A/B", 2],
      ["mb1|AB", 8],
    ]);
    // "AB" starts with "A" but is a SIBLING — the descendant test is path-segment-aware.
    expect(folderUnreadDeep("mb1", "A", counts, folders)).toBe(3);
  });

  it("an orphaned path renders as a root (IMAP allows children of non-existent mailboxes)", () => {
    const tree = folderTree([folder("Ghost/Child")]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.depth).toBe(0);
  });

  it("visibleFolderRows hides exactly the closed subtrees", () => {
    const tree = folderTree([folder("A"), folder("A/B"), folder("A/B/C"), folder("Z")]);
    const rows = visibleFolderRows(
      tree,
      (p) => p === "A",
      (p) => p === "A" || p === "A/B",
    );
    expect(rows.map((r) => r.folder.name)).toEqual(["A", "A/B", "Z"]);
  });

  it("folderTailVerdict: the live entity judges fully; an absent one judges NOTHING", () => {
    // The reach-past's overlap word, branch by branch. The absent-entity branch is the
    // review-earned part, in its final shape: while the scope is not readable NOTHING is
    // judged — no ban, no clear — because a move that ends in a prune during the gap erases
    // its own evidence, and the gap is settled by the hook's scopeEpoch reset instead.
    const inF = { mailboxId: "mb1", folder: "Projects" } as never;
    const elsewhere = { mailboxId: "mb1", folder: "Archive" } as never;
    const entity = folder("Projects");

    // Not held by the mirror at all → the fetched copy shows.
    expect(folderTailVerdict(undefined, "fd1", entity)).toBe("show");
    // No folder scope, or the entity absent → hold, whatever the message row says.
    expect(folderTailVerdict(inF, undefined, undefined)).toBe("hold");
    expect(folderTailVerdict(inF, "fd1", undefined)).toBe("hold");
    expect(folderTailVerdict(elsewhere, "fd1", undefined)).toBe("hold");
    // Entity present → the mirror's full word.
    expect(folderTailVerdict(inF, "fd1", entity)).toBe("hide");
    expect(folderTailVerdict(elsewhere, "fd1", entity)).toBe("ban");
    // Same-name folder on ANOTHER mailbox never reads as this scope.
    expect(folderTailVerdict({ mailboxId: "mb2", folder: "Projects" } as never, "fd1", entity)).toBe("ban");
  });

  it("folderMatches is a substring of the full canonical path", () => {
    expect(folderMatches("Projects/Acme", "acme")).toBe(true);
    expect(folderMatches("Projects/Acme", "projects/a")).toBe(true);
    expect(folderMatches("Projects/Acme", "invoices")).toBe(false);
  });
});
