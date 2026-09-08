/**
 * THE TWO SQL DIALECTS THIS SCHEMA RUNS ON, AND THE ONE PLACE THAT KNOWS THE DIFFERENCE.
 *
 * The same engine — the same services, the same sync loop, the same lease — runs against Postgres
 * on a server and against SQLite on a phone. Everything above this module is written once. This is
 * the seam where "the current timestamp", "lock this row", "search this text" stop being one thing
 * and become two, and it is deliberately small: every member names a construct a census over the
 * engine's own sources actually found. Which of them have a caller TODAY, and which are waiting
 * for the port that will use them, is set out below — it is mostly the latter, and saying so here
 * matters because the sentence this replaced claimed the opposite four paragraphs above the list
 * that contradicted it.
 *
 * ── WHY A BRAND AND NOT A SHAPE TEST ──────────────────────────────────────────────────────
 *
 * The handle is chosen by a BRAND its factory stamps, never by inspecting it. A shape test —
 * "does it have `.execute`?", "is this a proxy?" — is a guess that gets the answer right until a
 * version bump changes a private field, and its failure mode is the worst available: the wrong
 * arm runs, every statement still parses, and the damage is a `FOR UPDATE` that quietly locked
 * nothing. A brand is a fact somebody wrote down. An unbranded handle is refused rather than
 * guessed at, because a default here is a silent choice of dialect and the dangerous one is
 * whichever the tests do not run.
 *
 * The brand lives on a globally registered symbol rather than a module-local one, so two copies
 * of this package in one process still agree.
 *
 * ── WHAT HAS A CALLER TODAY, AND WHAT IS WAITING FOR ONE ──────────────────────────────────
 *
 * Three members are in use: `forUpdate` at four sites, `hasNonBlank` at two and `advisoryLock` at
 * one, all in the repository. **The rest have no caller yet** — they exist because a census over
 * the engine's own sources named every construct that would need one, and porting those sources is
 * the next piece of work rather than this one.
 *
 * The count is deliberately not spelled out for the unused half: it was written as a number twice
 * and was wrong the second time within a day of the first, because adding a member is exactly the
 * moment nobody rereads this paragraph.
 *
 * That is stated because the alternative is worse in both directions. Code with no caller is code
 * nothing exercises, and this file's own rule is that a guard nobody has watched fail is not
 * evidence — so each unused member is executed by a test against a real store rather than merely
 * rendered, and the ones that were wrong were wrong in ways only running them showed. And
 * deleting them until needed would mean the census has no vocabulary to name what it finds.
 *
 * A member that is still listed here with no caller when the port is finished is a member to
 * delete, not to keep.
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
 * Stamp a handle with the dialect it speaks. Called by the factories, by nobody else.
 *
 * ── AND THE BRAND IS INHERITED BY TRANSACTIONS, WHICH IS THE WHOLE POINT ──────────────────
 *
 * A driver's transaction object is NOT the connection it was opened on: it is a fresh object the
 * query builder makes, and a property defined on the handle does not travel to it. Everything that
 * composes a statement per dialect therefore refused a transaction — and almost every statement in
 * this engine runs inside one.
 *
 * That was met twice by hand, and both answers were wrong at the scale they had to work at.
 * Passing the dialect down as a parameter means every function between the factory and the
 * statement grows an argument; the change-log's own recorder has a hundred callers, none of which
 * has an opinion about dialects. Stamping the transaction at each site means every site must
 * remember, and the failure of forgetting is not a compile error — it is a refusal deep inside a
 * request, which a route's error handler turns into a 500 with the reason discarded. Nineteen
 * requests failed that way before this existed.
 *
 * So the brand travels with the thing that creates the transaction. Branding a handle also wraps
 * its `transaction`, so the callback receives a branded object; and because the wrapper brands
 * recursively, a SAVEPOINT opened on that transaction is branded too, to any depth. One edit, and
 * "a handle that reaches a statement is branded" becomes true by construction rather than by
 * everybody remembering.
 *
 * Wrapping is idempotent — branding the same handle twice must not nest wrappers — and the wrapper
 * is defined as an OWN property, shadowing the prototype's method for this instance only, so two
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
 * Give a handle the dialect of the handle it came from.
 *
 * A driver's transaction object is not the connection it was opened on — it is a fresh object, and
 * the brand does not travel to it. Anything that opens a transaction and then builds a repository
 * around the transaction handle is therefore holding something unbranded, and the refusal in
 * `dialectOf` will fire on its first locking statement rather than at the point the mistake was
 * made.
 *
 * Passing both handles here says where the answer came from, which is the part a bare
 * `brandDialect(tx, "pg")` at the call site would be guessing at.
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
 * WHICH BODY OF TEXT A SEARCH IS OVER — named, because neither store can be told in columns.
 *
 * The server searches a generated `tsvector` column that lives ON the row. This store cannot have
 * one, so the same text is kept in a separate full-text table joined back by `rowid`. A caller
 * that passed COLUMNS could describe the first arrangement and not the second — it would have no
 * way to name a table it does not know exists — so it would be passing the server's shape through
 * a parameter that is supposed to be dialect-free.
 *
 * A name instead. The seam owns the mapping, which is the only place that can hold both.
 *
 * `mail` is the message corpus: subject and sender, plus the stored body, joined as `m` and `b`
 * the way every query over it already joins them. `kb` is the knowledge base's own entries, one
 * table and no alias.
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
   * TRUE when the column holds at least one character that is not whitespace.
   *
   * The rule router ranks a rule by which of its terms are present, and "present" has to mean the
   * same thing in SQL as it does in the evaluator: a term of `'  '` is BARE. The server says that
   * with a regex match against a character class; this store has no regex operator at all, and a
   * query using one does not fail on the device with a wrong answer, it fails with a syntax error.
   *
   * The class is `SUBJECT_TERM_TRIM` in `rules.ts` spelled in SQL, and the pg test checks the two
   * agree over every one of its six characters.
   */
  hasNonBlank(column: SQL | unknown): SQL;

  /** A duration, as the timestamp columns can be offset by it. */
  interval(ms: number): SQL;

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
     *
     * `trigram` is the caller's own probe of the deployment it is talking to, not a guess made
     * here: the same dialect runs on a database that has the extension and one that does not.
     *
     * THE DEGRADE RANKS DIFFERENTLY PER CORPUS, and that is recorded rather than smoothed over.
     * The mail arm falls back to RECENCY — its caller's comment says "no relevance signal offline
     * → recency" — and the knowledge base falls back to a constant, because its query already
     * breaks ties on `updated_at`. Making them agree would change what one of the two returns,
     * which is a product decision and not a port's to take.
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
 * DECLARE that a statement is reached only on Postgres. The identity function at runtime.
 *
 * Where the two stores cannot share a statement the engine BRANCHES rather than abstracting, and
 * the Postgres arm keeps the server's construct on purpose. `xmax` is the case that forced this:
 * it is not a spelling difference but a fact about one store's row visibility — how the server, and
 * only the server, answers "did this statement insert the row" — so there is no member this
 * interface could grow for it, and a device arm has to answer the question a different way.
 *
 * ── WHY A MARKER AND NOT AN EXEMPTION ─────────────────────────────────────────────────────
 *
 * The census over the engine's sources allows nothing, which is right and which a branch makes
 * unreachable: the server's arm is still in the file. The two obvious ways out are both worse. A
 * per-token exemption list is an allowance somebody adds a line to and nobody re-reads. Deleting
 * the arm deletes the feature.
 *
 * So the arm says what it is, at the site, in code. This carries no runtime cost and no type
 * change; what it buys is that the census can PIN how many such arms each file has, exactly — so
 * adding one is a red that names the file, and the pin is the thing a reviewer looks at. It is not
 * an escape hatch: every pinned arm carries a device-store twin test beside it proving the OTHER
 * arm answers the same question, and a `pgOnly(` in a file with no pin fails.
 *
 * Wrap the TEMPLATE, not the call around it — the census skips a template that is this function's
 * direct argument, and nothing else.
 */
export function pgOnly<T>(statement: T): T {
  return statement;
}
