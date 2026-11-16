import { storeFaultOf, StoreStatementFaultError, type StoreFaultName } from "./log.js";

/**
 * WHOSE FAULT A STORE'S REFUSAL OF ONE STATEMENT IS — the value the statement carried, or the
 * store's own. The worker's ingest classifier (`packages/organizer/src/dead-letter.ts`) reads its database
 * classes here, and so does a writer that keeps a letter without one of its rows: one list of the
 * classes, read by both. Imports nothing but the log leaf's store-class reading.
 */

/**
 * WHY A MESSAGE COULD NOT BE INGESTED — a CLOSED set, and never free text.
 *
 * Same contract `mailboxes.error_detail` is held to, and for the same reason — an account's mail
 * belongs to that account and to nobody else: a throw out of the ingest path can
 * embed RFC822 header bytes, a Postgres data-exception message quotes the offending row, and both
 * reach an `audit_log` payload the account owner's own tooling reads. Membership cannot be forged
 * by a mail server; a shape test can.
 */
export type MessageFailureCode =
  /** Raw source over {@link MimeTooLargeError}'s ceiling. Deterministic in the bytes. */
  | "mime_too_large"
  /** mailparser refused the source. Deterministic in the bytes. */
  | "mime_unparseable"
  /** Postgres class 22 — a VALUE the message carried is unstorable (a NUL, a bad date). */
  | "data_exception"
  /** Postgres class 23 — a constraint refused the row. NOT assumed deterministic. */
  | "constraint_violation"
  /**
   * A value or statement this message made exceeds a limit of the store: a routine of
   * {@link MESSAGE_LIMIT_ROUTINES}, or our own client's refusal of an over-limit statement.
   * Deterministic in the bytes AND the schema, so the next look is a new build.
   */
  | "data_too_large"
  /** Anything we cannot name. Retried before it is ever skipped. */
  | "unclassified";

/**
 * WHOSE FAULT IS THIS THROW — the message's, or the infrastructure's?
 *
 * Getting this wrong in either direction loses something. Call a database outage "message-local"
 * and a shared incident silently writes off everybody's mail (blaming one mailbox for a shared
 * outage is the mailbox-level version of the same mistake). Call a poison message "infrastructure" and it is retried for ever,
 * which is the bug the worker's ledger (`dead-letter.ts`) exists to end.
 */
export type IngestFault =
  | { domain: "infrastructure" }
  | { domain: "message"; code: MessageFailureCode; deterministic: boolean };

/**
 * THE DEVICE STORE'S RESULT CLASSES THAT ARE OURS, NOT THE MESSAGE'S. SQLite answers a full disk, a
 * locked or busy file, a read-only or corrupt database with these, and a phone meets every one; read
 * as the message's, a full disk would write off five messages a cycle. `error`, `internal` and
 * `misuse` are our statement or our driver (a missing column, a transaction inside a transaction),
 * Postgres's classes 25 and XX. Never written off: the cycle fails, the cursor holds.
 */
const STORE_INFRASTRUCTURE: ReadonlySet<StoreFaultName> = new Set<StoreFaultName>([
  "error", "internal", "misuse",
  "perm", "abort", "busy", "locked", "nomem", "readonly", "interrupt", "ioerr", "corrupt", "full",
  "cantopen", "protocol", "schema", "nolfs", "auth", "notadb",
]);

/** A device store's refusal, by its SQLite class; null when the throw is not SQLite's. */
export function classifyStoreFault(err: unknown): IngestFault | null {
  const store = storeFaultOf(err);
  if (store === null) return null;
  if (STORE_INFRASTRUCTURE.has(store)) return { domain: "infrastructure" };
  // Our own statement over the store's limit, as `isMessageLimit` reads the server's.
  if (store === "toobig") return { domain: "message", code: "data_too_large", deterministic: true };
  // A value this message carried that the column cannot hold: the class-22 reading.
  if (store === "range" || store === "mismatch") return { domain: "message", code: "data_exception", deterministic: true };
  // A CHECK, UNIQUE or NOT NULL: class 23's reading, retried before it is written off.
  if (store === "constraint") return { domain: "message", code: "constraint_violation", deterministic: false };
  // `other` (a refusal whose class did not survive to us), `notfound`, `empty`, `format`: the store's.
  return { domain: "infrastructure" };
}

/**
 * The driver answering about the VALUE we bound — node:sqlite's and expo's bind and convert refusals. A
 * value reaches the bind from the message through our pipeline, so these stay the message's: called
 * the device's, one such message would hold every folder's cursor on that device for ever.
 */
const STORE_BIND_CODES: ReadonlySet<string> = new Set([
  "ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE", "ERR_INVALID_BIND_PARAMETER", "ERR_INVALID_CONVERTIBLE",
]);

/** A marked store throw, by its cause's structured fields only; what none of them names is the device's. */
export function classifyStoreStatementFault(cause: unknown): IngestFault {
  const store = classifyStoreFault(cause);
  if (store !== null) return store;
  if (isMessageLimit(cause)) return { domain: "message", code: "data_too_large", deterministic: true };
  const code = faultCodeOf(cause);
  const cls = sqlStateClass(code);
  if (cls === "22") return { domain: "message", code: "data_exception", deterministic: true };
  if (cls === "23") return { domain: "message", code: "constraint_violation", deterministic: false };
  if (STORE_BIND_CODES.has(code)) return { domain: "message", code: "unclassified", deterministic: false };
  return { domain: "infrastructure" };
}

/** A SQLSTATE's class (its first two characters), or null when `code` is no SQLSTATE. */
export const sqlStateClass = (code: string): string | null =>
  /^[0-9A-Z]{5}$/.test(code) ? code.slice(0, 2) : null;

/** A throw's own `code`, or "" when it carries none. */
export const faultCodeOf = (err: unknown): string => {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : "";
};

/**
 * THE CLASS-54 ROUTINES THAT ARE ONE MESSAGE'S OWN VALUE, each measured here (postgres.js on 16 and
 * PGlite name the same): a tsvector over 1 MiB, a btree key over a page's third, an index tuple over
 * 8 KB. Every other 54xxx is the cluster's (a full NOTIFY queue at COMMIT, ID or MultiXact wraparound,
 * a routine nobody has seen) and stays shared, so a run of them writes nothing off.
 */
const MESSAGE_LIMIT_ROUTINES: ReadonlySet<string> = new Set([
  "make_tsvector", "tsvector_concat", "_bt_check_third_page", "index_form_tuple_context",
]);

/** Is this throw a store limit attributable to the one statement that raised it — never shared? */
export const isMessageLimit = (err: unknown): boolean => {
  const code = faultCodeOf(err);
  if (code === "OHMAIL_BIND_LIMIT") return true;  // our client refused it in the caller's own call
  const routine = (err as { routine?: unknown } | null)?.routine;
  return sqlStateClass(code) === "54" && typeof routine === "string" && MESSAGE_LIMIT_ROUTINES.has(routine);
};

/**
 * THE VALUE'S FAULT, OR NONE: the closed word when a store refused one statement for the value it
 * carried (the classes above, the device store's mark read through), else null — a lock wait cut
 * short, a deadlock, a cancelled statement, a busy, locked or broken device store, a fault of our
 * own code. A writer may keep a letter without one of its rows for the first, never for the second:
 * the letter's transaction must fail, so the next cycle reads the letter again.
 */
export function valueFaultOf(err: unknown): MessageFailureCode | null {
  const fault = classifyStoreStatementFault(err instanceof StoreStatementFaultError ? err.cause : err);
  return fault.domain === "message" ? fault.code : null;
}
