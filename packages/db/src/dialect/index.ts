/**
 * The two SQL dialects this schema runs on, and the one place that knows the difference. The same
 * engine runs against Postgres on a server and SQLite on a phone; this is the seam where "the
 * current timestamp", "lock this row", "search this text" become two things. The handle is chosen
 * by a BRAND its factory stamps, never by inspecting it: a shape test guesses right until a
 * version bump, and then the wrong arm runs, every statement parses, and a `FOR UPDATE` quietly
 * locks nothing. An unbranded handle is refused. The brand is a globally registered symbol, so
 * two copies of this package agree. Members with no caller yet were named by a census over the
 * engine's sources; each is exercised against a real store.
 */
import { sql, type SQL } from "drizzle-orm";
import { pgDialect } from "./pg.js";
import { sqliteDialect } from "./sqlite.js";

export { pgDialect } from "./pg.js";
export { sqliteDialect, assertSqliteCapabilities, SQLITE_MINIMUM, onLocalNotify } from "./sqlite.js";

/** The SQL dialects the mail schema is written for. */
export type DialectName = "pg" | "sqlite";

/** Where a factory records which dialect its handle speaks. Registered, so copies agree. */
export const DIALECT_BRAND: unique symbol = Symbol.for("ohmail.db.dialect") as never;

/** Marks a `transaction` this module has already wrapped, so branding twice wraps once. */
const TRANSACTION_WRAPPED: unique symbol = Symbol.for("ohmail.db.dialect.txWrapped") as never;

/**
 * Stamp a handle with the dialect it speaks. Called by the factories, by nobody else. The brand
 * is inherited by TRANSACTIONS, which is the point: a driver's transaction object is a fresh
 * object, and a property on the handle does not travel to it — yet almost every statement runs
 * inside one. Passing the dialect as a parameter grows an argument through every intermediate
 * function; stamping at each site means remembering, and forgetting is a refusal deep inside a
 * request. So branding a handle also wraps its `transaction`, recursively, so SAVEPOINTs are
 * branded to any depth. Wrapping is idempotent, and the wrapper is an OWN property, so two
 * handles from one driver do not interfere.
 */
export function brandDialect<T extends object>(db: T, name: DialectName): T {
  Object.defineProperty(db, DIALECT_BRAND, {
    value: name, enumerable: false, configurable: true, writable: false,
  });

  type TxFn = (fn: (tx: object, ...inner: unknown[]) => unknown, ...rest: unknown[]) => unknown;
  const holder = db as { transaction?: TxFn };
  const original = holder.transaction;
  if (typeof original === "function"
    && (original as unknown as Record<symbol, unknown>)[TRANSACTION_WRAPPED] !== true) {
    const wrapped = function (this: unknown, fn: (tx: object, ...i: unknown[]) => unknown, ...rest: unknown[]) {
      return original.call(this, (tx: object, ...inner: unknown[]) => fn(brandDialect(tx, name), ...inner), ...rest);
    } as TxFn;
    Object.defineProperty(wrapped, TRANSACTION_WRAPPED, { value: true, enumerable: false });
    Object.defineProperty(db, "transaction", {
      value: wrapped, enumerable: false, configurable: true, writable: true,
    });
  }
  return db;
}

/**
 * Refuse a result whose columns cannot be told apart.
 *
 * Two columns of one name collapse into a single object key before anything here can see them, so
 * the row would come back SHORTER than the statement selected, with no error. Refusing names the
 * fix — alias them — instead of returning a row whose shape depends on the statement's spelling.
 */
export function assertDistinct(names: readonly string[]): void {
  const seen = new Set<string>();
  const duplicated = names.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
  if (duplicated.length > 0) {
    throw new Error(
      `this statement selects more than one column named ${[...new Set(duplicated)].map((n) => `'${n}'`).join(", ")}. ` +
      "Rows are returned positionally and duplicate names collapse before they can be ordered — " +
      "give each column a distinct alias.",
    );
  }
}

/**
 * Refuse a comparison of fewer than two values.
 *
 * The device store spells {@link Dialect.greatest} as `max`, and `max` with one argument there is
 * the AGGREGATE rather than the row-wise comparison — so a single-argument call runs, returns one
 * row where the caller expected many, and reports nothing. The server cannot produce that
 * mistake, which is exactly why it has to be refused in the shared contract rather than on the
 * arm that suffers it.
 */
/**
 * Refuse a JSON key this seam cannot address on both stores.
 *
 * The server takes the key as a value; this store takes a quoted PATH, and a key holding `"` or a
 * backslash cannot be quoted into one — the path would parse as something else, or not at all, and
 * the read would answer NULL for a key that is there. No header name or metadata key in this
 * schema holds either character, so refusing is the honest answer rather than an escape scheme
 * nobody can check.
 */
export function assertJsonKey(key: string): string {
  if (/["\\]/.test(key)) {
    throw new Error(
      `a JSON key addressed through this seam may not hold a quote or a backslash and this one ` +
      `holds ${JSON.stringify(key.replace(/[^"\\]/g, ""))}: the device store addresses a key by ` +
      "quoted path, where either character means something else.",
    );
  }
  return key;
}

export function assertComparable(count: number): void {
  if (count < 2) {
    throw new Error(
      `a largest-of comparison needs at least two values and was given ${count}. On the device ` +
      "store this member is spelled `max`, where one argument is the AGGREGATE — it would " +
      "collapse the result set instead of comparing within a row, and answer without failing.",
    );
  }
}

/**
 * Give a handle the dialect of the handle it came from. A driver's transaction object is not the
 * connection it was opened on — it is a fresh object, and the brand does not travel to it.
 * Anything that opens a transaction and builds a repository around the transaction handle is
 * holding something unbranded, and the refusal in `dialectOf` fires on its first locking
 * statement rather than where the mistake was made. Passing both handles says where the answer
 * came from — the part a bare `brandDialect(tx, "pg")` at the call site would be guessing.
 */
export function carryDialect<T extends object>(from: unknown, to: T): T {
  return brandDialect(to, dialectOf(from));
}

/**
 * Which dialect this handle speaks — or a refusal.
 *
 * The refusal is the point. A handle that reaches a service without a brand came from a factory
 * that has not been taught about the second dialect, and answering "pg" for it would make every
 * unbranded path silently Postgres-only on a device that has no Postgres.
 */
export function dialectOf(db: unknown): DialectName {
  const name = (db as Record<symbol, unknown> | null)?.[DIALECT_BRAND];
  if (name === "pg" || name === "sqlite") return name;
  throw new Error(
    "this database handle carries no dialect brand, so no statement can be composed for it. " +
      "Every factory that opens a handle must call brandDialect(db, …); a handle that reaches " +
      "here unbranded came from one that does not yet know there are two dialects.",
  );
}

/**
 * HOW STRONG A ROW LOCK IS — the four strengths the server distinguishes.
 *
 * Absent means `"update"`, which is the exclusive one and the one most callers want. The others
 * are here because SITES ALREADY USE THEM and a port may not quietly promote one: a shared lock
 * lets other readers through and a key-share lock only blocks changes to the key, so rewriting
 * either as `"update"` would serialize traffic the site deliberately does not serialize. That is a
 * change to what the statement DOES on the server, made while porting it to a second store — which
 * is exactly the substitution a seam exists to prevent.
 */
export type LockMode = "update" | "share" | "key share" | "no key update";

/** A row-locking request, in the terms both dialects can be asked in. */
export interface LockOptions {
  /** Restrict the lock to these tables, the way `FOR UPDATE OF <table>` does. */
  readonly of?: unknown;
  /** Skip rows another transaction already holds instead of waiting for them. */
  readonly skipLocked?: boolean;
  /** How strong. Absent is `"update"` — see {@link LockMode}. */
  readonly mode?: LockMode;
}

/** The two text-search arms, each as the predicate that selects and the expression that ranks. */
export interface SearchArm { readonly pred: SQL; readonly rank: SQL }

/**
 * One JSON array's elements as a joinable relation — see {@link Dialect.jsonArrayElements}.
 *
 * Four fragments rather than one because the element is a different KIND of thing on each store,
 * and a caller deriving the last two from `value` would be correct on one of them.
 */
export interface JsonElements {
  /** The relation to join, aliased. */
  readonly from: SQL;
  /** One element, in whatever the store's own terms are. */
  readonly value: SQL;
  /** TRUE when the element is a JSON string. */
  readonly isString: SQL;
  /** The element as SQL text — unquoted, so it compares against ordinary strings. */
  readonly text: SQL;
}

/**
 * The whitespace `String.prototype.trim` strips that both stores can also strip, as a BOUND value.
 *
 * Bound rather than written into the SQL: the server reads backslash escapes in a string literal
 * and this store does not, so one literal spelling cannot mean the same set in both. The set is
 * the server's `[[:space:]]` in the C locale, which is the class the away-responder predicate was
 * written against — Unicode whitespace is outside it on purpose and is a named residual there.
 */
export const SQL_TRIM_BLANK = " \t\n\r\f\v";

/**
 * Which body of text a search is over — named, because neither store can be told in columns. The
 * server searches a generated `tsvector` column on the row; this store cannot have one, so the
 * same text lives in a separate full-text table joined by `rowid`. A caller passing COLUMNS could
 * describe the first arrangement and not the second, so it would be passing the server's shape
 * through a dialect-free parameter. A name instead; the seam owns the mapping. `mail` is the
 * message corpus (subject, sender, stored body, joined as `m` and `b`); `kb` is the knowledge
 * base's own entries.
 */
export type SearchCorpus = "mail" | "kb";

/**
 * Every construct the engine uses that the two dialects spell differently.
 *
 * Each member is a question with two correct answers, not a Postgres feature with a SQLite
 * apology. Where SQLite's answer is "nothing to do" — the row locks — that is stated here with
 * the reason, because a no-op whose justification lives somewhere else is a bug waiting for a
 * reader who does not know why it is safe.
 */
export interface Dialect {
  readonly name: DialectName;

  /** The current instant, as the schema's timestamp columns store it. */
  now(): SQL;

  /** A JavaScript instant, as a literal the timestamp columns compare against. */
  ts(at: Date): SQL;

  castInt(value: SQL | unknown): SQL;
  castText(value: SQL | unknown): SQL;
  castUuid(value: SQL | unknown): SQL;
  castJsonb(value: SQL | unknown): SQL;

  /**
   * Take the rows this query returns for the rest of the transaction, at {@link LockMode} strength.
   *
   * On SQLite this is the identity for EVERY mode, and that is not a weakening: the engine store is
   * reached through ONE serialized connection, so there is no second writer for a lock to exclude.
   * A second connection to the same file does not contend, it fails — `database is locked` — so
   * the serialization is the guarantee, and row locking would be a second mechanism for something
   * already true. The mode is meaningless there for the same reason: the strengths differ only in
   * WHICH other writers they admit, and there are none.
   */
  forUpdate<Q>(q: Q, opts?: LockOptions): Q;

  /** As {@link forUpdate}, and pass over rows another transaction is holding. */
  skipLocked<Q>(q: Q, opts?: Omit<LockOptions, "skipLocked">): Q;

  /**
   * Hold a named lock for the rest of the transaction, keyed by a class and a string.
   *
   * A no-op on SQLite for {@link forUpdate}'s reason: the lock exists to order writers, and
   * there is exactly one.
   */
  advisoryLock(tx: unknown, lockClass: number | bigint, key: string): Promise<void>;

  /**
   * Announce that a channel has something new, delivered when the transaction commits.
   *
   * The two deliveries are genuinely different and callers must not assume the server's. Postgres
   * queues the notification and hands it to listeners on OTHER connections at commit. SQLite has
   * no such thing, so the payload goes to an in-process emitter and reaches only this program —
   * which is the whole audience on a device, where the reader and the writer are one process.
   */
  notify(tx: unknown, channel: string, payload: string): Promise<void>;

  /** Case-insensitive containment, in each dialect's own spelling. */
  ilike(column: SQL | unknown, pattern: string): SQL;

  /**
   * TRUE when the column holds at least one character that is not whitespace. The rule router
   * ranks a rule by which of its terms are present, and "present" must mean the same in SQL as in
   * the evaluator: a term of `' '` is BARE. The server says that with a regex character class;
   * this store has no regex operator at all — a query using one fails with a syntax error, not a
   * wrong answer. The class is `SUBJECT_TERM_TRIM` in `rules.ts` spelled in SQL, and the pg test
   * checks the two agree over every one of its six characters.
   */
  hasNonBlank(column: SQL | unknown): SQL;

  /** A duration, as the timestamp columns can be offset by it. */
  interval(ms: number): SQL;

  /**
   * A timestamp truncated to whole milliseconds — a member and NOT a deletion, which is why it
   * exists. The server stores microseconds and the sort key must round-trip through a JavaScript
   * `Date`, which carries milliseconds; otherwise a keyset cursor cannot name the row it stopped
   * at — the value handed out is short by the microseconds and the resuming comparison never
   * matches. The device store keeps epoch milliseconds already, so there the answer is the value
   * itself. Dropping the call would be correct on one store and silently wrong on the other —
   * exactly the shape this seam refuses.
   */
  truncMs(at: SQL | unknown): SQL;

  /**
   * A row-locking clause as TEXT, for the one statement no builder can reach. {@link forUpdate}
   * is the member to use and takes a QUERY, which is what makes it safe: it attaches only to
   * something the builder is composing and can name the table. This one emits the clause itself —
   * the sharper tool — because a subselect written as raw SQL has no builder to attach to; the
   * site that needs it carries a measured note (embedding a locked builder there rendered
   * something else and turned twelve of fifteen send cases red against real Postgres). On the
   * device store the clause is EMPTY: one serialized writer, nothing to exclude, nothing to skip.
   */
  lockClause(opts?: LockOptions): SQL;

  /**
   * A JSON array's elements as ROWS, joined into a statement's FROM. `from` is the source
   * expression, `value` names one element inside it — two fragments, because the stores put the
   * element in different places: the server's function yields the element as the aliased
   * relation's single column; this store's yields a table whose element is a NAMED column.
   * `isString` and `text` are NOT derivable from `value`: the server's element is a JSON value
   * (`jsonb_typeof`, `#>> '{}'`); this store's is already an SQL value, where `json_type` over it
   * is a malformed-JSON error and the text is the value itself. NO ORDINALITY: the stores spell
   * position differently enough that a statement needing element ORDER must not use this.
   */
  jsonArrayElements(source: SQL | unknown, alias: string): JsonElements;

  /**
   * The value at one top-level KEY of a JSON document, as this store's JSON type.
   *
   * The server takes the key itself; this store takes a path, so the key is quoted into one here
   * rather than at the caller — a key holding `.` or `[` is an ordinary key and a silently
   * different path. A key that cannot be quoted is refused rather than composed.
   *
   * Feeds {@link jsonIsArray} and {@link jsonArrayElements}; a MISSING key yields SQL NULL on both,
   * which every predicate over it then reads as false.
   */
  jsonGet(document: SQL | unknown, key: string): SQL;

  /** Is this JSON value an array? Asked of {@link jsonGet}'s answer, never of an SQL value. */
  jsonIsArray(value: SQL | unknown): SQL;

  /**
   * `patch`'s top-level keys written over `document`'s, the rest of `document` surviving. The
   * server's `||` is this by construction. This store has no such operator — `||` there is string
   * CONCATENATION, so the server's spelling would produce two JSON documents stuck end to end —
   * and its `json_patch` is RFC 7396, which merges nested objects and DELETES a key whose patch
   * value is null. Neither is what callers mean, so the arm is spelled out. Key ORDER differs;
   * the value is read back through a JSON parse on both, so nothing depends on it. A NULL
   * `document` reads as `{}`.
   */
  jsonMergeShallow(document: SQL | unknown, patch: SQL | unknown): SQL;

  /**
   * A JSON object built from named expressions — the patch side of {@link jsonMergeShallow}.
   *
   * The two stores spell the constructor differently and nothing else about it differs: a text
   * value becomes a JSON string on both. It exists so a caller setting ONE key of a document does
   * not have to name the store's single-key setter, which only one of them has.
   */
  jsonObject(entries: Readonly<Record<string, SQL | unknown>>): SQL;

  /**
   * The largest of two or more values, in each store's own name for it.
   *
   * TWO ARGUMENTS AT LEAST, and the refusal is not tidiness. The device store spells this `max`,
   * and `max` with ONE argument there is the AGGREGATE — it collapses a result set to a single
   * row instead of comparing values in one. That is not an error anybody would see: the statement
   * runs and answers a different question. The server has no such collision (`greatest` and `max`
   * are different names), so a one-argument call is a defect that only appears on a device, in a
   * query that returns the wrong number of rows.
   */
  greatest(...values: readonly (SQL | unknown)[]): SQL;

  /**
   * Where `needle` first occurs in `hay` — 1-based, and 0 when it does not occur.
   *
   * Both stores answer that, and neither spells it the way the other does: the server's is SQL
   * syntax with a KEYWORD separator, the device's an ordinary two-argument function whose
   * arguments are in the opposite order to the server's. This member takes them in one order and
   * hands each store its own.
   */
  strpos(hay: SQL | unknown, needle: SQL | unknown): SQL;

  /**
   * `length` characters of `x` from `from`, 1-based; to the end when `length` is omitted.
   *
   * The server's is syntax with `FROM`/`FOR` keywords, the device's a plain function. Same
   * meaning, same 1-based index, on both.
   */
  substr(x: SQL | unknown, from: SQL | unknown, length?: SQL | unknown): SQL;

  /** Does this JSON object hold any of these keys at its top level? */
  jsonHasAny(column: SQL | unknown, keys: readonly string[]): Promise<SQL> | SQL;

  /**
   * Run a statement for its effect and hand back the rows, if any — each row as an ARRAY of its
   * column values, in the order the statement selected them.
   *
   * One shape on both stores, and it is the narrower of the two on purpose. The server's driver
   * returns named objects and the device's returns positional arrays; a helper that passed each
   * through would compile everywhere and read correctly on exactly one, which is the failure this
   * seam exists to prevent. Positional is the shape both can produce honestly.
   */
  exec(db: unknown, statement: SQL): Promise<unknown[][]>;

  readonly search: {
    /** Word-based search over one {@link SearchCorpus}'s indexed text. */
    lexical(q: string, corpus: SearchCorpus): SearchArm;
    /**
     * Typo-tolerant search over one corpus, and what it degrades to when trigrams are absent.
     * `trigram` is the caller's own probe of the deployment, not a guess made here: the same
     * dialect runs on a database with the extension and one without. The degrade ranks
     * differently per corpus, recorded rather than smoothed over: the mail arm falls back to
     * RECENCY (no relevance signal offline), the knowledge base to a constant, because its query
     * already breaks ties on `updated_at`. Making them agree would change what one of the two
     * returns — a product decision, not a port's.
     */
    fuzzy(q: string, corpus: SearchCorpus, opts: { trigram: boolean; threshold: number }): SearchArm;
  };
}

/** The dialect helper for a handle, chosen by its brand. */
export function dialect(db: unknown): Dialect {
  return dialectOf(db) === "sqlite" ? sqliteDialect() : pgDialect();
}

/** A fragment naming a column or expression, whatever the caller had in hand. */
export function frag(value: SQL | unknown): SQL {
  return sql`${value}`;
}

/**
 * Declare that a statement is reached only on Postgres — the identity function at runtime. Where
 * the two stores cannot share a statement, the engine BRANCHES, and the Postgres arm keeps the
 * server's construct: `xmax` forced this — a fact about one store's row visibility, so no
 * interface member can carry it. A marker rather than an exemption: a per-token exemption list is
 * an allowance nobody re-reads, and deleting the arm deletes the feature. The census pins the
 * count of such arms per file; every pinned arm carries a device-store twin test proving the
 * OTHER arm answers the same question. Wrap the TEMPLATE, not the call — the census skips a
 * template that is this function's direct argument, nothing else.
 */
export function pgOnly<T>(statement: T): T {
  return statement;
}
