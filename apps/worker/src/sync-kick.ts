import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { mailboxes, type Tx } from "@trafficflow/db";
import { silentLogger, type Logger } from "@trafficflow/core";

/**
 * ENFORCED SYNC — the worker half of `mailboxes.sync_requested_at` (mail 0049).
 *
 * ── WHAT IT IS ────────────────────────────────────────────────────────────────────────────
 *
 * The API stamps `sync_requested_at = now()` the instant it finalizes a write the user is
 * watching for. This pass is the doorbell's other end: a short scan, run far more often than the
 * 60 s poll, that finds any stamped mailbox THIS process serves and triggers an out-of-band cycle
 * for it, then clears the stamp. The effect the user sees is "I sent it / there it is" in seconds
 * instead of up to a poll interval later.
 *
 * ── EXACTLY ONE WRITE SITE RINGS IT, AND FILING IS NOT ONE OF THEM ──────────────────────────
 *
 * `SendService.finalizeSent` is the whole of the producer side. This paragraph used to name "a
 * folder move whose desired state the mirror should reflect" as a second one, and no such stamp
 * has ever existed: `MessageService.move`, `ScreenerService`'s decide path and the three other
 * writers of `folder_state` all commit desired state and stop. So a mailbox whose owner has just
 * filed mail waits for its ORDINARY TURN in the serial cycle before any of it reaches their
 * server — measured at ~105 s on a thirteen-mailbox worker with nothing else to do, and longer
 * behind any mailbox that is busy.
 *
 * That is a real gap and it is deliberately still open. Ringing the doorbell from the filing
 * writers is not a one-liner at the seam that carries the volume: `ScreenerService` reaches
 * `reconcileMailbox` with `mailboxId: ""` and does not have the mailbox in scope at all, so the
 * change is a plumbing change across four services rather than a stamp. What is NOT acceptable is
 * a comment here describing a producer the codebase does not have.
 *
 * It is deliberately NOT one of the leader-locked backstop crons in this directory. Those exist to
 * flush a backlog when the worker is dead; this only ever runs INSIDE a live worker, over the
 * mailboxes that worker is already attached to, so it takes no lock and reaches into no mailbox it
 * is not the organizer of. Its producer is the ~3 s timer in `index.ts`.
 *
 * ── WHY THE CLEAR IS COMPARE-AND-CLEAR ──────────────────────────────────────────────────────
 *
 * A second stamp can land WHILE a kick is in flight — a user sends two messages in a row. If the
 * pass cleared the column unconditionally it would erase the second request and the second Sent
 * copy would wait for the poll after all. So the clear names the exact value it observed
 * (`WHERE sync_requested_at = <observed>`): a stamp that changed in the meantime is preserved, the
 * clear is a no-op, and the next scan re-kicks. The kick itself is idempotent — it only asks for a
 * cycle — so re-kicking a mailbox that is still stamped costs one extra cycle and nothing else.
 * That is the whole of its convergence: a stamped mailbox is either being served now or on the next
 * ~3 s pass, and the 60 s poll is the floor beneath both.
 *
 * ── AND WHY "THE EXACT VALUE" IS COMPARED AS TEXT, NEVER THROUGH A `Date` ───────────────────
 *
 * `timestamptz` carries MICROSECONDS; a JavaScript `Date` carries milliseconds. Reading the
 * column into a `Date` and comparing the column to that `Date` therefore matches only stamps
 * whose microsecond part happens to be zero — a stamp written by a JS producer round-trips, and
 * a stamp written by SQL `now()` NEVER matches. The failure is not "the clear misses once": the
 * stamp is re-observed on every 3-second pass, so one SQL-written stamp turns into a kick every
 * 3 seconds for ever — permanent cycle pressure from one row, measured live on 2026-08-26 (a
 * `now()` stamp stayed set for 10+ minutes of passes; the same stamp written with millisecond
 * precision cleared in 2.0 s). So the pass reads `sync_requested_at::text` and clears
 * `WHERE sync_requested_at = <that text>::timestamptz` — the comparison token is server-derived
 * and exact at the server's own precision, whoever wrote the stamp. The pg test writes one stamp
 * with `clock_timestamp()` (six fractional digits) precisely because a JS-seeded test cannot see
 * this.
 *
 * ── PURE AND HERMETIC ───────────────────────────────────────────────────────────────────────
 *
 * It takes the db handle, the set of mailbox ids this process serves, and the `kick` that
 * triggers a cycle — all injected — so a pg test drives it against real Postgres with a spy `kick`
 * and no worker loop, no leader lock and no network. The compare-and-clear is exactly the kind of
 * fragment PGlite binds happily and postgres-js may not, so it is proven on real Postgres.
 */
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
