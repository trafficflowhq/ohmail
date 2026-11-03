import { createRequire } from "node:module";
import { PGlite } from "@electric-sql/pglite";
import { sql, type SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { SQLITE_JOURNAL } from "@ohmail/db-mail/sqlite-journal";
import { ENGLISH_STOPWORDS, ftsQueryOf } from "../src/dialect/sqlite.js";
import { partOperandsOf, partWordTails, queryOperandsOf, sqliteDialect, straddlesParts } from "../src/dialect/index.js";
import { migrateSqlite } from "../src/sqlite-migrate.js";

type Sqlite = { exec(sql: string): void; prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown } };
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => Sqlite };

/**
 * An FTS5 table as the device store declares one (mail 0138), and one as its unstemmed tables are
 * (mail 0175, no positions), each holding one row every query can be asked of.
 */
function fts(): Sqlite {
  const db = new DatabaseSync(":memory:");
  db.exec("create virtual table t using fts5(x, tokenize='porter unicode61 remove_diacritics 2')");
  db.exec("create virtual table p using fts5(x, detail=none, tokenize='unicode61 remove_diacritics 2')");
  for (const t of ["t", "p"]) db.exec(`insert into ${t}(x) values ('the sign-in code for O''Brien, node.js 3.14 and/or not near')`);
  return db;
}

/** Typed text built from the characters FTS5 and the server's parser give meaning to. */
function typedShapes(): string[] {
  // ß and é fold, and U+19B0 is a letter here that SQLite's tokenizer parts a word at.
  const alphabet = [..."ab1-'\".:/@*^()+{}[]!&|<>~#%$,;?\\ "].concat(["AND", "OR", "NOT", "NEAR", "or", "the", "sign"])
    .concat(["ß", "é", String.fromCodePoint(0x19b0)]);
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

  it("never hands FTS5 syntax it refuses, whatever was typed, in any reading", () => {
    const db = fts();
    const ask = (m: string, t = "t"): unknown[] => db.prepare(`select rowid from ${t} where ${t} match ?`).all(m);
    // The controls: the typed text itself is refused, and a table with no positions refuses a phrase.
    expect(() => ask("sign-in")).toThrow(/no such column/);
    expect(() => ask(`"a${String.fromCodePoint(0x19b0)}b"*`, "p")).toThrow(/phrase/);
    let asked = 0;
    let routed = 0;
    for (const q of typedShapes()) {
      for (const mode of ["words", "stems", "starts"] as const) {
        const f = ftsQueryOf(q, mode);
        for (const m of [f.match, f.exclude]) {
          if (m === null) continue;
          expect(() => ask(m), `${mode} ${JSON.stringify(q)} -> ${m}`).not.toThrow();
          // The unstemmed reading, and one a stopword's stem may route there (mail 0177), is asked of the tables that keep no positions too.
          if (mode === "starts" || f.stops !== null) expect(() => ask(m, "p"), `${mode} ${JSON.stringify(q)} -> ${m}`).not.toThrow();
          asked++;
        }
        if (f.stops === null) continue;
        expect(mode, "the starts reading is never routed").not.toBe("starts");
        expect(() => ask(f.stops!), `stops ${JSON.stringify(q)} -> ${f.stops}`).not.toThrow();
        routed++;
      }
    }
    expect(asked).toBeGreaterThan(1000);
    expect(routed).toBeGreaterThan(500);
  });

  it("reads the words the way the server's parser reads them", () => {
    expect(ftsQueryOf("o'brien's").match).toBe('"o brien"');
    expect(ftsQueryOf("sign-in code").match).toBe('"sign in" "code"');
    expect(ftsQueryOf("the report of the").match).toBe('"report"');
    expect(ftsQueryOf("NOT").match).toBeNull();
    expect(ftsQueryOf("minutes:budget").match).toBe('"minutes" "budget"');
    expect(ftsQueryOf("--fixture").match).toBe('"fixture"');
    expect(ftsQueryOf("fixture - ohmail")).toEqual({ match: '"fixture" NOT "ohmail"', exclude: null, stops: '"fixture" OR "ohmail"' });
    // Asked of the stopword table only when every operand is one word.
    expect(ftsQueryOf("sign-in code").stops).toBeNull();
    expect(ftsQueryOf('"ines ledger"').stops).toBeNull();
    expect(ftsQueryOf("ines or ledger").stops).toBe('"ines" OR "ledger"');
    expect(ftsQueryOf("ines", "stems").stops).toBe('"ines"');
    expect(ftsQueryOf("ines", "starts").stops).toBeNull();
  });

  it("reads a part-word twice: whole for the stemming tables, from four letters as a word's start for the unstemmed ones", () => {
    expect(ftsQueryOf("sign-in code", "stems").match).toBe('"sign" AND "code"');
    expect(ftsQueryOf("sign-in code", "starts").match).toBe('"sign"* AND "code"*');
    expect(ftsQueryOf("ines pdf", "starts").match).toBe('"ines"* AND "pdf"');
    expect(ftsQueryOf("look over", "starts").match).toBe('"look"* AND "over"*');
    // A word a device's tokenizer may part is no start: its part is read by its stem alone.
    const parted = `ines a${String.fromCodePoint(0x19b0)}b`;
    expect(ftsQueryOf(parted, "starts").match).toBeNull();
    expect(ftsQueryOf(parted, "stems").match).not.toBeNull();
    // Asked of real tables: porter stems a prefix term too (`ines`* reads `in`*), the unstemmed table does not.
    const db = new DatabaseSync(":memory:");
    db.exec("create virtual table porter using fts5(x, tokenize='porter unicode61 remove_diacritics 2')");
    db.exec("create virtual table plain using fts5(x, detail=none, tokenize='unicode61 remove_diacritics 2')");
    for (const t of ["porter", "plain"]) {
      db.exec(`insert into ${t}(rowid, x) values (1, 'Hello Inés'), (2, 'the invoice and its information'),
        (3, 'inescapable'), (4, 'the elevation report')`);
    }
    const rows = (t: string, m: string): number[] =>
      (db.prepare(`select rowid from ${t} where ${t} match ? order by rowid`).all(m) as { rowid: number }[]).map((r) => r.rowid);
    expect(rows("porter", '"ines"*'), "the control: the stemmed prefix reaches every in-").toEqual([1, 2, 3]);
    expect(rows("plain", ftsQueryOf("ines", "starts").match!)).toEqual([1, 3]);
    expect(rows("porter", ftsQueryOf("ines", "stems").match!), "the word itself, stemmed").toEqual([1]);
    expect(rows("plain", ftsQueryOf("elevat repo", "starts").match!), "a start its stem is shorter than").toEqual([4]);
  });

  it("keeps the tails the server's part-word arm reads, keyed by a part's last two letters", () => {
    expect(partWordTails("elevat")).toContain("ion");
    expect(partWordTails("elevat").length).toBeLessThan(30);
    expect(partWordTails("Elevat"), "the key is read in lower case").toEqual(partWordTails("elevat"));
    expect(partWordTails("zzzq"), "an ending no word has carries no tail").toEqual([]);
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
    const ALL = ["message_bodies_fts", "message_bodies_part_fts", "message_files_fts", "message_files_part_fts",
      "message_people_fts", "messages_fts", "messages_part_fts", "stopwords_fts"];
    const ARMS: ReadonlyArray<readonly [arm: string, pred: SQL, tables: readonly string[]]> = [
      // A porter table's reading of one-word operands reads its unstemmed twin too, as the stopword table says (mail 0177).
      ["head", d.search.words("ledger").head.pred, ["message_people_fts", "messages_fts", "messages_part_fts", "stopwords_fts"]],
      ["text", d.search.words("ledger").text.pred,
        ["message_bodies_fts", "message_bodies_part_fts", "message_files_fts", "message_files_part_fts", "stopwords_fts"]],
      ["part head", d.search.partWords("ledg")!.head.pred, ["message_people_fts", "messages_fts", "messages_part_fts", "stopwords_fts"]],
      ["part text", d.search.partWords("ledg")!.text.pred,
        ["message_bodies_fts", "message_bodies_part_fts", "message_files_fts", "message_files_part_fts", "stopwords_fts"]],
      ["exclusions only", d.search.words("-pdf").head.pred, ["message_people_fts", "messages_fts", "messages_part_fts", "stopwords_fts"]],
      ["across head", across.head.pred, [...ALL]],
      ["across text", across.text.pred, [...ALL]],
      ["across parts", d.search.partWords("ines ledg")!.text.pred, [...ALL]],
    ];
    const got: Array<{ arm: string; tables: string[]; perLetter: string[]; others: string[] }> = [];
    for (const [arm, pred] of ARMS) {
      const plan = await planOf(pred);
      const node = new Map(plan.map((r) => [r.id, r]));
      // The subquery a read belongs to, past a `UNION ALL` of reads that make one list.
      const listOf = (r: { parent: number }): string => {
        let up = node.get(r.parent);
        while (up !== undefined && /^(COMPOUND QUERY|LEFT-MOST SUBQUERY|UNION ALL)/.test(up.detail)) up = node.get(up.parent);
        return up?.detail ?? "";
      };
      // `EXISTS` marks a subquery SQLite turned into a join, read per row.
      const reads = plan.filter((r) => /^SCAN \w+_fts (EXISTS )?VIRTUAL TABLE/.test(r.detail));
      got.push({
        arm, tables: [...new Set(reads.map((r) => r.detail.split(" ")[1]!))].sort(),
        // A words table asked per letter (`rowid = ?`) or under a correlated subquery costs a read a letter;
        // the stopword table is asked once, as one uncorrelated value (mail 0177), never as a list joined per letter.
        perLetter: reads.filter((r) => /:=/.test(r.detail)
          || !(r.detail.startsWith("SCAN stopwords_fts ") ? /^SCALAR SUBQUERY/ : /^LIST SUBQUERY/).test(listOf(r))).map((r) => r.detail),
        // Nothing read beside the letter, its body and the word lists: the document is never looked up.
        others: plan.filter((r) => /^(SEARCH|SCAN) /.test(r.detail) && !/^(SEARCH|SCAN) (m|b|\w+_fts)\b/.test(r.detail)).map((r) => r.detail),
      });
    }
    expect(got).toEqual(ARMS.map(([arm, , tables]) => ({ arm, tables: [...tables], perLetter: [], others: [] })));
  });
});

describe("the server's stopwords on the device (mail 0177)", () => {
  it("are one porter row that tells which words share a stopword's stem, and a second run writes the same", async () => {
    const db = new DatabaseSync(":memory:");
    const target = { run: async (s: string) => { db.exec(s); }, all: async <T,>(s: string) => db.prepare(s).all() as T[] };
    await migrateSqlite(target, SQLITE_JOURNAL);
    db.exec("create virtual table control using fts5(words, tokenize='porter unicode61 remove_diacritics 2')");
    db.prepare("insert into control(words) values (?)").run([...ENGLISH_STOPWORDS].join(" "));
    db.exec("create virtual table got_v using fts5vocab(stopwords_fts, row); create virtual table control_v using fts5vocab(control, row)");
    const terms = (v: string): string[] => (db.prepare(`select term from ${v} order by term`).all() as { term: string }[]).map((r) => r.term);
    expect(terms("got_v").length).toBeGreaterThan(100);
    expect(terms("got_v")).toEqual(terms("control_v"));
    const shares = (w: string): boolean => db.prepare("select 1 from stopwords_fts where stopwords_fts match ?").all(`"${w}"`).length > 0;
    expect(["ines", "ones", "willing", "outing"].filter(shares)).toEqual(["ines", "ones", "willing", "outing"]);
    expect(["ledger", "invoice", "meeting"].filter(shares)).toEqual([]);
    const entry = SQLITE_JOURNAL.find((e) => e.name.endsWith("_device_stopword_stems.sql"))!;
    for (const statement of entry.statements) db.exec(statement);
    expect(terms("got_v"), "a second run wrote other words").toEqual(terms("control_v"));
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

/**
 * MAIL 0175 ON A STORE THAT ALREADY HOLDS MAIL: the three unstemmed tables are built in place over
 * 40,000 letters from the rows already there, find every word by its first four letters, follow each
 * write after it, keep nothing of a deleted letter, and build the same tables when run again.
 */
describe("the device's unstemmed words (mail 0175) on a store that already holds mail", () => {
  const LETTERS = 40_000;
  const SYLLABLES = ["ka", "lor", "mi", "sen", "tavi", "qu", "ren", "dol", "fe", "brix", "nor", "pel", "vos", "zan", "gil", "hut"];

  it("are built in place, read every word by its start, follow every write, and keep nothing of a deleted letter", async () => {
    const db = new DatabaseSync(":memory:");
    const target = { run: async (s: string) => { db.exec(s); }, all: async <T,>(s: string) => db.prepare(s).all() as T[] };
    const at = SQLITE_JOURNAL.findIndex((e) => e.name.endsWith("_device_part_words.sql"));
    expect(at, "the entry is in the device journal").toBeGreaterThan(0);
    await migrateSqlite(target, SQLITE_JOURNAL.slice(0, at));
    let seed = 11;
    const next = (n: number): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    const word = (): string => Array.from({ length: 2 + next(3) }, () => SYLLABLES[next(SYLLABLES.length)]).join("");
    const words = (n: number): string[] => Array.from({ length: n }, word);
    db.exec("insert into accounts (id) values ('acct')");
    db.exec("insert into mailboxes (id, account_id, provider, address) values ('mb', 'acct', 'imap', 'owner@device.example')");
    const letters: Array<{ id: string; subject: string[]; sender: string; body: string[]; file: string | null }> = [];
    const insert = {
      message: db.prepare(`insert into messages (id, account_id, mailbox_id, subject, from_address, body_hash, dedup_key, date)
        values (?, 'acct', 'mb', ?, ?, ?, ?, ?)`),
      body: db.prepare("insert into message_bodies (message_id, text) values (?, ?)"),
      file: db.prepare("insert into attachments (account_id, message_id, filename, content_type) values ('acct', ?, ?, 'application/pdf')"),
      document: db.prepare("insert into message_search (message_id, account_id, source) values (?, 'acct', 'text')"),
    };
    db.exec("BEGIN");
    for (let i = 0; i < LETTERS; i++) {
      const letter = { id: `m${i}`, subject: words(3), sender: word(), body: words(24), file: i % 3 === 0 ? `${word()}-${i}.pdf` : null };
      insert.message.run(letter.id, letter.subject.join(" "), `${letter.sender}@site${i % 40}.example`, `h${i}`, `k${i}`, 1_700_000_000_000 + i);
      insert.body.run(letter.id, letter.body.join(" "));
      if (letter.file !== null) insert.file.run(letter.id, letter.file);
      insert.document.run(letter.id);
      letters.push(letter);
    }
    db.exec("COMMIT");
    const started = performance.now();
    expect(await migrateSqlite(target, SQLITE_JOURNAL.slice(0, at + 1))).toEqual([SQLITE_JOURNAL[at]!.name]);
    console.log(`mail 0175 over ${LETTERS} letters: ${Math.round(performance.now() - started)} ms`);

    const rows = (table: string, start: string): Set<number> =>
      new Set((db.prepare(`select rowid from ${table} where ${table} match ?`).all(`"${start}"*`) as { rowid: number }[]).map((r) => r.rowid));
    const rowidOf = (table: "messages" | "message_bodies", id: string): number =>
      (db.prepare(`select rowid from ${table} where ${table === "messages" ? "id" : "message_id"} = ?`).all(id) as { rowid: number }[])[0]!.rowid;
    const missed: string[] = [];
    for (let k = 0; k < 40; k++) {
      const letter = letters[next(LETTERS)]!;
      const own = rowidOf("messages", letter.id);
      const start = (w: string): string => w.slice(0, 4);
      if (!rows("messages_part_fts", start(letter.subject[next(3)]!)).has(own)) missed.push(`${letter.id} subject`);
      if (!rows("messages_part_fts", start(letter.sender)).has(own)) missed.push(`${letter.id} sender`);
      if (!rows("message_bodies_part_fts", start(letter.body[next(24)]!)).has(rowidOf("message_bodies", letter.id))) missed.push(`${letter.id} body`);
      if (letter.file !== null && !rows("message_files_part_fts", start(letter.file)).has(own)) missed.push(`${letter.id} file`);
    }
    expect(missed, "a word the letter holds was not found by its first four letters").toEqual([]);

    /* EVERY WRITE AFTER IT: a new letter, its subject and its body changed, then the letter gone. */
    db.exec(`insert into messages (id, account_id, mailbox_id, subject, from_address, body_hash, dedup_key)
      values ('new', 'acct', 'mb', 'Zephyrine notes', 'quillon@post.example', 'hn', 'kn')`);
    db.exec("insert into message_bodies (message_id, text) values ('new', 'a marmalade ledger')");
    db.exec("insert into attachments (account_id, message_id, filename, content_type) values ('acct', 'new', 'lanternfish-77.pdf', 'application/pdf')");
    db.exec("insert into message_search (message_id, account_id, source) values ('new', 'acct', 'text')");
    const fresh = rowidOf("messages", "new");
    const body = rowidOf("message_bodies", "new");
    expect([...rows("messages_part_fts", "zeph")], "a new letter's subject").toEqual([fresh]);
    expect([...rows("messages_part_fts", "quil")], "a new letter's sender").toEqual([fresh]);
    expect([...rows("message_bodies_part_fts", "marm")], "a new letter's body").toEqual([body]);
    expect([...rows("message_files_part_fts", "lant")], "a new letter's file name").toEqual([fresh]);
    db.exec("update messages set subject = 'Ptarmigan notes' where id = 'new'");
    db.exec("update message_bodies set text = 'an oriole' where message_id = 'new'");
    expect([rows("messages_part_fts", "zeph").size, [...rows("messages_part_fts", "ptar")]], "a changed subject").toEqual([0, [fresh]]);
    expect([rows("message_bodies_part_fts", "marm").size, [...rows("message_bodies_part_fts", "orio")]], "a changed body").toEqual([0, [body]]);
    for (const t of ["message_search", "attachments", "message_bodies"]) db.exec(`delete from ${t} where message_id = 'new'`);
    db.exec("delete from messages where id = 'new'");
    const left = [rows("messages_part_fts", "ptar"), rows("messages_part_fts", "quil"), rows("message_bodies_part_fts", "orio"),
      rows("message_files_part_fts", "lant")].map((r) => r.size);
    expect(left, "a deleted letter's words are still in a table").toEqual([0, 0, 0, 0]);
    for (const t of ["messages_part_fts", "message_bodies_part_fts", "message_files_part_fts"]) {
      db.exec(`insert into ${t}(${t}) values ('integrity-check')`);
    }

    /* AND A SECOND RUN BUILDS THE SAME TABLES. */
    const probes = letters.slice(0, 8).flatMap((l) => [l.subject[0]!, l.body[0]!, l.file ?? l.sender].map((w) => w.slice(0, 4)));
    const counts = (): number[] => probes.flatMap((p) =>
      ["messages_part_fts", "message_bodies_part_fts", "message_files_part_fts"].map((t) => rows(t, p).size));
    const before = counts();
    for (const statement of SQLITE_JOURNAL[at]!.statements) db.exec(statement);
    expect(counts(), "a second run built different tables").toEqual(before);
  }, 120_000);
});
