import { describe, it, expect } from "vitest";
import { getTableConfig as pgConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { getTableConfig as sqliteConfig, SQLiteSyncDialect, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { is, getTableName } from "drizzle-orm";
import { PgTable as PgTableClass } from "drizzle-orm/pg-core";
import { SQLiteTable as SQLiteTableClass } from "drizzle-orm/sqlite-core";
import * as pgSchema from "../src/schema-mail.js";
import * as sqliteSchema from "../src/schema-mail-sqlite.js";
import { CLOSED_SETS } from "../src/closed-sets.js";

/**
 * THE TWO SCHEMAS ARE ONE SCHEMA, AND THIS IS THE ONLY THING THAT SAYS SO.
 *
 * Services import tables by name and are typed against the Postgres twin; a build for a device
 * swaps the SQLite twin in underneath them. That substitution is silent — the wrong column name
 * does not fail to compile, it fails at the first query on a device nobody is holding — so the
 * agreement is asserted structurally here rather than trusted.
 *
 * The comparison is over what the query builder itself believes about each table, not over the
 * source text: a rename that both files spell the same way in prose and differently in the string
 * literal would pass a textual diff and fail here, which is the right way round.
 *
 * WHAT IT COMPARES, stated so nobody reads more into it: table and column names, column ORDER, the
 * KIND each column stores, NOT NULL, whether each column has a DEFAULT, primary keys, unique
 * constraints, indexes with their columns — expressions included, rendered and compared as text —
 * whether each index is unique or partial, each index's PREDICATE, and CHECK names and expressions.
 * Expressions and predicates are compared after normalising the two dialects' quoting; the one
 * construct the two stores must spell differently is recorded in `DIALECT_EXPRESSIONS` with both
 * halves written out.
 *
 * It does NOT compare the DEFAULT's value — only that one is present. The two stores spell `now()`
 * and a UUID differently by necessity, and a comparison of the text would be a list of exceptions
 * rather than a check. Types are compared as the query
 * builder's own column KIND, not the SQL type name — `integer` is what a timestamp, a boolean and
 * an ordinary integer all render to on this store, so comparing type names let three distinct
 * decisions collapse into one and a column could stop converting to a `Date` and still pass.
 *
 * What it does NOT compare: a default's VALUE, and the CHECK/predicate expressions are compared in
 * a normalised form that ignores quoting, whitespace and table qualification. Stated so nobody
 * reads more into a green than is there.
 */

/**
 * THE RULED TYPE MAPPING, column for column — the one thing the identifiers cannot tell you.
 *
 * Without it the test compared no type at all, and a column could be text on one twin and an
 * integer on the other and pass every assertion: the drift most likely to happen and least likely
 * to be caught, because the name is what a reader checks.
 *
 * It is a MAPPING and not a shared "kind", which was the first attempt and was worse than nothing:
 * this store spells timestamps, booleans, large counters and ordinary integers all as `integer`, so
 * any scheme that normalised both sides to one word collapsed four distinct decisions into one and
 * stopped discriminating. Naming the pair keeps each decision visible — and a pg type absent from
 * this table fails loudly, so a new column type has to be ruled on rather than defaulted.
 */
const RULED_TYPE: Record<string, string> = {
  PgText: "SQLiteText",
  PgUUID: "SQLiteText",
  PgTimestamp: "SQLiteTimestamp",
  PgJsonb: "SQLiteTextJson",
  PgBoolean: "SQLiteBoolean",
  PgInteger: "SQLiteInteger",
  PgBigInt53: "SQLiteInteger",
  PgBigInt64: "SQLiteCustomColumn",
  PgReal: "SQLiteReal",
  /* A calendar day (mail 0166's `kept_from`) is its ISO 'YYYY-MM-DD' text on this store: the server's
     `date` reads back as that same string, so both twins hand the code one shape. */
  PgDateString: "SQLiteText",
  /* A `text[]` becomes a JSON array of strings, ruled for the 0.18 re-stack: this store has no
     array type, and the twin already rules jsonb the same way, so `piles` is stored and read the
     way every other list on the device is. The closed set stays in the migration on both stores. */
  PgArray: "SQLiteTextJson",
};

/** What the SQLite twin must declare for a column the Postgres twin declares as `pgType`. */
function ruledFor(pgType: string): string {
  const mapped = RULED_TYPE[pgType];
  if (mapped === undefined) {
    throw new Error(
      `no ruling for the Postgres column type '${pgType}'. A type this table does not name is a ` +
      "decision nobody has made about the device store — add it here with the type it becomes.",
    );
  }
  return mapped;
}

/**
 * A CHECK body or index predicate, in a form the two dialects can be compared in.
 *
 * The two render the same expression differently — table qualification, quoting, whitespace — so
 * an exact comparison would refuse every row for reasons that are not drift. Normalising those
 * away leaves the part that IS the decision: which columns, which operator, which literals.
 */
function normalizeExpr(rendered: string): string {
  return rendered
    .replace(/"[a-z_]+"\./g, "")     // the owning table's qualifier, which only one side writes
    .replace(/["`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * CHECKS THE SERVER CARRIES AND A DEVICE MAY NOT, which is a difference of MIGRATION COST.
 *
 * SQLite has no `ALTER … DROP CONSTRAINT`, so a set the server widens by DROP-then-ADD would cost
 * a fifty-column table rebuild on every device once the baseline ships. Those sets are enforced at
 * the write door instead and carry no CHECK here. The asymmetry is OWNED by
 * `closed-set-parity.test.ts`, which asserts the class against the pg journal's own history and
 * reddens if one of them reappears on this store — dropping the names here compares the rest.
 */
const WIDENABLE_SET_CHECKS = new Set(
  CLOSED_SETS.filter((s) => s.kind === "widenable").map((s) => s.constraint),
);

/**
 * The ONE difference the two twins are allowed, and it is a difference of storage, not of data:
 * the server's word vectors. The device's word index is FTS5 over the rows themselves, so the
 * generated columns and mail 0125's two search-document vectors have no twin there.
 */
const GENERATED_SEARCH_COLUMNS: Record<string, readonly string[]> = {
  messages: ["subject_tsv"],
  message_bodies: ["body_tsv"],
  kb_entries: ["kb_tsv"],
  message_search: ["head_tsv", "text_tsv"],
};

/**
 * Tables only the device declares, each standing in for a server index this store cannot spell:
 * mail 0154's `message_recipients`, the side table its triggers keep in place of the server's
 * expression GIN over To and Cc. It holds no data of its own; the server has no table to compare.
 */
const DEVICE_ONLY_TABLES = new Set(["messageRecipients"]);

/** Indexes that exist only to serve those columns, and go with them. */
const GENERATED_SEARCH_INDEXES = new Set([
  "messages_subject_tsv_idx", "message_bodies_body_tsv_idx", "kb_entries_kb_tsv_idx",
  "message_search_head_tsv_idx", "message_search_text_tsv_idx",
]);

/**
 * INDEX EXPRESSIONS THE TWO DIALECTS MUST SPELL DIFFERENTLY, and the exact spelling of each.
 *
 * Most expressions are the same text on both stores — `lower(address)` is `lower(address)`. One is
 * not: taking the domain from an address needs `substring … from position(…)` on the server and
 * `substr(…, instr(…))` on the device, because neither store has the other's function.
 *
 * Recording the pair is the point. The parity check used to reduce EVERY expression to the literal
 * string "expr", which made all four of them equal to each other — an index on `lower(address)`
 * and an index on something else entirely compared the same, so the one difference that is real
 * was invisible alongside three that would have been bugs. Both halves are written out here, so a
 * change to either side is a change to this table and not a silent divergence.
 */
/**
 * CHECK BODIES THE TWO DIALECTS MUST SPELL DIFFERENTLY, and the exact spelling of each.
 *
 * The same reasoning as {@link DIALECT_EXPRESSIONS} one block down, for constraint bodies rather
 * than index expressions. One entry today: the send fingerprint's shape. The server states it as a
 * POSIX regex; this store has no regex operator at all, and its only door to one is a
 * host-registered `REGEXP` function — a CHECK depending on that makes the file unopenable by a host
 * that does not register it, which is exactly the class of failure `sqlite-baseline.test.ts`
 * refuses hosts for by capability. `length(...) = 64 and ... not glob '*[^0-9a-f]*'` is the same
 * predicate in constructs the store has, and it is not weaker: a fingerprint that is not 64
 * lowercase hex characters is refused on the phone too.
 *
 * BOTH HALVES ARE ASSERTED. A change to either spelling is a change to this table and not a silent
 * divergence, and a name that is not here must render identically on both.
 */
const DIALECT_CHECKS: Record<string, { pg: string; sqlite: string }> = {
  outbound_send_fingerprints_hex: {
    pg: "fingerprint ~ '^[0-9a-f]{64}$'",
    sqlite: "length(fingerprint) = 64 and fingerprint not glob '*[^0-9a-f]*'",
  },
};

/** A CHECK's comparable text: the rendered body, or a declared per-dialect pair collapsed to one
 *  token AFTER its own half is checked against the table above. */
function checkText(name: string, rendered: string, arm: "pg" | "sqlite"): string {
  const declared = DIALECT_CHECKS[name];
  if (declared === undefined) return rendered;
  if (rendered !== declared[arm]) {
    throw new Error(
      `${name} on the ${arm} twin renders as ${rendered}, and DIALECT_CHECKS records ` +
      `${declared[arm]}. Update the table if the change was intended — it is written down so the ` +
      "two dialects' spellings cannot drift apart unnoticed.",
    );
  }
  return `<declared-check:${name}>`;
}

const DIALECT_EXPRESSIONS: Record<string, { pg: string; sqlite: string }> = {
  messages_account_from_domain_idx: {
    pg: "substring(lower(from_address) from position('@' in lower(from_address)) + 1)",
    sqlite: "substr(lower(from_address), instr(lower(from_address), '@') + 1)",
  },
};

/**
 * The text an index column contributes to the comparison: a plain column's name, or the rendered
 * expression. A declared per-dialect pair collapses to one token AFTER its own half is checked
 * against the table above, so the two shapes can be compared as equals without the difference
 * ceasing to be recorded.
 */
function indexColumnText(
  indexName: string,
  col: unknown,
  arm: "pg" | "sqlite",
  render: (c: unknown) => string,
): string {
  if (col !== null && typeof col === "object" && "name" in col) return String((col as { name: unknown }).name);
  const rendered = normalizeExpr(render(col));
  const declared = DIALECT_EXPRESSIONS[indexName];
  if (declared === undefined) return rendered;
  if (rendered !== declared[arm]) {
    throw new Error(
      `${indexName} on the ${arm} twin renders as ${rendered}, and DIALECT_EXPRESSIONS records ` +
      `${declared[arm]}. Update the table if the change was intended — it is written down so the ` +
      "two dialects' spellings cannot drift apart unnoticed.",
    );
  }
  return `<declared:${indexName}>`;
}

/**
 * A foreign key as one comparable line: which columns point where, and what happens to the row when
 * the target moves or goes.
 *
 * The two twins carry 34 of these each and nothing compared them. Columns, types, indexes, checks
 * and uniqueness can all agree while a reference points at a different table, loses its cascade, or
 * gains one — and the device would then enforce a different relationship from the server with every
 * other signal green. The cascade is the half that bites quietly: a delete that removes a row on one
 * store and orphans it on the other produces two databases that disagree without either erroring.
 */
function foreignKeySignatures(
  keys: readonly { reference: () => { columns: readonly { name: string }[]; foreignTable: object; foreignColumns: readonly { name: string }[] }; onDelete?: string; onUpdate?: string }[],
): string[] {
  return keys.map((fk) => {
    const r = fk.reference();
    // Absent means "no action" in both stores. Spelling it out keeps a twin that says so explicitly
    // equal to one that leaves it out, which is a difference of style and not of behaviour.
    const act = (a: string | undefined) => (a ?? "no action").toLowerCase();
    return `${r.columns.map((c) => c.name).join(",")} -> ${getTableName(r.foreignTable as never)}`
      + `(${r.foreignColumns.map((c) => c.name).join(",")})`
      + ` on delete ${act(fk.onDelete)} on update ${act(fk.onUpdate)}`;
  }).sort();
}

/**
 * An index's name, REFUSED rather than defaulted. drizzle names every index declared here, so an
 * absent name is a shape change and not a blank — defaulting it to "" would collapse two unnamed
 * indexes into one comparable token and pass.
 */
function indexName(i: { config: { name?: string } }): string {
  if (i.config.name === undefined || i.config.name === "") {
    throw new Error(
      "an index with no name reached the parity comparison — every index declared in these two " +
      "modules is named, so this is a change in shape rather than a value to default",
    );
  }
  return i.config.name;
}

interface Shape {
  columns: string[];
  types: string[];
  defaults: string[];
  checks: string[];
  indexPredicates: string[];
  notNull: string[];
  primaryKey: string[];
  uniques: string[];
  indexes: { name: string; columns: string[]; unique: boolean; partial: boolean }[];
  foreignKeys: string[];
}

function pgShape(table: PgTable): Shape {
  const c = pgConfig(table);
  const drop = new Set(GENERATED_SEARCH_COLUMNS[c.name] ?? []);
  return {
    columns: c.columns.filter((col) => !drop.has(col.name)).map((col) => col.name),
    types: c.columns.filter((col) => !drop.has(col.name)).map((col) => ruledFor(col.columnType)),
    defaults: c.columns.filter((col) => !drop.has(col.name))
      .map((col) => `${col.name}:${col.hasDefault ? "has" : "none"}`),
    checks: c.checks.filter((ck) => !WIDENABLE_SET_CHECKS.has(ck.name))
      .map((ck) => `${ck.name}:${checkText(ck.name, normalizeExpr(new PgDialect().sqlToQuery(ck.value).sql), "pg")}`).sort(),
    foreignKeys: foreignKeySignatures(c.foreignKeys as never),
    indexPredicates: c.indexes
      .filter((i) => !GENERATED_SEARCH_INDEXES.has(indexName(i)))
      .map((i) => `${indexName(i)}:${i.config.where ? normalizeExpr(new PgDialect().sqlToQuery(i.config.where).sql) : "-"}`)
      .sort(),
    notNull: c.columns.filter((col) => !drop.has(col.name) && col.notNull).map((col) => col.name),
    primaryKey: c.columns.filter((col) => col.primary).map((col) => col.name)
      .concat(c.primaryKeys.flatMap((pk) => pk.columns.map((col) => col.name))).sort(),
    uniques: c.uniqueConstraints.map((u) => u.columns.map((col) => col.name).join(",")).sort(),
    indexes: c.indexes
      .filter((i) => !GENERATED_SEARCH_INDEXES.has(indexName(i)))
      .map((i) => ({
        name: indexName(i),
        columns: i.config.columns.map((col) =>
          indexColumnText(indexName(i), col, "pg", (c) => new PgDialect().sqlToQuery(c as never).sql)),
        unique: i.config.unique === true,
        partial: i.config.where !== undefined,
      })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function sqliteShape(table: SQLiteTable): Shape {
  const c = sqliteConfig(table);
  return {
    columns: c.columns.map((col) => col.name),
    types: c.columns.map((col) => col.columnType),
    defaults: c.columns.map((col) => `${col.name}:${col.hasDefault ? "has" : "none"}`),
    checks: c.checks.map((ck) => `${ck.name}:${checkText(ck.name, normalizeExpr(new SQLiteSyncDialect().sqlToQuery(ck.value).sql), "sqlite")}`).sort(),
    foreignKeys: foreignKeySignatures(c.foreignKeys as never),
    indexPredicates: c.indexes
      .map((i) => `${i.config.name}:${i.config.where ? normalizeExpr(new SQLiteSyncDialect().sqlToQuery(i.config.where).sql) : "-"}`)
      .sort(),
    notNull: c.columns.filter((col) => col.notNull).map((col) => col.name),
    primaryKey: c.columns.filter((col) => col.primary).map((col) => col.name)
      .concat(c.primaryKeys.flatMap((pk) => pk.columns.map((col) => col.name))).sort(),
    uniques: c.uniqueConstraints.map((u) => u.columns.map((col) => col.name).join(",")).sort(),
    indexes: c.indexes.map((i) => ({
      name: i.config.name,
      columns: i.config.columns.map((col) =>
        indexColumnText(i.config.name, col, "sqlite",
          (c) => new SQLiteSyncDialect().sqlToQuery(c as never).sql)),
      unique: i.config.unique === true,
      partial: i.config.where !== undefined,
    })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * THE ONE DIFFERENCE OF ORDER, and it is three tables by name.
 *
 * SQLite's `ALTER TABLE ADD COLUMN` can only APPEND, so a column the server twin gained in the
 * middle of its list cannot land in the same ordinal position here without rebuilding the table.
 * For `mailboxes` that is a 47-column rebuild in a device migration, which is a larger risk than
 * an order difference no query can observe: every read names its columns, and `PRAGMA
 * table_info` order is not a contract anything in this codebase depends on.
 *
 * WHAT IS EXEMPTED IS ORDINAL POSITION AND NOTHING ELSE. Every per-column fact stays BOUND to its
 * column name through {@link byName} — the column SET, its type ruling, whether it has a default
 * and whether it is NOT NULL are all still compared, as are primary keys, uniques, indexes,
 * foreign keys and checks. A table not named here is still compared in order, and the case
 * "exempts ORDER for the named tables and nothing else" watches that refusal fire.
 */
const COLUMN_ORDER_EXEMPT = new Set(["mailboxes", "away_responders", "outbound_sends"]);

/** The shape with ordinal position removed and every per-column fact still bound to its name. */
function byName(shape: Shape): Shape {
  const order = shape.columns
    .map((name, i) => [name, i] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return {
    ...shape,
    columns: order.map(([name]) => name),
    types: order.map(([, i]) => shape.types[i]),
    defaults: order.map(([, i]) => shape.defaults[i]),
    notNull: [...shape.notNull].sort(),
  };
}

const pgTables = Object.entries(pgSchema).filter(([, v]) => is(v, PgTableClass)) as [string, PgTable][];
const sqliteTables = new Map(
  (Object.entries(sqliteSchema).filter(([, v]) => is(v, SQLiteTableClass)) as [string, SQLiteTable][]),
);

describe("the SQLite twin is the same schema", () => {
  /**
   * THE CONTROL: this file is holding TWO twins, and the second run is arranged to swap one in.
   *
   * The SQLite project rewrites the specifier `./schema-mail.js` to the device twin, so that the
   * barrel every service imports serves the second store's tables. This file reaches the server
   * twin as `../src/schema-mail.js`, which that anchored pattern does not match — but "does not
   * match" is a claim about a regular expression, and it was worth measuring what happens when it
   * stops being true. With a pattern matching the whole specifier the substitution is silent and
   * this file ends up holding the device twin twice; four assertions then fail, three of them
   * saying only "expected 0 to be greater than 40".
   *
   * So this is not the only thing that would notice. It is the thing that says WHY, which is the
   * difference between a reader looking at the schema and a reader looking at the config that
   * caused it. Asserted on BOTH runs, because the run where it can go wrong is the run where a
   * skip would hide it.
   */
  it("still holds the SERVER twin on both runs, or it is comparing one schema with itself", () => {
    expect(pgTables.length, "the server twin resolved to something with no Postgres tables in it — " +
      "check that no alias rewrote `../src/schema-mail.js`").toBeGreaterThan(40);
    expect(sqliteTables.size).toBeGreaterThan(40);
    // Distinct module objects, so neither side can be the other under a different name.
    for (const [name, table] of pgTables) {
      expect(sqliteTables.get(name), `both sides handed back the same object for ${name}`)
        .not.toBe(table);
    }
  });

  it("drops only the widenable set CHECKs from the comparison, and still compares the rest", () => {
    // A filter that grew to cover everything would silence this whole column without a failure.
    // Three names today, and the twins carry more CHECKs than that on both sides.
    expect([...WIDENABLE_SET_CHECKS].sort()).toEqual([
      "mailboxes_disabled_reason_closed",
      "mailboxes_organized_by_kind_closed",
      "mailboxes_sync_blocked_reason_closed",
    ]);
    const compared = pgTables.flatMap(([, t]) => pgShape(t).checks);
    expect(compared.length, "every CHECK was filtered out of the comparison").toBeGreaterThan(2);
    for (const name of WIDENABLE_SET_CHECKS) {
      expect(compared.some((c) => c.startsWith(`${name}:`)), `${name} survived the filter`).toBe(false);
    }
  });

  it("declares a table for every one the server has, under the same exported name", () => {
    expect(pgTables.length).toBeGreaterThan(40);
    const missing = pgTables.map(([name]) => name).filter((name) => !sqliteTables.has(name));
    expect(missing, "exported names present on the server twin and absent here").toEqual([]);
    const extra = [...sqliteTables.keys()].filter((n) => !pgTables.some(([name]) => name === n) && !DEVICE_ONLY_TABLES.has(n));
    expect(extra, "exported names here that the server twin does not have").toEqual([]);
    // Each named device-only table exists here, so the exemption cannot outlive its table.
    for (const n of DEVICE_ONLY_TABLES) expect(sqliteTables.has(n), `${n} is exempted and not declared`).toBe(true);
  });

  it("compares every foreign key, so a reference cannot drift on one store alone", () => {
    // The census half: this must be looking at real references, or the comparison below is a
    // comparison of two empty lists on fifty tables.
    const total = pgTables.reduce((n, [, t]) => n + pgShape(t).foreignKeys.length, 0);
    expect(total, "the twins are expected to carry references").toBeGreaterThanOrEqual(30);

    // And a signature must actually say where it points and what it cascades — an empty or
    // constant string would compare equal everywhere.
    const messages = pgTables.find(([n]) => n === "messages");
    const sigs = pgShape((messages as [string, PgTable])[1]).foreignKeys;
    expect(sigs.some((s) => /-> mailboxes\(id\) on delete /.test(s))).toBe(true);
  });

  it("compares index expressions as their text, and exercises every declared difference", () => {
    // The comparison used to reduce every expression to the literal word "expr", which made an
    // index on `lower(address)` equal to an index on anything else at all. This asserts the
    // machinery that replaced it actually sees expressions — otherwise a future change that stops
    // rendering them would leave the parity check green and blind again.
    const columnsOf = (name: string) => {
      const pg = pgTables.find(([n]) => n === name);
      const twin = sqliteTables.get(name);
      expect(pg, `${name} is expected to carry an expression index`).toBeDefined();
      return {
        pg: pgShape((pg as [string, PgTable])[1]).indexes.flatMap((i) => i.columns),
        sqlite: sqliteShape(twin as SQLiteTable).indexes.flatMap((i) => i.columns),
      };
    };

    const mailboxes = columnsOf("mailboxes");
    expect(mailboxes.pg).toContain("lower(address)");
    expect(mailboxes.sqlite).toContain("lower(address)");

    const messages = columnsOf("messages");
    expect(messages.pg).toContain("lower(from_address)");
    // The one difference that is real, on both arms, reduced to the same token only after each
    // half matched what the table records.
    for (const arm of [messages.pg, messages.sqlite]) {
      expect(arm).toContain("<declared:messages_account_from_domain_idx>");
    }

    // And no entry in the table is dead: a declared difference nothing renders is a difference
    // that stopped existing, and the record of it should go too.
    const rendered = new Set([...mailboxes.pg, ...mailboxes.sqlite, ...messages.pg, ...messages.sqlite,
      ...columnsOf("tags").pg, ...columnsOf("tags").sqlite]);
    for (const name of Object.keys(DIALECT_EXPRESSIONS)) {
      expect(rendered, `${name} is recorded as a dialect difference but nothing renders it`)
        .toContain(`<declared:${name}>`);
    }
  });

  /**
   * THE EXEMPTION'S OWN CONTROL — the refusal it narrows must still fire everywhere else.
   *
   * Two shapes differing ONLY in column order: the strict comparison the loop below uses for every
   * unnamed table must refuse them, and the exempt path must admit them. Without the first half the
   * exemption could quietly be doing nothing; without the second it could be refusing what it was
   * written to allow. The membership is pinned here too, so widening the set is an edit to this case.
   */
  it("exempts ORDER for the named tables and nothing else", () => {
    const base = {
      checks: [], indexPredicates: [], primaryKey: ["a"], uniques: [], indexes: [], foreignKeys: [],
    };
    const one = {
      ...base, columns: ["a", "b"], types: ["SQLiteText", "SQLiteInteger"],
      defaults: ["a:none", "b:has"], notNull: ["a"],
    } as unknown as Shape;
    const other = {
      ...base, columns: ["b", "a"], types: ["SQLiteInteger", "SQLiteText"],
      defaults: ["b:has", "a:none"], notNull: ["a"],
    } as unknown as Shape;

    // A table that is NOT exempt is refused on order alone.
    expect(() => expect(one).toEqual(other)).toThrow();
    // The exempt path admits the very same pair, with every per-column fact still bound by name.
    expect(byName(one)).toEqual(byName(other));
    // And a difference that is NOT order survives the exemption: b's type changes.
    const drifted = { ...other, types: ["SQLiteText", "SQLiteText"] } as unknown as Shape;
    expect(() => expect(byName(one)).toEqual(byName(drifted))).toThrow();

    expect([...COLUMN_ORDER_EXEMPT].sort())
      .toEqual(["away_responders", "mailboxes", "outbound_sends"]);
  });

  for (const [exportName, table] of pgTables) {
    it(`agrees on ${exportName}`, () => {
      const twin = sqliteTables.get(exportName);
      expect(twin, `${exportName} has no SQLite twin`).toBeDefined();
      expect(sqliteConfig(twin as SQLiteTable).name).toBe(pgConfig(table).name);
      const shipped = sqliteShape(twin as SQLiteTable);
      const server = pgShape(table);
      if (COLUMN_ORDER_EXEMPT.has(pgConfig(table).name)) {
        expect(byName(shipped)).toEqual(byName(server));
      } else {
        expect(shipped).toEqual(server);
      }
    });
  }
});
