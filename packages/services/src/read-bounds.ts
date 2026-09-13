import { ServiceError } from "./errors.js";

/**
 * Ceilings on what STORED STATE may make a request read — the database twin of the adapter's
 * `imap-bounds.ts` and of the request door's input bounds, and the axis neither of them can see.
 *
 * The input bounds ask how large a REQUEST may be; they are answered by a scalar path parameter
 * and have nothing left to bound. The IMAP bounds ask how much a SERVER may send. Between them
 * sits a third kind: a request carrying one id, reading a collection this account has been filling
 * for a year, with no cardinality ceiling anywhere on the way. That is `FR-ACCUMULATED-STATE-
 * UNBOUNDED`, and its members are invisible to both censuses by construction.
 *
 * The rule is the adapter's, restated for a database: bound the READ, not the RESULT. A `LIMIT`
 * applied after the driver has transferred the rows is documentation, and a `LIMIT` with no
 * refusal is worse than none — it answers a COUNT question with an arbitrary subset and calls it
 * a number. So every bound here reads one row PAST its ceiling and refuses when it arrives: the
 * caller gets a complete answer or a stated refusal, never a quiet partial one.
 */

/**
 * The closed set of read ceilings this module enforces — one code per KIND of unboundedness, not
 * one per call site. A code rather than a sentence because it is compared in tests and reaches an
 * operator through the refusal.
 */
export type ReadBoundKind = "folder_inventory" | "account_mailboxes";

/**
 * A ceiling on STORED cardinality was crossed while answering a request.
 *
 * A {@link ServiceError} so it reaches the caller as a stated refusal rather than as the 500 the
 * unbounded version eventually produced — a driver parameter limit, a statement timeout, or a heap
 * the shared process was sharing. `409` and not `500`: nothing is broken, the answer is refused
 * because the collection is larger than a single answer may cover.
 */
export class ReadBoundExceeded extends ServiceError {
  constructor(
    readonly bound: ReadBoundKind,
    readonly limit: number,
    /**
     * ROWS THE DRIVER TRANSFERRED — deliberately not the collection's size, which nobody counted
     * and counting would be the cost this ceiling exists to refuse. It is the ceiling plus the
     * probe row whenever the bound is applied at the read, which is the one thing that tells a
     * ceiling on the READ apart from a `filter` over rows that already arrived.
     */
    readonly read: number,
    message: string,
  ) {
    super("read_bound_exceeded", 409, message);
    this.name = "ReadBoundExceeded";
  }
}

/**
 * FOLDERS ONE MIRRORED SUBTREE MAY COVER.
 *
 * The number is the adapter's, on purpose and by citation rather than by import: the mirror is
 * filled from LIST, `IMAP_LIST_MAX_FOLDERS` is 10 000, and its own reading is "two orders of
 * magnitude above the largest real mailbox measured (~137 folders) and far below the worker's
 * memory budget — it catches a runaway, not an unusual filer". A subtree is a SUBSET of one
 * mailbox's inventory, so the same number is a ceiling with room to spare on a read that asks for
 * less. `read-bounds-agree.test.ts` asserts the two have not drifted, which is what makes the
 * restatement safe; importing it here would pull the IMAP adapter into every request path.
 *
 * Not imported and not derived downward: a ceiling that says "a tenth of the adapter's" would be a
 * number nobody measured wearing a citation's clothes.
 */
export const FOLDER_INVENTORY_MAX = 10_000;

/**
 * MAILBOXES ONE ACCOUNT-WIDE READ MAY COVER — a DECLARED SANITY CEILING, and the declaration is
 * the honest part.
 *
 * The site this exists for is `requestPull`'s re-stamp: a `select … for update` of every CONNECTED
 * mailbox of one account, no `LIMIT`, whose ids then become an `IN` list. The self-host imposes no
 * mailbox count of any kind, so the collection is accumulated state with nothing above it.
 *
 * **The reading is OWED, and this number is not it.** What must be measured is the largest real
 * per-account mailbox count, and whether a deployment cap should exist at all is a product
 * decision nobody has taken. Until then this is the shape `IMAP_LIST_MAX_FOLDERS` uses for the same
 * reason: a bound set so far above any honest account that it cannot fire on real work, so it
 * catches a runaway without pretending to be a product limit. Each element here costs a stored
 * credential and a mail server that answered, so a thousand of them is a thousand successful IMAP
 * connects rather than anything a request can ask for.
 *
 * It REFUSES BY NAME rather than truncating, and the `IN` stays: dropping it and re-deriving the
 * account+status predicate inside the UPDATE is not equivalent under concurrency — `for update`
 * does not lock against INSERTs, so a mailbox connected between the two statements would be
 * stamped without being reported. A silent truncation would be the same defect with a ceiling's
 * name on it.
 */
export const ACCOUNT_MAILBOXES_MAX_READ = 1_000;

/**
 * The ceiling as a `LIMIT` argument: one row past it, so the read can tell at-the-ceiling from
 * over it without a second COUNT. Every caller pairs it with {@link refuseOverFolderInventory}.
 */
export const folderInventoryProbe = (): number => FOLDER_INVENTORY_MAX + 1;

/**
 * Refuse the answer when the probe row came back. The rows are ALREADY read at this point — that
 * is the price of one round trip — but the ceiling is what the driver transferred, and it is one
 * row, not the collection.
 */
export const accountMailboxesProbe = (): number => ACCOUNT_MAILBOXES_MAX_READ + 1;

/**
 * Refuse an account-wide mailbox read that came back over the ceiling — see {@link
 * ACCOUNT_MAILBOXES_MAX_READ}. Never a truncation: the caller's whole job is to answer FOR every
 * connected mailbox, and an answer covering some of them silently is the state the ceiling exists
 * to make unreachable.
 */
export function refuseOverAccountMailboxes(read: { length: number }, what: string): void {
  if (read.length <= ACCOUNT_MAILBOXES_MAX_READ) return;
  throw new ReadBoundExceeded(
    "account_mailboxes", ACCOUNT_MAILBOXES_MAX_READ, read.length,
    `${what} covers more than ${ACCOUNT_MAILBOXES_MAX_READ} connected mailboxes, which is more `
    + "than one answer can cover; nothing was changed",
  );
}

export function refuseOverFolderInventory(read: { length: number }, what: string): void {
  if (read.length <= FOLDER_INVENTORY_MAX) return;
  throw new ReadBoundExceeded(
    "folder_inventory", FOLDER_INVENTORY_MAX, read.length,
    `${what} covers more than ${FOLDER_INVENTORY_MAX} folders, which is more than one answer can `
    + "count; nothing was changed",
  );
}
