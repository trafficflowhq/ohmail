import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CLOUD_JOURNAL, MAIL_JOURNAL } from "../src/journal-specs.js";
import { OLD_HEADS, TRANSITION_WINDOW } from "../src/journal-heads.js";
import { WINDOW_LENGTH, WindowMalformed, namesOfWindow, readWindow, type EntryName } from "../src/transition/index.js";

/**
 * THE WINDOW THE TRANSITION APPLIES: six entries of each journal, read from the journal's own
 * files, and what their statements need to find and need to be free. The reader of names is held
 * by a fixture written from the entries as they stand: an entry edited, or a statement of a kind
 * the reader does not know, is red here until the fixture has been read again.
 */
const folders: string[] = [];
afterAll(() => { for (const dir of folders) rmSync(dir, { recursive: true, force: true }); });

type Journal = { entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[] };
/** A journal in a folder of its own, its entry list edited. */
function withEntries(spec: typeof MAIL_JOURNAL, edit: (j: Journal, dir: string) => void): typeof MAIL_JOURNAL {
  const dir = mkdtempSync(join(tmpdir(), `ohmail-window-${spec.name}-`));
  folders.push(dir);
  cpSync(spec.dir, dir, { recursive: true });
  const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as Journal;
  edit(journal, dir);
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal));
  return { ...spec, dir };
}

const said = (n: EntryName): string => `${n.journal} ${n.entry.slice(0, 4)} ${n.kind} ${n.table ? `${n.table}.` : ""}${n.name}`;
const shipped = () => namesOfWindow([...readWindow("mail"), ...readWindow("cloud")]);

describe("the window", () => {
  it("is six entries of each journal, numbered on from the line's start, stamped above the old head and rising", () => {
    for (const [journal, first] of [["mail", "0200_"], ["cloud", "0100_"]] as const) {
      const window = readWindow(journal);
      expect(window).toHaveLength(WINDOW_LENGTH);
      expect(window[0]!.tag.startsWith(first)).toBe(true);
      expect(window.at(-1)!.tag).toBe(TRANSITION_WINDOW[journal].last);
      expect(window[0]!.when).toBeGreaterThan(OLD_HEADS[journal].when);
      expect(window.every((e, i) => i === 0 || e.when > window[i - 1]!.when)).toBe(true);
      expect(window.every((e) => /^[0-9a-f]{64}$/.test(e.hash) && e.statements.length > 0)).toBe(true);
    }
  });

  it("is refused when an entry is missing, when one is stamped out of order, and when a file is gone", () => {
    const gap = withEntries(MAIL_JOURNAL, (j) => { j.entries = j.entries.filter((e) => !e.tag.startsWith("0203_")); });
    expect(() => readWindow("mail", gap)).toThrow(WindowMalformed);
    const order = withEntries(CLOUD_JOURNAL, (j) => {
      const at = j.entries.findIndex((e) => e.tag.startsWith("0103_"));
      j.entries[at]!.when = j.entries[at - 1]!.when;
    });
    expect(() => readWindow("cloud", order)).toThrow(/stamped at or below what precedes it/);
    const below = withEntries(MAIL_JOURNAL, (j) => { j.entries.find((e) => e.tag.startsWith("0200_"))!.when = OLD_HEADS.mail.when; });
    expect(() => readWindow("mail", below)).toThrow(WindowMalformed);
    // An entry numbered past the window is an ordinary migration again, and is not the window's.
    const later = withEntries(MAIL_JOURNAL, (j, dir) => {
      const last = j.entries.at(-1)!;
      j.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1, tag: "0206_later" });
      writeFileSync(join(dir, "0206_later.sql"), `CREATE TABLE "later" (id int);`);
    });
    expect(readWindow("mail", later).map((e) => e.tag)).toEqual(readWindow("mail").map((e) => e.tag));
  });
});

describe("what the window's entries need, make and drop", () => {
  it("is what the fixture holds, read from the entries as they stand", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/transition/names.json", import.meta.url), "utf8")) as Record<string, string[]>;
    const names = shipped();
    expect({ needed: names.needed.map(said), made: names.made.map(said), dropped: names.dropped.map(said) }).toEqual(fixture);
  });

  it("touches `mailboxes` in two entries only: three constraints swapped for shapes, six columns moved out", () => {
    const names = shipped();
    const of = (list: EntryName[]) => list.filter((n) => n.table === "mailboxes").map(said).sort();
    expect(of(names.made)).toEqual([
      "mail 0202 constraint mailboxes.mailboxes_disabled_reason_shape",
      "mail 0202 constraint mailboxes.mailboxes_organized_by_kind_shape",
      "mail 0202 constraint mailboxes.mailboxes_sync_blocked_reason_shape",
    ]);
    expect(of(names.dropped)).toEqual([
      "mail 0202 constraint mailboxes.mailboxes_disabled_reason_closed",
      "mail 0202 constraint mailboxes.mailboxes_organized_by_kind_closed",
      "mail 0202 constraint mailboxes.mailboxes_sync_blocked_reason_closed",
      "mail 0203 column mailboxes.kickstart_at",
      "mail 0203 column mailboxes.legacy_news_clean_at",
      "mail 0203 column mailboxes.sensitive_fp_backfill_at",
      "mail 0203 column mailboxes.sensitive_rescreen_at",
      "mail 0203 column mailboxes.sensitive_rescreen_cursor",
      "mail 0203 column mailboxes.sensitive_rescreen_started_at",
    ]);
  });

  it("asks the store only for what the window does not make itself, and not for the freedom of what it dropped", () => {
    const names = namesOfWindow([{ journal: "mail", tag: "0900_made_up", statements: [
      `CREATE TABLE "fresh" ("id" uuid, CONSTRAINT "fresh_pk" PRIMARY KEY ("id"), CONSTRAINT "fresh_owner_fk" FOREIGN KEY ("id") REFERENCES "owners"("id"))`,
      `ALTER TABLE "fresh" ADD COLUMN "note" text, ADD CONSTRAINT "fresh_note_shape" CHECK ("note" ~ '^[a-z,;]{0,9}$')`,
      `CREATE INDEX "fresh_note_idx" ON "fresh" USING btree ("note")`,
      `DROP INDEX "old_idx"`,
      `CREATE INDEX "old_idx" ON "standing" USING btree ("a")`,
      `DROP INDEX IF EXISTS "maybe_idx"`,
      `-- a comment that says DROP TABLE "not_a_statement"\nALTER TABLE "standing" DROP COLUMN "gone", ALTER COLUMN "kept" SET NOT NULL, VALIDATE CONSTRAINT "standing_check"`,
      `DROP TRIGGER "standing_tg" ON "standing"`,
      `DROP FUNCTION "standing_fn"()`,
    ] }]);
    expect(names.needed.map(said).sort()).toEqual([
      "mail 0900 column standing.gone", "mail 0900 column standing.kept", "mail 0900 constraint standing.standing_check",
      "mail 0900 function standing_fn", "mail 0900 index old_idx", "mail 0900 table owners", "mail 0900 table standing",
      "mail 0900 trigger standing.standing_tg",
    ]);
    expect(names.made.map(said).sort()).toEqual([
      "mail 0900 column fresh.note", "mail 0900 constraint fresh.fresh_note_shape", "mail 0900 index fresh_note_idx",
      "mail 0900 index fresh_pk", "mail 0900 table fresh",
    ]);
    expect(names.dropped.map(said)).toContain("mail 0900 index maybe_idx");
    expect(names.dropped.map(said)).not.toContain("mail 0900 table not_a_statement");
  });

  it("refuses a statement it cannot read, by the entry's name, where a silent miss would empty the refusal's lists", () => {
    expect(() => namesOfWindow([{ journal: "cloud", tag: "0901_made_up", statements: [`ALTER TABLE "standing" RENAME COLUMN "a" TO "b"`] }]))
      .toThrow(/cloud 0901_made_up: an ALTER TABLE clause this reader does not know/);
  });
});
