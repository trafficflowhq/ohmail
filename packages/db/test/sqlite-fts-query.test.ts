import { createRequire } from "node:module";
import { PGlite } from "@electric-sql/pglite";
import { sql, type SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { SQLITE_JOURNAL } from "@ohmail/db-mail/sqlite-journal";
import { ENGLISH_STOPWORDS, ftsQueryOf } from "../src/dialect/sqlite.js";
import { partOperandsOf, partWordTails, queryOperandsOf, sqliteDialect, straddlesParts } from "../src/dialect/index.js";
import { migrateSqlite } from "../src/sqlite-migrate.js";

type Sqlite = { exec(sql: string): void; prepare(sql: string): { all(...p: unknown[]): unknown[] } };
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => Sqlite };

/** An FTS5 table as the device store declares one (mail 0138), holding one row every query can be asked of. */
function fts(): Sqlite {
  const db = new DatabaseSync(":memory:");
  db.exec("create virtual table t using fts5(x, tokenize='porter unicode61 remove_diacritics 2')");
  db.exec("insert into t(x) values ('the sign-in code for O''Brien, node.js 3.14 and/or not near')");
  return db;
}

/** Typed text built from the characters FTS5 and the server's parser give meaning to. */
function typedShapes(): string[] {
  const alphabet = [..."ab1-'\".:/@*^()+{}[]!&|<>~#%$,;?\\ "].concat(["AND", "OR", "NOT", "NEAR", "or", "the", "sign"]);
  let seed = 7;
  const next = (n: number): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
  const out = ["sign-in", "o'brien's", "NEAR(x y)", "a OR", "NOT", "-", "--x", "\"", "x:*", "^x", "x AND -y"];
  for (let i = 0; i < 2000; i++) out.push(Array.from({ length: 1 + next(8) }, () => alphabet[next(alphabet.length)]).join(""));
  return out;
}

describe("the device store's full-text query builder", () => {
  it("drops exactly the stopwords the server's english parser drops — read from the server's own file", async () => {
    const pg = new PGlite();
    const [{ setting }] = (await pg.query<{ setting: string }>("select setting from pg_config where name = 'SHAREDIR'")).rows as [{ setting: string }];
    const [{ f }] = (await pg.query<{ f: string }>("select pg_read_file($1) as f", [`${setting}/tsearch_data/english.stop`])).rows as [{ f: string }];
    const server = f.split(/\s+/).filter(Boolean).sort();
    expect(server.length).toBeGreaterThan(100);
    expect([...ENGLISH_STOPWORDS].sort()).toEqual(server);
    // The control that the file IS the parser's list: every word in it leaves no lexeme.
    const [{ v }] = (await pg.query<{ v: string }>("select to_tsvector('english', $1)::text as v", [server.join(" ")])).rows as [{ v: string }];
    expect(v).toBe("");
    await pg.close();
  });

  it("never hands FTS5 syntax it refuses, whatever was typed, in either reading", () => {
    const db = fts();
    const ask = (m: string): unknown[] => db.prepare("select rowid from t where t match ?").all(m);
    // The control: the typed text itself is refused, so a refusal here is visible.
    expect(() => ask("sign-in")).toThrow(/no such column/);
    let asked = 0;
    for (const q of typedShapes()) {
      for (const mode of ["words", "parts"] as const) {
        const f = ftsQueryOf(q, mode);
        for (const m of [f.match, f.exclude]) {
          if (m === null) continue;
          expect(() => ask(m), `${mode} ${JSON.stringify(q)} -> ${m}`).not.toThrow();
          asked++;
        }
      }
    }
    expect(asked).toBeGreaterThan(1000);
  });

  it("reads the words the way the server's parser reads them", () => {
    expect(ftsQueryOf("o'brien's").match).toBe('"o brien"');
    expect(ftsQueryOf("sign-in code").match).toBe('"sign in" "code"');
    expect(ftsQueryOf("the report of the").match).toBe('"report"');
    expect(ftsQueryOf("NOT").match).toBeNull();
    expect(ftsQueryOf("minutes:budget").match).toBe('"minutes" "budget"');
    expect(ftsQueryOf("--fixture").match).toBe('"fixture"');
    expect(ftsQueryOf("fixture - ohmail")).toEqual({ match: '"fixture" NOT "ohmail"', exclude: null });
  });

  it("reads a part-word as ONE parenthesised group per word, ANDed: the prefix OR the word plus each tail", () => {
    const group = (w: string): string => `(${[`"${w}"*`, ...partWordTails(w).map((t) => `"${w}${t}"`)].join(" OR ")})`;
    // Keyed by the part's last two letters: `elevat` carries the tails of words in `-at`, not 290.
    expect(partWordTails("elevat")).toContain("ion");
    expect(partWordTails("elevat").length).toBeLessThan(30);
    expect(partWordTails("Elevat"), "the key is read in lower case").toEqual(partWordTails("elevat"));
    expect(partWordTails("zzzq"), "an ending no word has carries no tail").toEqual([]);
    expect(ftsQueryOf("sign-in code", "parts").match).toBe(`${group("sign")} AND ${group("code")}`);
    expect(ftsQueryOf("look over", "parts").match).toBe(`${group("look")} AND ${group("over")}`);
    // The parentheses decide: FTS5 binds AND tighter than OR, so without them one tail form of the
    // first word matches alone. Asked of a real porter table, with the unparenthesised form beside it.
    const db = new DatabaseSync(":memory:");
    db.exec("create virtual table t using fts5(x, tokenize='porter unicode61 remove_diacritics 2')");
    db.exec("insert into t(rowid, x) values (1, 'the elevation report'), (2, 'the elevation')");
    const rows = (m: string): number[] => (db.prepare("select rowid from t where t match ? order by rowid").all(m) as { rowid: number }[]).map((r) => r.rowid);
    expect(rows(ftsQueryOf("elevat repo", "parts").match!)).toEqual([1]);
    const bare = [group("elevat"), group("repo")].map((g) => g.slice(1, -1)).join(" AND ");
    expect(rows(bare), "the control: without the parentheses the lone word matches").toEqual([1, 2]);
  });
});

describe("the device store's people and file names' words (mail 0173)", () => {
  /** The plan of one arm's read, joined as the search service joins it. */
  async function planOf(pred: SQL): Promise<Array<{ id: number; parent: number; detail: string }>> {
    const db = new DatabaseSync(":memory:");
    await migrateSqlite({ run: async (s: string) => { db.exec(s); }, all: async <T,>(s: string) => db.prepare(s).all() as T[] }, SQLITE_JOURNAL);
    const q = new SQLiteSyncDialect().sqlToQuery(sql`select m.id from messages m
      left join message_search s on s.message_id = m.id left join message_bodies b on b.message_id = m.id
      where m.account_id = ${"a"} and ${pred} order by m.date desc limit 40`);
    return db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params) as Array<{ id: number; parent: number; detail: string }>;
  }

  it("are each read once as a list of letters, people with the head and file names with the text, never the document", async () => {
    const d = sqliteDialect();
    const across = d.search.words("ines ledger");
    const ARMS: ReadonlyArray<readonly [arm: string, pred: SQL, tables: readonly string[]]> = [
      ["head", d.search.words("ledger").head.pred, ["message_people_fts", "messages_fts"]],
      ["text", d.search.words("ledger").text.pred, ["message_bodies_fts", "message_files_fts"]],
      ["part head", d.search.partWords("ledg")!.head.pred, ["message_people_fts", "messages_fts"]],
      ["part text", d.search.partWords("ledg")!.text.pred, ["message_bodies_fts", "message_files_fts"]],
      ["exclusions only", d.search.words("-pdf").head.pred, ["message_people_fts", "messages_fts"]],
      ["across head", across.head.pred, ["message_bodies_fts", "message_files_fts", "message_people_fts", "messages_fts"]],
      ["across text", across.text.pred, ["message_bodies_fts", "message_files_fts", "message_people_fts", "messages_fts"]],
      ["across parts", d.search.partWords("ines ledg")!.text.pred, ["message_bodies_fts", "message_files_fts", "message_people_fts", "messages_fts"]],
    ];
    const got: Array<{ arm: string; tables: string[]; perLetter: string[]; others: string[] }> = [];
    for (const [arm, pred] of ARMS) {
      const plan = await planOf(pred);
      const parent = new Map(plan.map((r) => [r.id, r.detail]));
      const reads = plan.filter((r) => /^SCAN \w+_fts VIRTUAL TABLE/.test(r.detail));
      got.push({
        arm, tables: [...new Set(reads.map((r) => r.detail.split(" ")[1]!))].sort(),
        // A words table asked per letter (`rowid = ?`) or under a correlated subquery costs a read a letter.
        perLetter: reads.filter((r) => /:=/.test(r.detail) || !/^LIST SUBQUERY/.test(parent.get(r.parent) ?? "")).map((r) => r.detail),
        // Nothing read beside the letter, its body and the word lists: the document is never looked up.
        others: plan.filter((r) => /^(SEARCH|SCAN) /.test(r.detail) && !/^(SEARCH|SCAN) (m|b|\w+_fts)\b/.test(r.detail)).map((r) => r.detail),
      });
    }
    expect(got).toEqual(ARMS.map(([arm, , tables]) => ({ arm, tables: [...tables], perLetter: [], others: [] })));
  });
});

describe("a query's operands, as both stores read its structure", () => {
  const w = (text: string, quoted = false) => ({ text, quoted });
  it("groups ANDed operands by `or`, sets excluded ones apart and drops stopword-only ones", () => {
    expect(queryOperandsOf("kai lanternfish")).toEqual({ any: [[w("kai"), w("lanternfish")]], none: [] });
    expect(queryOperandsOf("from:kai survey"), "`:` separates, `from` is a stopword").toEqual({ any: [[w("kai"), w("survey")]], none: [] });
    expect(queryOperandsOf("kai samples or food")).toEqual({ any: [[w("kai"), w("samples")], [w("food")]], none: [] });
    expect(queryOperandsOf("kai -lanternfish")).toEqual({ any: [[w("kai")]], none: [w("lanternfish")] });
    expect(queryOperandsOf('"lanternfish survey" sign-in')).toEqual({ any: [[w("lanternfish survey", true), w("sign-in")]], none: [] });
    expect(queryOperandsOf("--fixture or or"), "`--` does not exclude; a trailing `or` starts nothing").toEqual({ any: [[w("fixture")]], none: [] });
    expect(queryOperandsOf("the of -the")).toEqual({ any: [], none: [] });
  });

  it("straddles the letter's parts with two ANDed operands or an exclusion, up to eight operands asked", () => {
    expect(straddlesParts(queryOperandsOf("lanternfish"))).toBe(false);
    expect(straddlesParts(queryOperandsOf('"lanternfish survey"'))).toBe(false);
    expect(straddlesParts(queryOperandsOf("kai or food"))).toBe(false);
    expect(straddlesParts(queryOperandsOf("kai lanternfish"))).toBe(true);
    expect(straddlesParts(queryOperandsOf("-lanternfish"))).toBe(true);
    expect(straddlesParts(queryOperandsOf("a1 a2 a3 a4 a5 a6 a7 a8"))).toBe(true);
    expect(straddlesParts(queryOperandsOf("a1 a2 a3 a4 a5 a6 a7 a8 a9")), "past eight: read per part").toBe(false);
    expect(straddlesParts(queryOperandsOf("a1 a2 -b1 -b2 -b3 -b4 -b5 -b6 -b7")), "an excluded operand never counts").toBe(true);
    expect(straddlesParts(queryOperandsOf("a1 a2 a3 a4 a5 a6 a7 a8 a9 -b1"))).toBe(false);
  });

  it("keeps a typed operand's part-words together in one part; one operand is read per part", () => {
    expect(partOperandsOf("anna@club.ch"), "an address is one operand").toBeNull();
    expect(partOperandsOf("re-enter")).toBeNull();
    expect(partOperandsOf("the lantern"), "a stopword-only operand is dropped").toBeNull();
    expect(partOperandsOf("lantern kai")).toEqual([[0], [1]]);
    expect(partOperandsOf("anna@club.ch dinner")).toEqual([[0, 1, 2], [3]]);
    expect(partOperandsOf("kai samples or food"), "`or` keeps no word").toEqual([[0], [1], [3]]);
  });
});
