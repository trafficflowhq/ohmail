/**
 * CAN THE ALERT PASS USE ITS DATABASE — the classifier behind the last-resort page
 * (`alert-last-resort.ts`). Every alert pass starts with database reads and writes before it
 * delivers, so a shared database that is gone, read-only, out of resources or too slow silences
 * both drivers; the page sent from their failure path must know the failure was the database, by
 * error class and code, never by message text.
 *
 * A refused port is a bare `ECONNREFUSED` from postgres.js, the same code a dead IMAP or plane host
 * gives, so a raw socket code counts only when the error came out of a read this module tagged: the
 * pass's first read ({@link readAlertDatabase} with op `preflight`) or the API's staff handle (`handle`).
 * A SQLSTATE of a failing server (a connection exception, a read-only database, insufficient
 * resources, operator intervention, a system or internal error) counts wherever it comes from: no
 * IMAP or plane host returns one. The evaluation as a whole runs under a deadline
 * ({@link evaluationUnderDeadline}) whose only tagged rejection is the deadline itself.
 * Imports nothing from `alerts.ts`.
 */

export type AlertDatabaseOp = "handle" | "preflight" | "evaluate";

/** The first read's deadline: a database that never answers fails the pass instead of hanging it. */
export const ALERT_DB_FIRST_READ_MS = 10_000;
/** The API staff handle's deadline: its attestation is several statements on one connection. */
export const ALERT_DB_HANDLE_MS = 12_000;
/**
 * The evaluation's deadline: every rule read, the first read included. A pass too slow to finish
 * fails here and pages instead of running on. On the API it counts from the request's start, the
 * staff handle included, so the last-resort page still fits inside the platform's 60 s.
 */
export const ALERT_DB_EVALUATE_MS = 30_000;
/** The code a read that missed its deadline carries. */
export const ALERT_DB_DEADLINE_CODE = "alert_db_deadline";

const MAX_DEPTH = 5;

interface ChainLink { name: string | null; code: string | null; op: string | null; hasCause: boolean }

/** The `code` fields down the `cause` chain, strings only, at most {@link MAX_DEPTH} deep. */
function chainOf(err: unknown): ChainLink[] {
  const out: ChainLink[] = [];
  let cur: unknown = err;
  for (let i = 0; i < MAX_DEPTH && typeof cur === "object" && cur !== null; i++) {
    const e = cur as { name?: unknown; code?: unknown; op?: unknown; cause?: unknown };
    out.push({
      name: typeof e.name === "string" ? e.name : null,
      code: typeof e.code === "string" && e.code.length > 0 ? e.code : null,
      op: typeof e.op === "string" ? e.op : null,
      hasCause: e.cause !== undefined && e.cause !== null,
    });
    cur = e.cause;
  }
  return out;
}

/** The first string code in `err`'s cause chain, or null. */
function firstCodeOf(err: unknown): string | null {
  return chainOf(err).find((e) => e.code !== null)?.code ?? null;
}

/** "This came from the alert pass's first database read." Checked by name, like `isDbAcquireTimeout`. */
export class AlertDatabaseReadError extends Error {
  readonly op: AlertDatabaseOp;
  readonly code: string | null;
  constructor(op: AlertDatabaseOp, cause: unknown, code?: string) {
    const c = code ?? firstCodeOf(cause);
    super(`the alert pass's ${op} database read failed${c ? ` (${c})` : ""}`);
    this.name = "AlertDatabaseReadError";
    this.op = op;
    this.code = c;
    if (cause !== undefined && cause !== null) (this as { cause?: unknown }).cause = cause;
  }
}

const isTag = (err: unknown): err is AlertDatabaseReadError =>
  typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AlertDatabaseReadError";

/**
 * `read` raced against `ms`. The abandoned read gets an empty catch: a database that answers after
 * the deadline must not leave an unhandled rejection behind. `tagged`: the read's own rejection is
 * tagged too (an already-tagged one passes through); otherwise it passes through as it is.
 */
async function underDeadline<T>(
  op: AlertDatabaseOp, read: () => PromiseLike<T> | T, ms: number, tagged: boolean,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = (async () => read())();
  pending.catch(() => { /* abandoned past the deadline; the pass already failed */ });
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new AlertDatabaseReadError(op, null, ALERT_DB_DEADLINE_CODE)); }, ms);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([pending, deadline]);
  } catch (err) {
    throw !tagged || isTag(err) ? err : new AlertDatabaseReadError(op, err);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Run `read` under a deadline and tag what it rejects with. An already-tagged error passes through. */
export function readAlertDatabase<T>(
  op: "handle" | "preflight", read: () => PromiseLike<T> | T, ms: number,
): Promise<T> {
  return underDeadline(op, read, ms, true);
}

/**
 * Run the pass's evaluation under a deadline: past it, the pass rejects tagged `evaluate` with the
 * deadline's code. Nothing else is tagged: the evaluation also asks the billing plane, so a failure
 * of its own passes through as it is and is judged by its code like any untagged error.
 */
export function evaluationUnderDeadline<T>(read: () => PromiseLike<T> | T, ms: number): Promise<T> {
  return underDeadline("evaluate", read, ms, false);
}

/**
 * Codes only the database produces: postgres.js's connection codes, the pooled handle's acquire
 * ceiling, a read-only database (25006) and the internal errors (XX000-XX002), beside the SQLSTATE
 * classes of {@link DATABASE_ONLY_CLASSES}.
 */
const DATABASE_ONLY_CODES: ReadonlySet<string> = new Set([
  "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "CONNECT_TIMEOUT",
  "CONNECTION_CONNECT_TIMEOUT",
  "db_acquire_timeout",
  "25006",
  "XX000", "XX001", "XX002",
]);

/**
 * Whole SQLSTATE classes only a failing server returns: 08 connection exception, 53 insufficient
 * resources (disk full, out of memory, too many connections), 57 operator intervention (a statement
 * timeout or cancel, a shutdown, a dropped database), 58 system error (I/O). By class, so a member
 * nobody enumerated still counts.
 */
const DATABASE_ONLY_CLASSES = /^(08|53|57|58)[0-9A-Z]{3}$/;

const databaseOnly = (code: string): boolean => DATABASE_ONLY_CODES.has(code) || DATABASE_ONLY_CLASSES.test(code);

/**
 * True when `err` says the pass could not use its database. Reads `code` fields along `cause` only.
 * Tagged by the handle or the first read: any code counts, except a `NotContentBlindError` with no
 * cause (a verdict on the role, not a failed read). Tagged by the evaluation: its deadline.
 * Otherwise: only codes the database alone produces.
 */
export function isAlertDatabaseUnreadable(err: unknown): boolean {
  const chain = chainOf(err);
  const tag = chain.find((e) => e.name === "AlertDatabaseReadError");
  if (tag && tag.op !== "evaluate") {
    if (chain.some((e) => e.name === "NotContentBlindError" && !e.hasCause)) return false;
    return chain.some((e) => e.code !== null);
  }
  if (tag && tag.code === ALERT_DB_DEADLINE_CODE) return true;
  return chain.some((e) => e.code !== null && databaseOnly(e.code));
}
