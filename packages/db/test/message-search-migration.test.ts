import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { pgDialect, SEARCH_NAMES_MARK } from "../src/dialect/index.js";
import { HOT_PATH_INDEX_SPECS } from "../src/hot-path-indexes.js";
import { HISTORY_ORDER_PREBUILD_SPEC, TRIGRAM_INDEX_SPECS } from "../src/search-setup.js";

/**
 * MAIL 0125's HISTORY INDEX HAS THREE SPELLINGS AND THEY ARE ONE INDEX: the hot-path build after
 * the migrator, the prebuild ahead of it (0071's pattern), and the journal statement a PGlite store
 * replays. A drift between them is two indexes under one name — the `if not exists` would keep
 * whichever came first, and the plan the History page was measured on would not be the one served.
 */
const MIGRATION = fileURLToPath(new URL("../../db-mail/drizzle/0125_message_search.sql", import.meta.url));
const render = (spec: { ddl: Parameters<PgDialect["sqlToQuery"]>[0] }): string =>
  new PgDialect().sqlToQuery(spec.ddl).sql;
const canon = (s: string): string => s.replace(/\bconcurrently\s+/i, "").replace(/\s+/g, " ").trim().replace(/;$/, "").toLowerCase();

describe("mail 0125's History index is one index", () => {
  const hot = HOT_PATH_INDEX_SPECS.find((s) => s.name === "messages_account_msg_order_idx");
  const journal = readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint")
    .map((s) => s.replace(/^\s*--[^\n]*\n/gm, "").trim())
    .find((s) => s.includes("messages_account_msg_order_idx"));

  it("finds all three spellings", () => {
    expect(hot).toBeDefined();
    expect(journal).toBeDefined();
    expect(render(HISTORY_ORDER_PREBUILD_SPEC)).toMatch(/concurrently/i);
  });

  it("the hot-path spec, the prebuild and the journal statement agree, minus CONCURRENTLY", () => {
    expect(canon(render(HISTORY_ORDER_PREBUILD_SPEC))).toBe(canon(render(hot!)));
    expect(canon(journal!)).toBe(canon(render(hot!)));
  });

  it("the comparison can tell them apart — a different column order is refused", () => {
    expect(canon(journal!.replace('"date" desc nulls last,"id" desc', '"id" desc,"date" desc nulls last')))
      .not.toBe(canon(render(hot!)));
  });

  it("the header corpus's trigram index is built beside the other two, concurrently", () => {
    const terms = TRIGRAM_INDEX_SPECS.find((s) => s.name === "message_search_terms_trgm_idx");
    expect(terms?.table).toBe("message_search");
    expect(render(terms!)).toMatch(/concurrently if not exists "message_search_terms_trgm_idx"[\s\S]*gin_trgm_ops/);
  });
});

/**
 * THE SUBSTRING CORPUS'S TWO SIDES, EACH READ THROUGH ITS OWN INDEX: the header text before the mark and
 * the file names after it. The planner serves an arm from an expression index only when the arm spells
 * the index's expression, so each arm must carry it as setup builds it, the mark inline: a bound mark is
 * another expression, and the arm would read every one of the account's documents.
 */
describe("the substring corpus's two sides are read by their own indexes' expressions", () => {
  const keyOf = (name: string): string => {
    const spec = TRIGRAM_INDEX_SPECS.find((s) => s.name === name);
    expect(spec?.table, name).toBe("message_search");
    return /\(\s*"account_id"\s*,\s*\((.+)\)\s+gin_trgm_ops\s*\)/.exec(render(spec!))![1]!.replace('"terms"', "s.terms");
  };
  const asked = (pred: SQL) => new PgDialect().sqlToQuery(pred);

  it("the substring arm reads the header text's expression and the names arm the names', each its typed query alone a parameter", () => {
    const head = keyOf("message_search_head_terms_trgm_idx");
    const names = keyOf("message_search_names_trgm_idx");
    expect([head, names]).toEqual(["split_part(s.terms, chr(31), 1)", "split_part(s.terms, chr(31), 2)"]);
    const substring = asked(pgDialect().search.substring("axa", { trigram: true }).pred);
    const named = asked(pgDialect().search.names("axa")!.pred);
    expect({ sql: substring.sql, params: substring.params }).toEqual({ sql: `${head} ilike $1`, params: ["%axa%"] });
    expect({ sql: named.sql, params: named.params }).toEqual({ sql: `${names} ilike $1`, params: ["%axa%"] });
  });

  it("the writer's mark is the character both expressions split at", () => {
    expect(SEARCH_NAMES_MARK).toBe(String.fromCharCode(31));
    expect(`papers${SEARCH_NAMES_MARK}inv-123.pdf`.split(SEARCH_NAMES_MARK)).toEqual(["papers", "inv-123.pdf"]);
  });

  it("the comparison can tell them apart: a bound mark is another expression", () => {
    const bound = asked(sql`split_part(s.terms, ${SEARCH_NAMES_MARK}, 1) ilike ${"%axa%"}`);
    expect(bound.sql).not.toContain(keyOf("message_search_head_terms_trgm_idx"));
  });
});
