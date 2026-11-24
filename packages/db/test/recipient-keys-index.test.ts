import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { pgDialect, sqliteDialect } from "../src/dialect/index.js";
import { HOT_PATH_INDEX_SPECS } from "../src/hot-path-indexes.js";
import {
  PREMIGRATION_PREBUILD_SPECS, RECIPIENT_KEYS_COLUMN_INDEX, RECIPIENT_KEYS_COLUMN_INDEX_DDL, RECIPIENT_KEYS_FUNCTION_DDL,
  RECIPIENT_KEYS_INDEX_DDL, RECIPIENT_KEYS_PREBUILD_SPEC, RETIRED_PREBUILD_SPECS,
} from "../src/search-setup.js";

/**
 * THE RECIPIENTS' KEY HAS ONE SPELLING. Mail 0154's journal carries the function and its expression
 * index byte for byte the constants; the prebuild that built that index CONCURRENTLY ahead of the
 * migrator is retired, since mail 0208 drops it. Mail 0208 stores the key in a column generated from
 * the same call over the same three columns, the index's own expression, and builds the column's GIN
 * as its constant spells it; and the key must name the account, or the index would hand one
 * account's address to another's search.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const PG_SQL = read("../../db-mail/drizzle/0154_messages_recipient_keys.sql");
const JOURNAL = JSON.parse(read("../../db-mail/drizzle/meta/_journal.json")) as { entries: Array<{ idx: number; tag: string; when: number }> };
const statementsOf = (text: string) => text.split("--> statement-breakpoint").map((s) => s.replace(/^\s*--[^\n]*$/gm, "").trim()).filter(Boolean);
const statements = statementsOf(PG_SQL);
const COLUMN_SQL = statementsOf(read("../../db-mail/drizzle/0208_recipient_keys_column.sql"));
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

  it("the prebuild is retired with the index mail 0208 drops: no setup builds it, and its spec keeps 0154's spelling", () => {
    expect(RETIRED_PREBUILD_SPECS).toContain(RECIPIENT_KEYS_PREBUILD_SPEC);
    expect(PREMIGRATION_PREBUILD_SPECS.map((s) => s.name)).not.toContain("messages_recipient_keys_idx");
    expect(HOT_PATH_INDEX_SPECS.map((s) => s.name)).not.toContain("messages_recipient_keys_idx");
    expect(RECIPIENT_KEYS_PREBUILD_SPEC.ddl).toBe(RECIPIENT_KEYS_INDEX_DDL);
    expect(RECIPIENT_KEYS_PREBUILD_SPEC.prelude).toEqual([RECIPIENT_KEYS_FUNCTION_DDL]);
  });

  it("mail 0208 drops the expression index first, stores the index's own expression, and builds the column's GIN as its constant spells it", () => {
    const e = JOURNAL.entries.find((x) => x.tag === "0208_recipient_keys_column");
    expect(e?.idx).toBe(JOURNAL.entries.findIndex((x) => x.tag === "0207_request_folder_moves") + 1);
    expect(COLUMN_SQL).toHaveLength(3);
    expect(canon(COLUMN_SQL[0]!)).toBe(`DROP INDEX "messages_recipient_keys_idx"`);
    const generated = /GENERATED ALWAYS AS \((messages_recipient_keys\([^)]*\))\) STORED/.exec(COLUMN_SQL[1]!);
    expect(COLUMN_SQL[1]!.startsWith(`ALTER TABLE "messages" ADD COLUMN "recipient_keys" text[] GENERATED ALWAYS AS`)).toBe(true);
    expect(bare(generated![1]!)).toBe(bare(INDEX_EXPR.exec(renderPg(RECIPIENT_KEYS_INDEX_DDL).sql)![1]!));
    expect(canon(COLUMN_SQL[2]!)).toBe(canon(renderPg(RECIPIENT_KEYS_COLUMN_INDEX_DDL).sql));
    expect(renderPg(RECIPIENT_KEYS_COLUMN_INDEX_DDL).sql).toContain(`"${RECIPIENT_KEYS_COLUMN_INDEX}"`);
    expect(renderPg(RECIPIENT_KEYS_COLUMN_INDEX_DDL).params).toEqual([]);
  });

  it("the pg predicate reads the stored key, keyed by the account, and calls no function a letter", () => {
    const pred = renderPg(pgDialect().search.recipient({ accountId: "acct", address: "Info@ACME.test" }));
    // The account leads the key, and the address is folded in SQL, never on the client.
    expect(pred.sql.replace(/\s+/g, " ")).toBe("m.recipient_keys @> array[$1::text || ':' || lower($2)]");
    expect(pred.sql).not.toContain("messages_recipient_keys(");
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
