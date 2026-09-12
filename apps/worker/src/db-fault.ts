import { DatabaseFaultError } from "./dead-letter.js";

/**
 * WHOSE SOCKET WAS IT — tagging a database fault at its ORIGIN instead of guessing from a code. The cycle
 * loop must answer, per throw: is this about ONE customer's mailbox or a shard-wide dependency? Wrong toward
 * "shared" and a genuinely-rejecting provider is never quarantined; wrong toward "mailbox" and one Postgres
 * blip walks thirteen healthy mailboxes to `status='error'`. {@link isDatabaseFault} answers from `code`
 * and must stay narrow: measured on :5433, a down database throws `ECONNREFUSED`/`EPERM`/`ETIMEDOUT`/
 * `ENOTFOUND` (byte-identical to a dead IMAP host), while `CONNECTION_ENDED`/`57014`/`3D000` are its own —
 * so the information is in WHERE THE CALL WAS MADE. Every cycle DB call goes through `SyncDeps.repo` or
 * `SyncWriteFence.transaction`, both wrapped here, so a throw is a {@link DatabaseFaultError} and the loop
 * exempts BY CLASS. It names ORIGIN only: `23505`/`22021` stay per-message (`classifyIngestFault` unwraps, `isSharedDatabaseFault` subtracts), and `loadMailboxCreds` is deliberately untagged (a bad envelope is per-mailbox). */

/**
 * WHY THE CLASS ITSELF IS NOT IN THIS FILE. {@link DatabaseFaultError} lives in `dead-letter.ts`, and the
 * split is the publish boundary, not a preference: the desktop engine's source closure reaches
 * `dead-letter.ts` (through `sync.ts`, shared by both hosts) and everything it imports, and
 * `publish-desktop.mjs` refused this file by name with "move the shape the mail half needs into a module
 * that may be published and leave the behaviour behind it." The SHAPE is the class (`classifyIngestFault`
 * must recognise it, one implementation for two hosts); the BEHAVIOUR is the Proxy over the hosted worker's
 * repo, which the standalone engine has no use for. Nothing here is secret; it simply is not the engine's.
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
 * Return `target` with every method's rejection tagged as a {@link DatabaseFaultError}. A `Proxy`, not a
 * hand-written façade, because `WorkerRepo` is ~90 methods and a façade silently stops covering the one
 * somebody adds next — the failure being "an uncovered write quarantines a mailbox during an outage",
 * invisible until there is one. The prototype is preserved (a Proxy forwards `instanceof`), non-function
 * properties pass through, and the call is applied to the RAW target so `this` never re-enters the proxy.
 * A synchronous throw is tagged too (`DrizzleRepo`'s methods are async and cannot produce one today, but
 * depending on that is depending on someone else's class). NOT applied to the transaction-scoped repo
 * `DrizzleRepo.transaction` hands its callback — the `transaction` call is a method here, so anything it
 * throws leaves through a tagged frame anyway, and the tag is idempotent. */
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
