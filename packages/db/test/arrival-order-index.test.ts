import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { pgDialect, sqliteDialect } from "../src/dialect/index.js";
import { HOT_PATH_INDEX_SPECS } from "../src/hot-path-indexes.js";
import { ARRIVAL_ORDER_INDEX_DDL, ARRIVAL_ORDER_PREBUILD_SPEC, PREMIGRATION_PREBUILD_SPECS } from "../src/search-setup.js";

/**
 * THE ARRIVAL KEY HAS THREE HOMES AND ONE SPELLING (mail 0171, 0139's successor): the dialect member every store
 * order is built from, the pg journal's index and the SQLite journal's index. A planner matches an
 * index expression only to the SAME expression — a parameter where the index has a literal, or a
 * reordered arm, is a query that sorts the account while the index sits unused. So each journal
 * statement must carry the dialect's own rendered text byte for byte, and the hot-path spec and the
 * prebuild are that statement plus CONCURRENTLY. The rendered key must bind no parameter at all.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const PG_SQL = read("../../db-mail/drizzle/0171_messages_arrival_key.sql");
const LITE_SQL = read("../../db-mail/drizzle-sqlite/0171_messages_arrival_key.sql");
const renderPg = (k: ReturnType<typeof sql>) => new PgDialect().sqlToQuery(k);
const renderLite = (k: ReturnType<typeof sql>) => new SQLiteSyncDialect().sqlToQuery(k);
const statementOf = (text: string) => text.replace(/^\s*--[^\n]*$/gm, "").trim();

describe("mail 0171's arrival index is the dialect's own key", () => {
  const pgKey = renderPg(pgDialect().arrivalKey(sql`"date"`, sql`"arrived_at"`));
  const liteKey = renderLite(sqliteDialect().arrivalKey(sql`"date"`, sql`"arrived_at"`));

  it("the key binds no parameter on either store", () => {
    expect(pgKey.params).toEqual([]);
    expect(liteKey.params).toEqual([]);
  });

  it("the pg journal carries the pg key byte for byte, between the account and the id", () => {
    expect(statementOf(PG_SQL)).toContain(`("account_id",${pgKey.sql} desc,"id" desc)`);
  });

  it("the SQLite journal carries the SQLite key byte for byte", () => {
    expect(statementOf(LITE_SQL)).toContain(`("account_id", ${liteKey.sql} DESC, "id" DESC)`);
  });

  it("the hot-path spec and the prebuild are the journal statement plus CONCURRENTLY", () => {
    const canon = (s: string) => s.replace(/\bconcurrently\s+/i, "").replace(/\s+/g, " ").trim().replace(/;$/, "");
    const spec = HOT_PATH_INDEX_SPECS.find((s) => s.name === "messages_account_arrival_key_idx");
    expect(spec?.ddl).toBe(ARRIVAL_ORDER_INDEX_DDL);
    expect(ARRIVAL_ORDER_PREBUILD_SPEC.ddl).toBe(ARRIVAL_ORDER_INDEX_DDL);
    expect(PREMIGRATION_PREBUILD_SPECS).toContain(ARRIVAL_ORDER_PREBUILD_SPEC);
    const ddl = renderPg(ARRIVAL_ORDER_INDEX_DDL).sql;
    expect(ddl).toMatch(/^create index concurrently if not exists/);
    expect(canon(statementOf(PG_SQL))).toBe(canon(ddl));
  });

  it("CONTROL: the comparison refuses a key one character off", () => {
    const off = pgKey.sql.replace("48 hours", "47 hours");
    expect(off).not.toBe(pgKey.sql);
    expect(statementOf(PG_SQL)).not.toContain(`("account_id",${off} desc,"id" desc)`);
  });
});
