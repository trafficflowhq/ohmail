import type { FolderEntity } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { RECENT_SIZE, SHELF_SIZE, shelfKeyOf, shelfOf, treeOrder, usedNow } from "../../src/folder/shelf.js";

/** THE RAIL'S FOLDER SHELF: pinned, the open one, the ones used last, then the tree's first; seven at most. */

const folder = (name: string, mailboxId = "mb"): FolderEntity => ({
  id: `${mailboxId}:${name}`,
  name,
  mailboxId,
  mailbox: `${mailboxId}@ex.example`,
});
const names = (list: readonly FolderEntity[]) => list.map((f) => `${f.mailboxId}|${f.name}`);

const TREE = [
  folder("Workshops"),
  folder("Clients/Gartenlokal Rosa"),
  folder("Clients"),
  folder("Archive"),
  folder("Steuern 2010"),
  folder("Steuern 2009"),
  folder("Projects", "mb2"),
  folder("Receipts 2026"),
  folder("Zines"),
];

describe("the folder shelf", () => {
  it("is the tree's first level while nothing is pinned, open or used: each mailbox's own tree, in order", () => {
    expect(names(treeOrder(TREE))).toEqual([
      "mb|Archive",
      "mb|Clients",
      "mb|Clients/Gartenlokal Rosa",
      "mb|Receipts 2026",
      "mb|Steuern 2009",
      "mb|Steuern 2010",
      "mb|Workshops",
      "mb|Zines",
      "mb2|Projects",
    ]);
    const shelf = shelfOf(TREE, { pinned: [], recent: [], open: null });
    expect(shelf).toHaveLength(SHELF_SIZE);
    expect(names(shelf)).toEqual([
      "mb|Archive",
      "mb|Clients",
      "mb|Receipts 2026",
      "mb|Steuern 2009",
      "mb|Steuern 2010",
      "mb|Workshops",
      "mb|Zines",
    ]);
  });

  it("stands the pinned ones first as pinned, then the open one, then the ones used last, each once", () => {
    const shelf = shelfOf(TREE, {
      pinned: ["mb|Zines", "mb2|Projects"],
      open: "mb|Workshops",
      recent: ["mb|Zines", "mb|Steuern 2010", "mb|Workshops"],
    });
    expect(names(shelf)).toEqual([
      "mb|Zines",
      "mb2|Projects",
      "mb|Workshops",
      "mb|Steuern 2010",
      "mb|Archive",
      "mb|Clients",
      "mb|Receipts 2026",
    ]);
  });

  it("leaves out what the mirror does not hold (a folder deleted elsewhere), and never passes seven", () => {
    const many = Array.from({ length: 9 }, (_, i) => `mb|Pinned ${i}`);
    const folders = [...TREE, ...many.map((k) => folder(k.slice(3)))];
    const shelf = shelfOf(folders, { pinned: ["mb|Gone", ...many], recent: [], open: "mb|Gone too" });
    expect(shelf).toHaveLength(SHELF_SIZE);
    expect(names(shelf)).toEqual(many.slice(0, SHELF_SIZE));
  });

  it("keeps the open folder on the shelf: while one is open the pins take six places, unless it is one of them", () => {
    const many = Array.from({ length: 9 }, (_, i) => `mb|Pinned ${i}`);
    const folders = [...TREE, ...many.map((k) => folder(k.slice(3)))];
    const shelf = shelfOf(folders, { pinned: many, recent: [], open: "mb|Workshops" });
    expect(names(shelf)).toEqual([...many.slice(0, SHELF_SIZE - 1), "mb|Workshops"]);
    const pinnedOpen = shelfOf(folders, { pinned: many, recent: [], open: "mb|Pinned 2" });
    expect(names(pinnedOpen)).toEqual(many.slice(0, SHELF_SIZE));
  });

  it("keeps the ones used last newest first, once each, twelve at most", () => {
    const twelve = Array.from({ length: RECENT_SIZE }, (_, i) => `mb|Kept ${i}`);
    expect(usedNow(twelve, "mb|Kept 5", [])).toEqual([
      "mb|Kept 5",
      ...twelve.filter((k) => k !== "mb|Kept 5"),
    ]);
    const next = usedNow(twelve, "mb|New", []);
    expect(next).toHaveLength(RECENT_SIZE);
    expect(next[0]).toBe("mb|New");
    expect(next).not.toContain(`mb|Kept ${RECENT_SIZE - 1}`);
    expect(shelfKeyOf(folder("Clients/Gartenlokal Rosa"))).toBe("mb|Clients/Gartenlokal Rosa");
  });

  it("leaves the ones used last as they stand for a pinned folder, or one among the first four (a row that stands does not jump)", () => {
    const twelve = Array.from({ length: RECENT_SIZE }, (_, i) => `mb|Kept ${i}`);
    expect(usedNow(twelve, "mb|Kept 3", [])).toEqual(twelve);
    expect(usedNow(twelve, "mb|Kept 0", [])).toEqual(twelve);
    expect(usedNow(twelve, "mb|Pinned", ["mb|Pinned"])).toEqual(twelve);
    expect(usedNow(twelve, "mb|Kept 7", ["mb|Kept 7"])).toEqual(twelve);
    expect(usedNow(twelve, "mb|Kept 4", [])[0]).toBe("mb|Kept 4");
  });
});
