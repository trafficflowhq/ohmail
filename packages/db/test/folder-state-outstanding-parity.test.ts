import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { OUTSTANDING_FILING_WHERE, ourOutstandingFiling } from "../src/folder-state-pending.js";
import {
  FOLDER_STATE_OUTSTANDING_COLUMN_DDL, FOLDER_STATE_OUTSTANDING_INDEX_DDL, FOLDER_STATE_OUTSTANDING_PREBUILD_SPEC,
  MAILBOXES_ACCOUNT_PREBUILD_SPEC, PREMIGRATION_PREBUILD_SPECS,
} from "../src/search-setup.js";
import { HOT_PATH_INDEX_SPECS } from "../src/hot-path-indexes.js";

/**
 * MAIL 0160's PREDICATE IN FIVE PLACES, HELD EQUAL: `ourOutstandingFiling` (the reader), the index
 * WHERE on both journals and in the prebuild, the triggers' WHEN (one on Postgres, two on the device
 * store) and both backfills. A partial index the reader's WHERE does not imply is never read, and a
 * trigger narrower than the predicate leaves rows the reader misses. The journal's index and column
 * statements are the prebuild's, minus `concurrently`, so they no-op on a live server.
 */
const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const split = (text: string): string[] => text.split("--> statement-breakpoint")
  .map((s) => s.replace(/^\s*--[^\n]*$/gm, "").trim()).filter(Boolean);
const PG = split(read("../../db-mail/drizzle/0160_folder_state_outstanding.sql"));
const LITE = split(read("../../db-mail/drizzle-sqlite/0160_folder_state_outstanding.sql"));
const PG_0161 = split(read("../../db-mail/drizzle/0161_mailboxes_account_idx.sql"));
const LITE_0161 = split(read("../../db-mail/drizzle-sqlite/0161_mailboxes_account_idx.sql"));
const text = (q: SQL): string => new PgDialect().sqlToQuery(q).sql;
const flat = (s: string): string => s.replace(/\s+/g, " ").trim().replace(/;$/, "");

/** One spelling to compare: no quotes, no `NEW.`/table qualifier, one space, lower case, no outer parentheses. */
const norm = (s: string): string => {
  let out = flat(s).toLowerCase().replace(/"/g, "").replace(/\bnew\./g, "").replace(/\bfolder_state\./g, "");
  while (out.startsWith("(") && out.endsWith(")")) out = out.slice(1, -1).trim();
  return out;
};
const PREDICATE = norm(OUTSTANDING_FILING_WHERE);
const one = (re: RegExp, s: string | undefined): string => {
  const m = re.exec(s ?? "");
  if (!m) throw new Error(`no match for ${re} in ${s}`);
  return m[1]!;
};

describe("mail 0160's predicate is one text", () => {
  it("the reader renders it, with literals and no bound parameter", () => {
    const q = new PgDialect().sqlToQuery(ourOutstandingFiling());
    expect(q.params).toEqual([]);
    expect(norm(q.sql)).toBe(PREDICATE);
    expect(PREDICATE).toBe("reconcile_status = 'pending' and last_set_by = 'us' and desired_folder <> observed_folder");
  });

  it("the index WHERE, on both journals and in the prebuild", () => {
    expect(norm(one(/ where (.*)$/is, PG.find((s) => /^create index/i.test(s))))).toBe(PREDICATE);
    expect(norm(one(/ WHERE (.*)$/s, LITE.find((s) => /^CREATE INDEX/.test(s))))).toBe(PREDICATE);
    expect(norm(one(/ where (.*)$/is, text(FOLDER_STATE_OUTSTANDING_INDEX_DDL)))).toBe(PREDICATE);
  });

  it("every trigger WHEN, and both backfills", () => {
    const pgTrigger = PG.find((s) => s.includes("CREATE TRIGGER"));
    expect(norm(one(/ WHEN \((.*)\)\s+EXECUTE FUNCTION/s, pgTrigger))).toBe(PREDICATE);
    expect(pgTrigger).toMatch(/BEFORE INSERT OR UPDATE ON "folder_state"\s+FOR EACH ROW/);
    const liteTriggers = LITE.filter((s) => s.startsWith("CREATE TRIGGER"));
    expect(liteTriggers.map((s) => one(/ (AFTER (?:INSERT|UPDATE)) ON folder_state/, s))).toEqual(["AFTER INSERT", "AFTER UPDATE"]);
    for (const t of liteTriggers) expect(norm(one(/\n\s*WHEN (.*)\nBEGIN/s, t))).toBe(PREDICATE);
    expect(norm(one(/IS NULL\s+AND (.*)$/s, PG.find((s) => s.startsWith("UPDATE"))))).toBe(PREDICATE);
    expect(norm(one(/IS NULL\s+AND (.*)$/s, LITE.find((s) => s.startsWith("UPDATE folder_state SET outstanding_account_id = (SELECT account_id FROM messages WHERE id = folder_state.message_id)"))))).toBe(PREDICATE);
  });

  it("the journal's column and index statements are the prebuild's, minus concurrently", () => {
    expect(PG[0]).toBe(`${text(FOLDER_STATE_OUTSTANDING_COLUMN_DDL)};`);
    expect(FOLDER_STATE_OUTSTANDING_PREBUILD_SPEC.prelude).toEqual([FOLDER_STATE_OUTSTANDING_COLUMN_DDL]);
    // No `requiresColumn`: below 0160 it would defer the build into the journal's transaction.
    expect(FOLDER_STATE_OUTSTANDING_PREBUILD_SPEC.requiresColumn).toBeUndefined();
    expect(flat(PG.find((s) => /^create index/i.test(s))!))
      .toBe(flat(text(FOLDER_STATE_OUTSTANDING_INDEX_DDL).replace(/\bconcurrently /, "")));
    expect(PG_0161).toHaveLength(1);
    expect(flat(PG_0161[0]!)).toBe(flat(text(MAILBOXES_ACCOUNT_PREBUILD_SPEC.ddl).replace(/\bconcurrently /, "")));
    expect(LITE_0161).toEqual([`CREATE INDEX IF NOT EXISTS "mailboxes_account_idx" ON "mailboxes" ("account_id", "id");`]);
    for (const spec of [FOLDER_STATE_OUTSTANDING_PREBUILD_SPEC, MAILBOXES_ACCOUNT_PREBUILD_SPEC]) {
      expect(PREMIGRATION_PREBUILD_SPECS).toContain(spec);
      expect(HOT_PATH_INDEX_SPECS).toContain(spec);
    }
  });

  it("control: a predicate one operand off is told apart", () => {
    expect(norm(`"reconcile_status" = 'pending' and "last_set_by" = 'us'`)).not.toBe(PREDICATE);
    expect(norm(`NEW."reconcile_status" = 'pending' and NEW."last_set_by" = 'external' and NEW."desired_folder" <> NEW."observed_folder"`))
      .not.toBe(PREDICATE);
  });
});
