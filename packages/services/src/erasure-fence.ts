import { readAccountErasedAt, type Tx } from "@trafficflow/db";
import type { Dialect } from "@trafficflow/db/dialect";
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
export async function fenceErasedAccount(tx: Tx, d: Dialect, accountId: string): Promise<void> {
  // `readAccountErasedAt` is `@trafficflow/db`'s primitive — see its own header for why the read
  // moved and why this function is not a second implementation of it.
  const erasedAt = await readAccountErasedAt(tx, d, accountId);
  if (erasedAt === undefined) {
    // No accounts row is PROOF the account was never erased, not a suspicious absence: erasure
    // KEEPS the row (the pseudonymous billing subject) and stamps it — a deleted row is the one
    // thing `deleteAccount` cannot produce. So the fence has nothing to say and stays out of the
    // way. Refusing here was tried and is wrong twice over: `account_settings.account_id`
    // carries no FK to `accounts`, so a bare-id write is legal at the schema level, and half the
    // service suites exercise writers against minted ids with no accounts row — a 404 here turns
    // the fence into a general existence check nobody asked for.
    return;
  }
  if (erasedAt !== null) {
    throw new ServiceError("account_erased", 410,
      "this account has been deleted; its settings cannot be changed");
  }
}
