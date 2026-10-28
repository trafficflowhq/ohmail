import { describe, it, expect } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import {
  boolLiteral, brandDialect, dialect, dialectOf, pgDialect, sqliteDialect,
  assertSqliteCapabilities, onLocalNotify,
} from "../src/dialect/index.js";
import { WORD_INDEX_SPEC } from "../src/search-setup.js";

describe("the dialect brand", () => {
  it("refuses a handle no factory has branded", () => {
    expect(() => dialectOf({})).toThrow(/no dialect brand/);
  });

  it("reads back what the factory stamped, for each dialect", () => {
    expect(dialectOf(brandDialect({}, "pg"))).toBe("pg");
    expect(dialectOf(brandDialect({}, "sqlite"))).toBe("sqlite");
    expect(dialect(brandDialect({}, "sqlite")).name).toBe("sqlite");
  });

  /**
   * THE BRAND IS INHERITED BY TRANSACTIONS, and these are the cases that make that a fact.
   *
   * A transaction is a fresh object the query builder makes, so a property on the handle does not
   * travel to it — and almost every statement in this engine runs inside one. Branding the handle
   * therefore wraps its `transaction` so the callback receives a branded object, recursively, to
   * any savepoint depth.
   */
  it("hands the callback a branded transaction, so a statement inside one can be composed", async () => {
    const db = brandDialect({
      transaction: async (fn: (tx: object) => unknown) => fn({ marker: "tx" }),
    }, "sqlite");
    const seen = await (db.transaction as (fn: (tx: object) => unknown) => Promise<unknown>)(
      (tx) => dialectOf(tx));
    expect(seen).toBe("sqlite");
  });

  it("brands a SAVEPOINT too, because the wrapper brands what it hands over", async () => {
    const inner = { transaction: async (fn: (tx: object) => unknown) => fn({ depth: 2 }) };
    const db = brandDialect({
      transaction: async (fn: (tx: object) => unknown) => fn(inner),
    }, "pg");
    const seen = await (db.transaction as (fn: (tx: object) => unknown) => Promise<unknown>)(
      async (tx) => (tx as typeof inner).transaction((sp) => dialectOf(sp)));
    expect(seen).toBe("pg");
  });

  it("wraps ONCE, however many times the same handle is branded", async () => {
    let depth = 0;
    const db = { transaction: async (fn: (tx: object) => unknown) => { depth++; return fn({}); } };
    brandDialect(db, "pg");
    const afterFirst = db.transaction;
    brandDialect(db, "pg");
    expect(db.transaction).toBe(afterFirst);
    await (db.transaction as (fn: (tx: object) => unknown) => Promise<unknown>)(() => undefined);
    expect(depth).toBe(1);
  });

  it("leaves an UNBRANDED handle refusing by name, which is the whole point of the brand", () => {
    // The positive control for the inheritance: it must not make every object answer. A handle no
    // factory branded still refuses, and its transaction is not wrapped.
    const db = { transaction: async (fn: (tx: object) => unknown) => fn({}) };
    expect(() => dialectOf(db)).toThrow(/no dialect brand/);
  });

  it("does not enumerate, so a handle still serialises and spreads as it did", () => {
    const branded = brandDialect({ url: "x" }, "pg");
    expect(Object.keys(branded)).toEqual(["url"]);
    expect(JSON.stringify(branded)).toBe('{"url":"x"}');
  });
});

/** The rendered statement, because a fragment's parts say nothing about what a store receives. */
const asPg = (f: SQL): string => new PgDialect().sqlToQuery(f).sql;
const asSqlite = (f: SQL): string => new SQLiteSyncDialect().sqlToQuery(f).sql;

describe("the two arms answer the same questions differently", () => {
  it("asks each store for the current instant in the terms that store keeps it", () => {
    expect(asPg(pgDialect().now())).toContain("now()");
    const rendered = asSqlite(sqliteDialect().now());
    expect(rendered).toContain("unixepoch('subsec')");
    expect(rendered).toContain("1000");
  });

  it("writes a boolean as a literal on both stores, binding no parameter a driver could refuse", () => {
    for (const v of [true, false]) {
      const word = v ? "TRUE" : "FALSE";
      for (const q of [new PgDialect().sqlToQuery(boolLiteral(v)), new SQLiteSyncDialect().sqlToQuery(boolLiteral(v))]) {
        expect(q).toEqual({ sql: word, params: [] });
      }
    }
  });

  it("hands a row lock to the server and nothing to the single-writer store", () => {
    const marker = { for: (_m: string) => "LOCKED" as const };
    expect(pgDialect().forUpdate(marker)).toBe("LOCKED");
    expect(sqliteDialect().forUpdate(marker)).toBe(marker);
  });

  /**
   * THE FOUR STRENGTHS, CARRIED RATHER THAN DECIDED — because a port may not promote a lock.
   *
   * Three sites in the engine take a SHARED or KEY-SHARE lock on purpose: they let other traffic
   * past, which is the whole reason they are not exclusive. Porting them through a member that
   * always says `for update` would serialize traffic the site deliberately does not — a change to
   * what the statement does on the SERVER, made while teaching it about a second store, which is
   * the one substitution a seam exists to prevent.
   */
  it("renders each lock strength the server distinguishes, and promotes none of them", () => {
    const asked: string[] = [];
    const marker = { for: (mode: string, cfg?: object) => { asked.push(`${mode}|${JSON.stringify(cfg ?? null)}`); return "L" as const; } };
    for (const mode of ["update", "share", "key share", "no key update"] as const) {
      pgDialect().forUpdate(marker, { mode });
    }
    expect(asked).toEqual([
      "update|null", "share|null", "key share|null", "no key update|null",
    ]);
  });

  it("keeps skip-locked and the table restriction alongside whichever strength was asked for", () => {
    const asked: string[] = [];
    const marker = { for: (mode: string, cfg?: object) => { asked.push(`${mode}|${JSON.stringify(cfg ?? null)}`); return "L" as const; } };
    pgDialect().forUpdate(marker, { mode: "share", skipLocked: true });
    pgDialect().skipLocked(marker, { mode: "no key update" });
    expect(asked).toEqual([
      'share|{"skipLocked":true}',
      'no key update|{"skipLocked":true}',
    ]);
  });

  it("POSITIVE CONTROL: no mode is the exclusive lock, exactly as before the parameter existed", () => {
    // The half that would otherwise go unwatched. Every caller in the tree passes no mode, so a
    // default that drifted would change every one of them at once and no case above would notice.
    const asked: string[] = [];
    const marker = { for: (mode: string, cfg?: object) => { asked.push(`${mode}|${JSON.stringify(cfg ?? null)}`); return "L" as const; } };
    pgDialect().forUpdate(marker);
    pgDialect().forUpdate(marker, { skipLocked: true });
    expect(asked).toEqual(["update|null", 'update|{"skipLocked":true}']);
  });

  it("is the identity on the single-writer store for EVERY strength, not just the exclusive one", () => {
    // The strengths differ only in which other writers they admit, and there are none: the store
    // is reached through one serialized connection, so a second connection does not queue behind
    // a lock, it fails outright.
    const marker = { for: (_m: string) => "LOCKED" as const };
    for (const mode of ["update", "share", "key share", "no key update"] as const) {
      expect(sqliteDialect().forUpdate(marker, { mode })).toBe(marker);
      expect(sqliteDialect().skipLocked(marker, { mode })).toBe(marker);
    }
  });

  it("emits the lock clause as text for the one statement no builder can reach, per strength", () => {
    // The sharper tool, and deliberately so: `forUpdate` takes a QUERY and can only be attached to
    // something the builder composes. This emits the clause itself, for a subselect written as raw
    // SQL that has no builder around it.
    expect(asPg(pgDialect().lockClause())).toBe("for update");
    expect(asPg(pgDialect().lockClause({ skipLocked: true }))).toBe("for update skip locked");
    expect(asPg(pgDialect().lockClause({ mode: "share" }))).toBe("for share");
    expect(asPg(pgDialect().lockClause({ mode: "key share", skipLocked: true })))
      .toBe("for key share skip locked");
  });

  it("emits NOTHING for the single-writer store, as a fragment rather than an omission", () => {
    // A fragment and not an absence, because the caller writes it into the middle of a statement:
    // the seam has to hand back something that renders to nothing rather than leaving each site to
    // decide whether to include it.
    for (const opts of [undefined, { skipLocked: true }, { mode: "share" as const }]) {
      expect(asSqlite(sqliteDialect().lockClause(opts))).toBe("");
    }
  });

  /**
   * THE ACCOUNT LOCK, RENDERED — what makes porting a caller to this member a no-op on the server.
   *
   * `MailboxService.delete`'s erase arm spelled this statement inline until the phone bundle's
   * census found it there: raw, it is not a statement the device store refuses but a method its
   * handle does not have, so the whole removal threw. The fragment below is that caller's exact
   * literal, and the member has to render to it, parameters included.
   */
  it("takes the account lock as the statement its callers used to spell, and nothing on the device store", async () => {
    const LOCK_CLASS = 420_727_017;               // ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS
    const KEY = "account-under-erasure";
    const asWritten = sql`select pg_advisory_xact_lock(${LOCK_CLASS}, hashtext(${KEY}))`;

    const sent: SQL[] = [];
    const tx = { execute: async (s: SQL) => { sent.push(s); } };
    await pgDialect().advisoryLock(tx, LOCK_CLASS, KEY);
    expect(sent).toHaveLength(1);
    expect(new PgDialect().sqlToQuery(sent[0]!)).toEqual(new PgDialect().sqlToQuery(asWritten));

    // The device arm issues NO statement, and it is handed a tx that HAS an `execute` so that
    // "it did not call it" is watched rather than inferred from a handle with nothing to call.
    await sqliteDialect().advisoryLock(tx, LOCK_CLASS, KEY);
    expect(sent).toHaveLength(1);
  });

  it("turns a JSON array into rows, and hands back BOTH fragments because the shapes differ", () => {
    // The server's function yields the element as the aliased relation's single column; this
    // store's yields a TABLE whose element is a named column of it. A member handing back one
    // fragment would have made every caller spell that difference, which is what it removes.
    const pg = pgDialect().jsonArrayElements(sql`m.to_addresses`, "x");
    expect(asPg(pg.from)).toContain("jsonb_array_elements");
    expect(asPg(pg.from)).toContain("as x(value)");
    expect(asPg(pg.value)).toBe("x.value");

    const lite = sqliteDialect().jsonArrayElements(sql`m.to_addresses`, "x");
    expect(asSqlite(lite.from)).toContain("json_each");
    expect(asSqlite(lite.from)).not.toContain("(value)");
    expect(asSqlite(lite.value)).toBe("x.value");
  });

  it("folds both sides for the store whose LIKE folds only ASCII", () => {
    const rendered = asSqlite(sqliteDialect().ilike(sql`subject`, "%Ä%"));
    expect(rendered.match(/lower\(/g)).toHaveLength(2);
    expect(asPg(pgDialect().ilike(sql`subject`, "%Ä%"))).toContain("ilike");
  });

  it("keys a document as the word index does, and reads a letter as one index term a split", () => {
    const key = pgDialect().search.wordKey("00000000-0000-4000-8000-000000000001")!;
    // The key's left side is the index's first expression over the document, `s`.
    expect(asPg(WORD_INDEX_SPEC.ddl)).toContain("gin (((account_id)::text), head_tsv, text_tsv)");
    expect(asPg(key)).toMatch(/^\(\(s\.account_id\)::text = \(\$1::uuid\)::text\)$/);
    const terms = pgDialect().search.letterTerms("heron kestrel")!;
    expect(terms.map(asPg)).toEqual([
      "(s.text_tsv @@ (websearch_to_tsquery($1, $2) && websearch_to_tsquery($3, $4)))",
      "(s.head_tsv @@ (websearch_to_tsquery($1, $2)) and s.text_tsv @@ (websearch_to_tsquery($3, $4)))",
      "(s.head_tsv @@ (websearch_to_tsquery($1, $2)) and s.text_tsv @@ (websearch_to_tsquery($3, $4)))",
      "(s.head_tsv @@ (websearch_to_tsquery($1, $2) && websearch_to_tsquery($3, $4)))",
    ]);
    expect(pgDialect().search.letterTerms("heron or kestrel")).toHaveLength(4);
    for (const q of ["heron kestrel plover egret", '"heron" kestrel', "heron -kestrel"]) expect(pgDialect().search.letterTerms(q), q).toBeNull();
    expect(sqliteDialect().search.wordKey("00000000-0000-4000-8000-000000000001")).toBeNull();
    expect(sqliteDialect().search.letterTerms("heron kestrel")).toBeNull();
  });

  it("delivers a local announcement in-process, since that is the whole audience", async () => {
    const seen: string[] = [];
    const stop = onLocalNotify("mail", (p) => seen.push(p));
    await sqliteDialect().notify(null, "mail", "account:7");
    await sqliteDialect().notify(null, "other", "ignored");
    stop();
    await sqliteDialect().notify(null, "mail", "after-stop");
    expect(seen).toEqual(["account:7"]);
  });
});

describe("the store refuses to open below the version its schema needs", () => {
  const fts = ["ENABLE_FTS5", "THREADSAFE=1"];

  it("accepts a build that carries all three requirements", () => {
    expect(() => assertSqliteCapabilities({ version: "3.50.3", compileOptions: fts })).not.toThrow();
  });

  it("names the three reasons rather than only the number", () => {
    expect(() => assertSqliteCapabilities({ version: "3.41.9", compileOptions: fts }))
      .toThrow(/3\.42\.0/);
    expect(() => assertSqliteCapabilities({ version: "3.41.9", compileOptions: fts }))
      .toThrow(/RETURNING needs 3\.35\.0/);
  });

  it("refuses a build without full-text search, rather than answering nothing later", () => {
    expect(() => assertSqliteCapabilities({ version: "3.50.3", compileOptions: ["THREADSAFE=1"] }))
      .toThrow(/no FTS5/);
  });
});
