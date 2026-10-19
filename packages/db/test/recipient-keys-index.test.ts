import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { pgDialect, sqliteDialect } from "../src/dialect/index.js";
import { HOT_PATH_INDEX_SPECS } from "../src/hot-path-indexes.js";
import {
  PREMIGRATION_PREBUILD_SPECS, RECIPIENT_KEYS_FUNCTION_DDL, RECIPIENT_KEYS_INDEX_DDL, RECIPIENT_KEYS_PREBUILD_SPEC,
} from "../src/search-setup.js";

/**
 * MAIL 0154's RECIPIENT INDEX HAS ONE SPELLING IN FOUR PLACES: the journal, the prebuild that builds
 * it CONCURRENTLY ahead of the migrator (with the function it names as its prelude), the hot-path
 * spec setup-prod reads back, and the dialect's predicate. A planner uses an expression index only
 * for the SAME expression, so the predicate must carry the index's call textually; and the key
 * must name the account, or the index would hand one account's address to another's search.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const PG_SQL = read("../../db-mail/drizzle/0154_messages_recipient_keys.sql");
const JOURNAL = JSON.parse(read("../../db-mail/drizzle/meta/_journal.json")) as { entries: Array<{ idx: number; tag: string; when: number }> };
const statements = PG_SQL.split("--> statement-breakpoint").map((s) => s.replace(/^\s*--[^\n]*$/gm, "").trim()).filter(Boolean);
const renderPg = (k: SQL) => new PgDialect().sqlToQuery(k);
const canon = (s: string) => s.replace(/\bconcurrently\s+/i, "").replace(/\s+/g, " ").trim().replace(/;$/, "");
/** The index's key expression with quoting, an alias and spacing taken out. */
const bare = (s: string) => s.replace(/"/g, "").replace(/\bm\./g, "").replace(/\s+/g, "");
const INDEX_EXPR = /using gin \((messages_recipient_keys\([^)]*\))\)/i;

describe("mail 0154's recipient index is spelled once", () => {
  it("the journal entry is idx 154, after 0153", () => {
    const e = JOURNAL.entries.find((x) => x.idx === 154);
    expect(e?.tag).toBe("0154_messages_recipient_keys");
    const prev = JOURNAL.entries.find((x) => x.idx === 153)!;
    expect(e!.when).toBeGreaterThan(prev.when);
  });

  it("the journal carries the function and the plain index, byte for byte the constants", () => {
    expect(statements).toHaveLength(2);
    expect(canon(statements[0]!)).toBe(canon(renderPg(RECIPIENT_KEYS_FUNCTION_DDL).sql));
    const ddl = renderPg(RECIPIENT_KEYS_INDEX_DDL).sql;
    expect(ddl).toMatch(/^create index concurrently if not exists "messages_recipient_keys_idx"/);
    expect(canon(statements[1]!)).toBe(canon(ddl));
    expect(renderPg(RECIPIENT_KEYS_FUNCTION_DDL).params).toEqual([]);
    expect(renderPg(RECIPIENT_KEYS_INDEX_DDL).params).toEqual([]);
  });

  it("the prebuild builds it ahead of the migrator, the function first; the hot-path spec shares the DDL", () => {
    expect(PREMIGRATION_PREBUILD_SPECS).toContain(RECIPIENT_KEYS_PREBUILD_SPEC);
    expect(RECIPIENT_KEYS_PREBUILD_SPEC.ddl).toBe(RECIPIENT_KEYS_INDEX_DDL);
    expect(RECIPIENT_KEYS_PREBUILD_SPEC.prelude).toEqual([RECIPIENT_KEYS_FUNCTION_DDL]);
    const hot = HOT_PATH_INDEX_SPECS.find((s) => s.name === "messages_recipient_keys_idx");
    expect(hot?.ddl).toBe(RECIPIENT_KEYS_INDEX_DDL);
    expect(hot?.table).toBe("messages");
  });

  it("the pg predicate is the index's own expression, keyed by the account", () => {
    const pred = renderPg(pgDialect().search.recipient({ accountId: "acct", address: "Info@ACME.test" }));
    const indexExpr = INDEX_EXPR.exec(renderPg(RECIPIENT_KEYS_INDEX_DDL).sql)![1]!;
    const callInPred = /messages_recipient_keys\([^)]*\)/.exec(pred.sql)![0];
    expect(bare(callInPred)).toBe(bare(indexExpr));
    expect(pred.sql).toContain("m.account_id, m.to_addresses, m.cc_addresses");
    // The account leads the key, and the address is folded in SQL, never on the client.
    expect(pred.sql.replace(/\s+/g, " ")).toMatch(/@> array\[\$1::text \|\| ':' \|\| lower\(\$2\)\]/);
    expect(pred.params).toEqual(["acct", "Info@ACME.test"]);
  });

  it("the device predicate reads the side table within the account", () => {
    const pred = new SQLiteSyncDialect().sqlToQuery(sqliteDialect().search.recipient({ accountId: "acct", address: "Info@ACME.test" }));
    expect(pred.sql.replace(/\s+/g, " ")).toBe(
      "m.id in (select r.message_id from message_recipients r where r.account_id = ? and r.address = lower(?))");
    expect(pred.params).toEqual(["acct", "Info@ACME.test"]);
  });

  it("CONTROL: the comparison refuses an expression one character off", () => {
    const indexExpr = INDEX_EXPR.exec(renderPg(RECIPIENT_KEYS_INDEX_DDL).sql)![1]!;
    const off = indexExpr.replace("cc_addresses", "bcc_addresses");
    expect(bare(off)).not.toBe(bare(indexExpr));
    const offPred = renderPg(sql`messages_recipient_keys(m.account_id, m.to_addresses, m.bcc_addresses)`).sql;
    expect(bare(offPred)).not.toBe(bare(indexExpr));
  });
});
