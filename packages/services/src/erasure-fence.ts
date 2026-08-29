import { eq } from "drizzle-orm";
import { accounts, type Tx } from "@trafficflow/db";
import { ServiceError } from "./errors.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE ERASURE FENCE — why a settings write must look at a row erasure never deletes
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `accounts` SURVIVES Art. 17 erasure by design (the pseudonymous billing subject the credit
 * ledger points at), so nothing structural refuses a LATE writer: a consent-settings PATCH whose
 * transaction started while its session was still alive can commit its `account_settings` upsert
 * — and, through the settings doorbell, `change_log` / `account_sync_state` rows — after
 * `deleteAccount` commits. The erasure deletes users and sessions, so no NEW request can follow;
 * the in-flight one is the gap. The recreated rows are preference
 * scalars and a doorbell row — no mail, no credentials — but the catalog sweep's promise is ZERO
 * surviving rows, and a row recreated a millisecond after the sweep is a row the sweep cannot
 * see. The lock-order work (settings → mailboxes → sequence row) fixed the DEADLOCKS between
 * these two transactions; it cannot fix late recreation, because a lock order says nothing about
 * a transaction that starts after the erasure released everything.
 *
 * ── THE INTERLOCK, and why FOR SHARE is the whole mechanism ─────────────────────────────────
 *
 * `deleteAccount` stamps `accounts.erased_at` FIRST in its transaction (`coalesce`d, so a
 * retried erasure keeps the first stamp) — taking the account row's exclusive lock before any
 * delete. This function is the writer's half: read the same row `FOR SHARE` before touching any
 * settings row, refuse on a stamp. The share lock is not decoration — it is what closes BOTH
 * orders of the race:
 *
 *   · fence first → the erasure's stamp WAITS on this transaction's share lock, so the writer's
 *     rows commit BEFORE the erasure's deletes run, and the deletes take them with everything
 *     else. Zero survivors.
 *   · stamp first → this read WAITS out the whole erasure, then sees the committed stamp (READ
 *     COMMITTED re-evaluates the row after the lock wait) and refuses. Nothing was written.
 *
 * A plain read without the lock reopens the gap it exists to close: it could see NULL, the
 * erasure could run to commit in full, and the writer's upsert would then land on the swept
 * tables exactly as before.
 *
 * ── THE LOCK ORDER THIS ADDS, and why it cannot deadlock ────────────────────────────────────
 *
 * The fence is the FIRST lock its transaction takes, making the global order a strict chain:
 * accounts → account_settings → (mailboxes) → the change-log sequence row. The erasure follows
 * the same chain (stamp, then the settings delete that was already first). No transaction in the
 * repository acquires the accounts row AFTER any of those locks — the only other accounts
 * writers are account creation (holds nothing else) and `setAiEnabled` (accounts first, then an
 * audit insert) — so no cycle can form from either side. That property is load-bearing: a fence
 * moved to the MIDDLE of a writer's transaction (after the settings lock) would be the textbook
 * opposite-order pair against the erasure and would reintroduce the 40P01 family the lock-order
 * conformance closed. Keep it first.
 *
 * ── WHO MUST CALL THIS ──────────────────────────────────────────────────────────────────────
 *
 * Every writer of `account_settings`, at the top of the transaction that writes it: the consent
 * knobs and `confirmSeed` (consent-seed.ts), the screening reset (consent-reset.ts), the
 * screening preference and the tidy request (screening-preference.ts), the Screener decide's
 * baseline stamp (screener-service.ts) — and the operational baseline backfill
 * (`scripts/backfill-screening-baseline.mjs`), which carries the same interlock in raw SQL
 * because it writes the same row from outside this package (a review found it recreating the
 * row post-erasure before it did). Writers of mail-sync state are deliberately NOT fenced —
 * their rows key off mailboxes and messages, which erasure deletes, so a late one fails on the
 * missing parent instead of surviving; fencing the ingest path would put one extra row lock on
 * every sync write for a race the foreign keys already lose loudly.
 *
 * 410, not 404: the row exists, the account is gone as a data subject, and a caller holding a
 * pre-erasure session should be told the account was removed rather than sent hunting for a
 * typo'd id.
 */
export async function fenceErasedAccount(tx: Tx, accountId: string): Promise<void> {
  const [row] = await tx.select({ erasedAt: accounts.erasedAt })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1)
    .for("share");
  if (row === undefined) {
    // No accounts row is PROOF the account was never erased, not a suspicious absence: erasure
    // KEEPS the row (the pseudonymous billing subject) and stamps it — a deleted row is the one
    // thing `deleteAccount` cannot produce. So the fence has nothing to say and stays out of the
    // way. Refusing here was tried and is wrong twice over: `account_settings.account_id`
    // carries no FK to `accounts`, so a bare-id write is legal at the schema level, and half the
    // service suites exercise writers against minted ids with no accounts row — a 404 here turns
    // the fence into a general existence check nobody asked for.
    return;
  }
  if (row.erasedAt !== null) {
    throw new ServiceError("account_erased", 410,
      "this account has been deleted; its settings cannot be changed");
  }
}
