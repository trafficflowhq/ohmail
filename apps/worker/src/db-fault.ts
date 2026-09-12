import { DatabaseFaultError } from "./dead-letter.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  WHOSE SOCKET WAS IT — TAGGING A DATABASE FAULT AT ITS ORIGIN INSTEAD OF GUESSING FROM A CODE
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The worker's cycle loop has to answer one question about every throw: is this evidence about
 * ONE CUSTOMER'S MAILBOX, or about a dependency the whole shard shares? Get it wrong toward
 * "shared" and a mailbox whose provider genuinely rejects us is never quarantined. Get it wrong
 * toward "mailbox" and one Postgres blip walks thirteen healthy mailboxes to `status='error'`,
 * each with an exponential backoff earned against a provider that did nothing.
 *
 * {@link isDatabaseFault} in `dead-letter.ts` answers it from the error's `code`, and its own
 * header records why that answer has to stay narrow: at `attach()` an `ECONNREFUSED` is far more
 * likely to be the customer's IMAP host than our database, so raw errnos may not count. It then
 * states the residual it cannot close:
 *
 *   *"postgres.js surfaces a bare `ECONNREFUSED` when Postgres itself is down, so a total database
 *   outage at this line is still rendered as a per-mailbox connect failure."*
 *
 * MEASURED, against the real Postgres on :5433, rather than assumed:
 *
 *   | injected fault                        | what postgres.js throws                        |
 *   |---------------------------------------|------------------------------------------------|
 *   | Postgres not listening                | `AggregateError`, `code: "ECONNREFUSED"`       |
 *   | pool `end()` under a live statement   | `Error`, `code: "CONNECTION_ENDED"`            |
 *   | `statement_timeout`                   | `PostgresError`, `code: "57014"`               |
 *   | dial into a blackhole                 | `Error`, `code: "EPERM"` / `"ETIMEDOUT"`       |
 *   | DNS gone                              | `Error`, `code: "ENOTFOUND"`                   |
 *   | wrong database name                   | `PostgresError`, `code: "3D000"`               |
 *
 * Rows 1, 4 and 5 are BYTE-IDENTICAL to what a dead IMAP host throws. No predicate over `code`
 * can separate them, however many codes it enumerates — and rows 1 and 4 are precisely "the
 * database is down", i.e. the case the taxonomy exists for. The information is simply not in the
 * error; it is in WHERE THE CALL WAS MADE.
 *
 * So it is recorded there. Every database call the sync loop makes goes through `SyncDeps.repo`
 * or `SyncWriteFence.transaction`, both of which the hosted worker constructs — so both are
 * wrapped here, and a throw that comes out of one is a {@link DatabaseFaultError} whatever it
 * says about itself. The cycle loop then exempts BY CLASS, which is the same shape
 * `LeaderFencedError` and `ClassifierFaultError` already use and for the same reason: an
 * exemption keyed on a class cannot be tuned into a wrong answer.
 *
 * ── WHAT THIS TAG DOES NOT DECIDE ─────────────────────────────────────────────────────────────
 *
 * It names the ORIGIN and nothing else. "It came out of the database" is not the same claim as
 * "the database is at fault": Postgres answering `23505` or `22021` is the database telling us
 * about the VALUE this mailbox's mail carried, which is per-message evidence and must keep its
 * per-message verdict. `classifyIngestFault` therefore unwraps this class before classifying, and
 * `isSharedDatabaseFault` subtracts exactly those two SQLSTATE classes back out. Tagging the
 * origin makes the domain question ANSWERABLE; it does not answer it.
 *
 * ── AND WHY IT IS NOT APPLIED TO `loadMailboxCreds` ──────────────────────────────────────────
 *
 * That call is the attach path's database read and it is deliberately left untagged. It does two
 * things — read a row AND decrypt the envelope in it — and a credential that will not decrypt is
 * the most per-mailbox failure there is (see the attach catch in `index.ts`). A tag around the whole
 * call would promote a bad envelope to a shard-wide condition, which is the mailbox-isolation defect wearing
 * the opposite sign. Splitting that function is a separate change; until it happens the attach
 * seam keeps the narrow code-only question and keeps the residual quoted above.
 */

/**
 * ── WHY THE CLASS ITSELF IS NOT IN THIS FILE ──────────────────────────────────────────────────
 *
 * {@link DatabaseFaultError} lives in `dead-letter.ts`, and the split is the publish boundary
 * telling us where it belongs rather than a preference. The desktop engine's source closure
 * reaches `dead-letter.ts` (through `sync.ts`, which both hosts share), so it reaches every
 * module `dead-letter.ts` imports — and `publish-desktop.mjs` refused this file by name with the
 * instruction that is exactly right: *"move the shape the mail half needs into a module that may
 * be published and leave the behaviour behind it."*
 *
 * The SHAPE is the class: `classifyIngestFault` has to recognise it, and that function is one
 * implementation serving two hosts. The BEHAVIOUR is everything below — a Proxy over the hosted
 * worker's repo — which the standalone engine has no use for, since it builds its own repo and
 * tags nothing. Nothing in this file is secret; it simply is not the engine's.
 */

/** Tag `err` unless it already carries the tag — wrapping twice would bury the cause chain. */
function tag(op: string, err: unknown): unknown {
  return err instanceof DatabaseFaultError ? err : new DatabaseFaultError(op, err);
}

/**
 * Wrap ONE database call so its throw names the database as its origin.
 *
 * For the seams that are not method calls on a repo — `db.transaction(...)`, a bare `select`
 * inside the fence. `await`ed rather than returned, so a rejection is caught here rather than by
 * whoever eventually awaits it.
 */
export async function asDatabaseFault<T>(op: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw tag(op, err);
  }
}

/**
 * Return `target` with every method's rejection tagged as a {@link DatabaseFaultError}.
 *
 * A `Proxy` rather than a hand-written façade because `WorkerRepo` is ~90 methods and a façade
 * would be a list that silently stops covering the method somebody adds next — the failure mode
 * being "one uncovered write quarantines a mailbox during an outage", which is invisible until
 * there is an outage.
 *
 * The prototype is preserved (a `Proxy` forwards `instanceof`), non-function properties pass
 * through untouched, and the call is applied to the RAW target so `this` never re-enters the
 * proxy. A synchronous throw is tagged too: `DrizzleRepo`'s methods are `async` and cannot
 * produce one today, and depending on that would be depending on a detail of somebody else's
 * class.
 *
 * NOT applied to the transaction-scoped repo `DrizzleRepo.transaction` hands its callback — it
 * does not need to be. The `transaction` call ITSELF is a method on this object, so anything the
 * callback throws leaves through a tagged frame anyway, and the tag is idempotent.
 */
export function markDatabaseFaults<T extends object>(target: T, label: string): T {
  return new Proxy(target, {
    get(obj, prop, receiver): unknown {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== "function") return value;
      const op = `${label}.${typeof prop === "string" ? prop : String(prop)}`;
      return (...args: unknown[]): unknown => {
        let out: unknown;
        try {
          out = (value as (...a: unknown[]) => unknown).apply(obj, args);
        } catch (err) {
          throw tag(op, err);
        }
        // Only promises are re-wrapped; a method returning a plain value (or a query builder)
        // is handed back exactly as it was.
        return out instanceof Promise ? out.catch((err: unknown) => { throw tag(op, err); }) : out;
      };
    },
  });
}
