/**
 * THE TWO SQL DIALECTS THIS SCHEMA RUNS ON, AND THE ONE PLACE THAT KNOWS THE DIFFERENCE.
 *
 * The same engine — the same services, the same sync loop, the same lease — runs against Postgres
 * on a server and against SQLite on a phone. Everything above this module is written once. This is
 * the seam where "the current timestamp", "lock this row", "search this text" stop being one thing
 * and become two, and it is deliberately small: every construct here earned its place by appearing
 * in code that ships to both, and nothing was added on the theory that it might.
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
 * Two members are in use: `forUpdate` at four sites and `advisoryLock` at one, all in the
 * repository. **The other fourteen have no caller yet** — they exist because a census over the
 * engine's own sources named every construct that would need one, and porting those sources is
 * the next piece of work rather than this one.
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

/** Stamp a handle with the dialect it speaks. Called by the factories, by nobody else. */
export function brandDialect<T extends object>(db: T, name: DialectName): T {
  Object.defineProperty(db, DIALECT_BRAND, {
    value: name, enumerable: false, configurable: true, writable: false,
  });
  return db;
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

/** A row-locking request, in the terms both dialects can be asked in. */
export interface LockOptions {
  /** Restrict the lock to these tables, the way `FOR UPDATE OF <table>` does. */
  readonly of?: unknown;
  /** Skip rows another transaction already holds instead of waiting for them. */
  readonly skipLocked?: boolean;
}

/** The two text-search arms, each as the predicate that selects and the expression that ranks. */
export interface SearchArm { readonly pred: SQL; readonly rank: SQL }

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
   * Take the rows this query returns for the rest of the transaction.
   *
   * On SQLite this is the identity, and that is not a weakening: the engine store is reached
   * through ONE serialized connection, so there is no second writer for a lock to exclude. A
   * second connection to the same file does not contend, it fails — `database is locked` — so
   * the serialization is the guarantee, and row locking would be a second mechanism for
   * something already true.
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

  /** A duration, as the timestamp columns can be offset by it. */
  interval(ms: number): SQL;

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
    /** Word-based search over the indexed subject and body. */
    lexical(q: string): SearchArm;
    /**
     * Typo-tolerant search, and what it degrades to when the trigram index is absent.
     *
     * `trigram` is the caller's own probe of the deployment it is talking to, not a guess made
     * here: the same dialect runs on a database that has the extension and one that does not.
     */
    fuzzy(q: string, opts: { trigram: boolean; threshold: number }): SearchArm;
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
