import {
  AccountErasedError, MailboxErasedError, fenceErased, fenceErasedMailbox,
  type FenceScope, type Tx,
} from "@trafficflow/db";
import type { Dialect, LockMode } from "@trafficflow/db/dialect";
import { ServiceError } from "./errors.js";

/**
 * The erasure fence. `accounts` SURVIVES Art. 17 erasure (the pseudonymous billing subject), so
 * nothing structural refuses a LATE writer: an in-flight consent PATCH can commit its settings
 * upsert after `deleteAccount` commits — and the sweep's promise is ZERO surviving rows. The
 * interlock: the erasure stamps `accounts.erased_at` FIRST; every settings writer reads the same
 * row `FOR SHARE` first and refuses on a stamp. Both orders close: fence first — the stamp waits
 * and the deletes take the writer's rows too; stamp first — this read waits, sees the stamp,
 * refuses. The fence is the FIRST lock its transaction takes, so no cycle can form. Mail-sync
 * writers are NOT fenced: their rows key off tables erasure deletes. 410, not 404.
 */
export async function fenceErasedAccount(
  tx: Tx, d: Dialect, accountId: string, mode: LockMode = "share",
): Promise<void> {
  await fenceErasedScope(tx, d, { accountId, lock: mode });
}

/**
 * The same fence with the MAILBOX scope available — `fenceErased` from `@trafficflow/db` with the
 * HTTP error shape put on at the edge. A mailbox-keyed writer passes `mailboxId`: a mailbox
 * removal leaves its row standing, so the account's stamp says nothing about it.
 */
export async function fenceErasedScope(tx: Tx, d: Dialect, scope: FenceScope): Promise<void> {
  try {
    await fenceErased(tx, d, scope);
  } catch (err) {
    throw asServiceRefusal(err);
  }
}

/**
 * THE MAILBOX ARM ALONE, with the same 410 on it — `fenceErasedMailbox` is to this what
 * `fenceErased`'s account half is to {@link fenceErasedAccount}.
 *
 * For a writer whose row hangs off a NOT NULL key to `mailboxes`: the ACCOUNT sweep deletes that
 * parent, so the account erasure is refused by the key and the mailbox's own stamp is the only
 * question left. It reads ONE row, so a caller already holding it adds no lock and cannot invert
 * the account-then-mailbox order the fence and both sweeps share.
 */
export async function fenceErasedMailboxOnly(
  tx: Tx, d: Dialect, mailboxId: string, mode: LockMode = "share",
): Promise<void> {
  try {
    await fenceErasedMailbox(tx, d, mailboxId, mode);
  } catch (err) {
    throw asServiceRefusal(err);
  }
}

/**
 * The seam's refusals in the shape an HTTP caller answers with, in ONE place because two copies
 * of a mapping is one mapping and one drift. 410 and not 404: the resource existed and the person
 * is the reason it does not. Anything else travels untouched.
 */
export function asServiceRefusal(err: unknown): unknown {
  if (err instanceof AccountErasedError) {
    return new ServiceError("account_erased", 410,
      "this account has been deleted; its settings cannot be changed");
  }
  if (err instanceof MailboxErasedError) {
    return new ServiceError("mailbox_erased", 410,
      "this mailbox has been erased; nothing more can be written against it");
  }
  return err;
}
