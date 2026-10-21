import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { pgDialect, sqliteDialect } from "../src/dialect/index.js";
import { HOT_PATH_INDEX_SPECS } from "../src/hot-path-indexes.js";
import * as setup from "../src/search-setup.js";
import { cutlineInstant, senderIsActiveSql, type ResolvedCutline } from "../src/screener-cutline.js";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * MAIL 0157: THE CUTLINE PROBE'S INDEX IS ITS OWN EXPRESSION. The probe in `senderIsActiveSql` dates
 * a held sender's messages by `cutlineInstant`; a planner matches an index expression only to the
 * same expression, so both journals must carry `cutlineInstant`'s own rendering, and the prebuild and
 * the hot-path spec are the pg statement plus CONCURRENTLY. The probe states its window as a
 * top-level conjunct when one baselined window applies: only then is the range usable under a
 * generic plan and on the device store.
 */
const NAME = "messages_account_sender_date_idx";
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const readOr = (rel: string) => { try { return read(rel); } catch { return ""; } };
const PG_SQL = readOr("../../db-mail/drizzle/0157_messages_sender_date.sql");
const LITE_SQL = readOr("../../db-mail/drizzle-sqlite/0157_messages_sender_date.sql");
const SETUP = fileURLToPath(new URL("../src/setup-prod.ts", import.meta.url));
const renderPg = (k: SQL) => new PgDialect().sqlToQuery(k);
const renderLite = (k: SQL) => new SQLiteSyncDialect().sqlToQuery(k);
const statementOf = (text: string) => text.replace(/^\s*--[^\n]*$/gm, "").trim();
const canon = (s: string) => s.replace(/\bconcurrently\s+/i, "").replace(/\s+/g, " ").trim().replace(/;$/, "");
const key = cutlineInstant({ date: sql`"date"`, arrivedAt: sql`"created_at"` });

function recorder() {
  const ran: string[] = [];
  const fake = {
    execute: async (q: unknown) => {
      const text = JSON.stringify((q as { queryChunks?: unknown }).queryChunks ?? q,
        (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v));
      ran.push(text);
      if (text.includes("information_schema.tables")) return [{ present: true }];
      if (text.includes("information_schema.columns")) return [{ present: true }];
      return [];
    },
  };
  return { ran, fake };
}

describe("mail 0157's sender-date index is the cutline's own key", () => {
  const pgKey = renderPg(key);
  const liteKey = renderLite(key);

  it("the key binds no parameter on either store", () => {
    expect(pgKey.params).toEqual([]);
    expect(liteKey.params).toEqual([]);
  });

  it("the pg journal carries the key byte for byte, after the account and the lowered sender", () => {
    expect(statementOf(PG_SQL)).toContain(`("account_id",lower("from_address"),(${pgKey.sql}))`);
  });

  it("the SQLite journal carries the key byte for byte", () => {
    expect(statementOf(LITE_SQL)).toContain(`("account_id", lower("from_address"), ${liteKey.sql})`);
  });

  it("the prebuild and the hot-path spec share one DDL, and the pg journal is it minus CONCURRENTLY", () => {
    const ddl = setup.SENDER_DATE_INDEX_DDL;
    expect(ddl, "no SENDER_DATE_INDEX_DDL").toBeDefined();
    expect(setup.SENDER_DATE_PREBUILD_SPEC?.ddl).toBe(ddl);
    expect(setup.SENDER_DATE_PREBUILD_SPEC?.name).toBe(NAME);
    expect(setup.SENDER_DATE_PREBUILD_SPEC?.table).toBe("messages");
    expect(setup.PREMIGRATION_PREBUILD_SPECS).toContain(setup.SENDER_DATE_PREBUILD_SPEC);
    expect(HOT_PATH_INDEX_SPECS.find((s) => s.name === NAME)?.ddl).toBe(ddl);
    const text = renderPg(ddl!).sql;
    expect(text).toMatch(/^create index concurrently if not exists/);
    expect(text).toContain("on public.messages");
    expect(canon(statementOf(PG_SQL))).toBe(canon(text));
  });

  it("the pre-migration prebuild builds it CONCURRENTLY, and setup runs that before the migrator", async () => {
    const { ran, fake } = recorder();
    await setup.ensureWithheldProvenanceIndex(fake);
    const mine = ran.filter((s) => s.includes(NAME));
    expect(mine.some((s) => s.includes("create index concurrently if not exists")), "no concurrent build of the sender-date index").toBe(true);
    const src = withoutComments(readFileSync(SETUP, "utf8"));
    const body = src.slice(src.indexOf("export async function setupProdDatabase("));
    expect(body.indexOf("ensureWithheldProvenanceIndex(")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("ensureWithheldProvenanceIndex(")).toBeLessThan(body.indexOf("runMigrations("));
  });

  it("CONTROL: a key dated by arrived_at is refused", () => {
    const off = renderPg(cutlineInstant({ date: sql`"date"`, arrivedAt: sql`"arrived_at"` })).sql;
    expect(off).not.toBe(pgKey.sql);
    expect(statementOf(PG_SQL)).not.toContain(`lower("from_address"),(${off}))`);
    expect(statementOf(LITE_SQL)).not.toContain(`lower("from_address"), ${off})`);
  });
});

describe("the probe states one baselined window as a range the index serves", () => {
  const ACC = "00000000-0000-4000-8000-000000000001";
  const cutoff = new Date("2026-08-01T00:00:00.000Z");
  const c = (o: Partial<ResolvedCutline>): ResolvedCutline => ({ cutoff, baselined: true, allTime: false, ...o });
  const probe = (set: Parameters<typeof senderIsActiveSql>[3]) =>
    renderPg(senderIsActiveSql(pgDialect(), ACC, sql`lower(r.from_address)`, set)).sql.replace(/\s+/g, " ");
  const conjunct = /lower\(mc\.from_address\) = lower\(r\.from_address\) and coalesce\(mc\.date, mc\.created_at\) >= \$\d+::timestamptz and /;

  it("one baselined window: the window is a top-level conjunct", () => {
    expect(probe(c({}))).toMatch(conjunct);
    expect(probe(new Map([["m1", c({})], ["m2", c({})]]))).toMatch(conjunct);
  });

  it("no baseline, all time, or windows per mailbox: no conjunct", () => {
    expect(probe(c({ baselined: false }))).not.toMatch(conjunct);
    expect(probe(c({ allTime: true }))).not.toMatch(conjunct);
    expect(probe(new Map([["m1", c({})], ["m2", c({ cutoff: new Date(0) })]]))).not.toMatch(conjunct);
  });

  it("the device store renders the same conjunct", () => {
    const lite = renderLite(senderIsActiveSql(sqliteDialect(), ACC, sql`lower(r.from_address)`, c({}))).sql.replace(/\s+/g, " ");
    expect(lite).toMatch(/lower\(mc\.from_address\) = lower\(r\.from_address\) and coalesce\(mc\.date, mc\.created_at\) >= \? and /);
  });
});
