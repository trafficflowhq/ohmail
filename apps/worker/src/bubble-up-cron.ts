import { type Tx } from "@trafficflow/db";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { silentLogger, type Logger } from "@trafficflow/core";
import { selectionOf, type WorkerConfig } from "./config.js";
import { acquireLeaderLock, leaderLockKeyFor } from "./leader-lock.js";
import { loadServedAccounts } from "./mailboxes.js";
import { isCliEntry } from "./entry.js";
import { cronEvent, runCronCli } from "./cron-log.js";
import { bubbleUpPass } from "./bubble-up-pass.js";

/**
 * THE PASS ITSELF MOVED, and the re-export is what keeps that from being a rename with a blast
 * radius. `bubble-up-pass.ts` holds it now, for one reason stated in full there: the DESKTOP
 * engine runs the same flip against its own local store and must not acquire this module's
 * graph — the leader lock, the `postgres` driver and the served-account roster, none of which
 * exists on a laptop. Everything that already imported it from here still can.
 */
export { bubbleUpPass } from "./bubble-up-pass.js";

/**
 * MANUAL BACKSTOP — for a worker that is dead, not for a scheduler.
 *
 * Guarded by the shard's session-level leader lock — the same one the always-on worker and the
 * other three backstops use: if the live worker holds it, this run exits without touching the
 * DB. Otherwise it performs one resurfacing pass PER SERVED ACCOUNT (its shard's duty, each
 * isolated so one account's failure never skips the rest) and releases. Scoping by account is
 * what keeps the shard-specific lock meaningful.
 *
 * That lock is exactly why this is NOT a platform cron service: while the worker is
 * healthy, a scheduled process here would only ever start, fail to acquire, and exit. The
 * resurfacing that production depends on happens inline in `cycle()`; this exists so an
 * operator can flush the backlog by hand when the worker is down. It is recorded as
 * `MANUAL_BACKSTOP` in `SCHEDULE_MANIFEST` (`test/every-pass-has-a-producer.test.ts`).
 *
 * `log` defaults to `silentLogger` — see `cron-log.ts` for why the process that deploys is
 * the only one that turns it on.
 */
export async function runBubbleUpCron(
  config: WorkerConfig, log: Logger = silentLogger,
): Promise<{ ran: boolean; flipped: number }> {
  const lock = await acquireLeaderLock(config.databaseUrl, leaderLockKeyFor(config.shardIndex ?? 0));
  if (!lock) return { ran: false, flipped: 0 };

  const owned = makeOwnedDb(config.databaseUrl);
  const db = owned.db;
  try {
    const now = new Date();
    let flipped = 0;
    for (const accountId of await loadServedAccounts(db, selectionOf(config))) {
      try {
        const res = await bubbleUpPass(db as unknown as Tx, now, { accountId });
        flipped += res.flipped;
      } catch (err) {
        log.error(cronEvent("bubble_up", "account_failed"), { accountId, err });
      }
    }
    return { ran: true, flipped };
  } finally {
    try { await owned.close(); } catch (err) { log.error(cronEvent("bubble_up", "pool_close_failed"), { err }); }
    await lock.release();
  }
}

if (isCliEntry(import.meta.url)) {
  void runCronCli("bubble_up", runBubbleUpCron, (r) => ({ ran: r.ran, fields: { flipped: r.flipped } }));
}
