import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JOURNALS, journalCollisions, nextFree } from "../scripts/migration-numbers.mjs";

/**
 * ONE NUMBER, ONE ENTRY, ON EVERY JOURNAL.
 *
 * Two pull requests that each cut the next migration pass every test on their own and in either merge
 * order; merged, one journal holds two entries with one number and a device that applied the first
 * applies the second out of order. The census refuses that on the tree; `--open-prs` shows a lane the
 * numbers open pull requests already hold before it cuts one. The shipped device 0138 pair is the one
 * admitted collision, by both names.
 */
function tree(files: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), "migration-numbers-"));
  for (const j of JOURNALS) mkdirSync(join(root, j.dir), { recursive: true });
  for (const [dir, names] of Object.entries(files)) for (const n of names) writeFileSync(join(root, dir, n), "");
  return root;
}

const DEVICE = "packages/db-mail/drizzle-sqlite";
const SHARED = "packages/db-mail/drizzle";
const CLOUD = "packages/db/drizzle-cloud";

describe("the migration number census", () => {
  it("holds on this tree", () => {
    expect(journalCollisions(fileURLToPath(new URL("..", import.meta.url)))).toEqual([]);
  });

  it("refuses two 0176 entries on the device journal", () => {
    const root = tree({ [DEVICE]: ["0175_device_part_words.sql", "0176_messages_unconfirmed_hold.sql", "0176_device_stopword_stems.sql"] });
    expect(journalCollisions(root)).toEqual([
      { dir: DEVICE, number: "0176", files: ["0176_device_stopword_stems.sql", "0176_messages_unconfirmed_hold.sql"] },
    ]);
  });

  it("counts a stated no-op as the number's entry", () => {
    const root = tree({ [DEVICE]: ["0176.noop", "0176_device_stopword_stems.sql"] });
    expect(journalCollisions(root).map((c) => c.number)).toEqual(["0176"]);
  });

  it("admits the shipped 0138 pair by name and nothing beside it", () => {
    const pair = ["0138_auto_filing_undone_at.sql", "0138_device_search_stems.sql"];
    expect(journalCollisions(tree({ [DEVICE]: pair }))).toEqual([]);
    expect(journalCollisions(tree({ [DEVICE]: [...pair, "0138_third.sql"] })).map((c) => c.files.length)).toEqual([3]);
    expect(journalCollisions(tree({ [SHARED]: pair })).map((c) => c.dir)).toEqual([SHARED]);
  });
});

describe("the next free number across open pull requests", () => {
  const root = tree({
    [SHARED]: ["0175_part_words.sql", "0176_messages_unconfirmed_hold.sql"],
    [DEVICE]: ["0175_device_part_words.sql", "0176_messages_unconfirmed_hold.sql"],
    [CLOUD]: ["0055_account_storage_holds.sql"],
  });

  it("is one past the tree when nothing is open", () => {
    expect(nextFree(root, [])).toMatchObject({ mail: { next: "0177", clashes: [] }, cloud: { next: "0056", clashes: [] } });
  });

  it("steps past every number an open pull request adds, per sequence", () => {
    const prs = [
      { number: 7, files: [`${SHARED}/0177_a.sql`, `${DEVICE}/0177.noop`, "apps/x.ts"] },
      { number: 9, files: [`${DEVICE}/0178_device_b.sql`, `${CLOUD}/0056_c.sql`] },
    ];
    expect(nextFree(root, prs)).toMatchObject({ mail: { next: "0179", clashes: [] }, cloud: { next: "0057", clashes: [] } });
  });

  it("names a number two pull requests claim, and one the tree already holds", () => {
    const prs = [
      { number: 616, files: [`${SHARED}/0177_hold.sql`, `${DEVICE}/0177_hold.sql`] },
      { number: 640, files: [`${DEVICE}/0177_device_stopword_stems.sql`] },
      { number: 641, files: [`${DEVICE}/0176_device_late.sql`] },
    ];
    expect(nextFree(root, prs).mail.clashes).toEqual([
      { number: "0176", holders: ["main", "#641"] },
      { number: "0177", holders: ["#616", "#640"] },
    ]);
  });
});
