import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { mailboxes, type Tx } from "@trafficflow/db";
import { silentLogger, type Logger } from "@trafficflow/core";

/**
 * ENFORCED SYNC — the worker half of `mailboxes.sync_requested_at` (mail 0049). The API stamps it the
 * instant it finalizes a write the user is watching; this pass is the doorbell's other end — a short scan,
 * far more often than the 60 s poll, that kicks an out-of-band cycle for any stamped mailbox this process
 * serves and clears the stamp. FIVE write sites ring it, each finalizing a write somebody is watching:
 * `SendService.finalizeSent`, the junk rescue and the junk sweep press, the folder-op service and the
 * mailbox service's own resync. Ordinary FILING does not — those writers commit desired state and stop,
 * so filed mail waits ~105 s for its turn, a real gap left open deliberately. NOT a leader-locked backstop — it runs
 * only inside a live worker over its own attached mailboxes (producer: the ~3 s timer in `index.ts`). The
 * clear is COMPARE-AND-CLEAR (`WHERE sync_requested_at = <observed>`) so a second stamp mid-flight is
 * preserved; and compared as TEXT (`::text` / `= <that>::timestamptz`) because `timestamptz` microseconds never survive a JS millisecond `Date` — measured 2026-08-26, an SQL `now()` stamp kicked every 3 s for 10+ min. Pure/hermetic, proven on real Postgres. */
export interface SyncKickDeps {
  /** The db/tx handle. */
  db: Tx;
  /** The mailbox ids this process currently serves (the worker's live runtime keys). */
  served: () => Iterable<string>;
  /**
   * Trigger an out-of-band ingest/reconcile for one served mailbox. The worker wires this to an
   * immediate cycle request (which returns void); it is AWAITED so the compare-and-clear below can
   * only run once the kick has been issued, which is what makes a stamp that changes mid-kick
   * observable — and testable — rather than a race. Called at most once per stamped mailbox per pass.
   */
  kick: (mailboxId: string) => void | Promise<void>;
  now?: () => Date;
  log?: Logger;
}

export interface SyncKickResult {
  /** Mailboxes that were stamped and served, and for which `kick` was called this pass. */
  kicked: string[];
  /** How many of those had their stamp cleared (compare-and-clear landed; a newer stamp did not). */
  cleared: number;
}

/**
 * One kick scan. Returns which served mailboxes owed a reconcile and were kicked, and how many
 * stamps were cleared — the two numbers the pg test and the worker's log line read.
 */
export async function syncKickPass(deps: SyncKickDeps): Promise<SyncKickResult> {
  const log = deps.log ?? silentLogger;
  const served = [...new Set(deps.served())];
  if (served.length === 0) return { kicked: [], cleared: 0 };

  // Only mailboxes THIS process serves AND that are stamped. Scoping to the served set is what
  // keeps the pass from reaching into a mailbox another worker (or a desktop install) organizes —
  // the same principle the roster pass follows. The stamp is read AS TEXT — see the header: a
  // `Date` truncates the server's microseconds and the compare-and-clear below must name the
  // stored value exactly.
  const rows = await deps.db
    .select({
      id: mailboxes.id,
      requestedAtText: sql<string | null>`${mailboxes.syncRequestedAt}::text`,
    })
    .from(mailboxes)
    .where(and(inArray(mailboxes.id, served), isNotNull(mailboxes.syncRequestedAt)));

  const kicked: string[] = [];
  let cleared = 0;
  for (const row of rows) {
    if (!row.requestedAtText) continue; // isNotNull already guarantees this; narrows the type.
    // Kick first: the mailbox owed a reconcile the moment we read the stamp, and a kick is only a
    // request for a cycle, so it is safe to issue before the clear even if the clear then misses.
    try {
      await deps.kick(row.id);
      kicked.push(row.id);
    } catch (err) {
      log.warn("sync_kick_trigger_failed", { mailboxId: row.id, err });
      continue; // do NOT clear a stamp we failed to act on.
    }
    // Compare-and-clear on the observed instant, at the SERVER's precision. A stamp that changed
    // since the read (a second send) does not match and is preserved for the next pass.
    const done = await deps.db
      .update(mailboxes)
      .set({ syncRequestedAt: null })
      .where(and(
        eq(mailboxes.id, row.id),
        sql`${mailboxes.syncRequestedAt} = ${row.requestedAtText}::timestamptz`,
      ))
      .returning({ id: mailboxes.id });
    if (done.length > 0) cleared += 1;
  }
  return { kicked, cleared };
}
