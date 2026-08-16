import { resolveThread, silentLogger, type Logger } from "@trafficflow/core";
import type { ThreadBacklogRow, WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE THREAD BACKFILL — and where it was re-placed
   ══════════════════════════════════════════════════════════════════════════════════════════

   ── WHERE IT RUNS, WHICH IS THE ONLY THING THE FIRST VERSION GOT WRONG ─────────────────────

   Behind the sync cycle, one bounded slice per completed cycle, one account per slice —
   `kickThreadBackfill` in `index.ts`. NOT on the attach path, where it first ran: there it ran to
   exhaustion between `adapter.connect()` and `adapter.watch()`, i.e. while holding a
   freshly-dialled IMAP connection that was not yet in IDLE and had nothing awaiting it. On a
   large real mailbox that idle stretch outlasted the socket timeout, the connection
   died, and imapflow emitted the error on a client with no `error` listener — an UNCAUGHT
   exception, so the process exited and the platform restarted it every ~26 s for eight minutes with
   nothing syncing.

   Threading at ingest fixes every message that arrives from now on. It fixes nothing that is
   already in the database, and what is already in the database is the entire product as its
   owner sees it: every existing row, seeded worlds and real mailboxes alike, carried
   `thread_id` NULL. Without this pass, threading ships and the mailbox still reads as singletons.

   ── NO IMAP ────────────────────────────────────────────────────────────────────────────────

   The chain is read from `message_bodies.headers`, which `commitChange` has persisted for every
   message since the first ingest build. Re-fetching thousands of messages over IMAP to read three
   headers we already
   have would be minutes of somebody's mail server for data sitting on disk, and it would put a
   network call inside the pass that writes `change_log` (the delta contract forbids exactly that).

   ── AND NO MARKER COLUMN, WHICH IS THE ONE PLACE IT DIVERGES FROM THE KICKSTART ────────────

   `runKickstart` needs `mailboxes.kickstart_at` and a monotone cursor because its candidate set
   never empties: most of the Screener backlog is genuine first contact and STAYS in the
   Screener, so "loop until nothing comes back" would read the same hundred strangers for ever.

   This pass has the opposite property. Its predicate is `thread_id IS NULL`, and every row it
   examines gets a `thread_id` — so the candidate set strictly shrinks and an empty page is a
   real end condition. The work item IS the marker, which is strictly better than a stamped
   flag: a message that somehow reaches the database without a thread is picked up by the next
   slice instead of being permanently excluded by a bit that says "done". It is also what makes
   the slice budget free — a pass that stops half-way has nothing to record, because where it
   stopped is where the predicate now starts. The steady-state cost of a drained account is one
   indexed probe per slice, served by `messages_account_thread_idx (account_id, thread_id)`.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Messages resolved per transaction.
 *
 * The same 100 as {@link import("./kickstart.js").KICKSTART_BATCH} and for the same reason:
 * `recordChange` holds the account's `account_sync_state` row lock for the length of its
 * transaction, so a whole-backlog transaction would stall every API write for that account
 * while thousands of messages drained. 100 rows is a few milliseconds of lock, and the pass is
 * resumable between batches by construction.
 */
export const THREAD_BACKFILL_BATCH = 100;

/**
 * Pages the pass will walk before giving up and saying so — fifty thousand messages at the batch above.
 *
 * A bound and not a `while (true)`, because unlike the kickstart this loop's termination
 * depends on every examined row LEAVING the predicate. If `setMessageThread` ever stopped
 * stamping, the same hundred rows would come back for ever against the live database. The cap turns
 * that regression into a warning line instead of a pinned CPU.
 *
 * It is the ABSOLUTE ceiling, not the per-pass budget: {@link ThreadBackfillDeps.maxPages}
 * bounds a slice and is clamped to this. Reaching THIS number is the regression signal and is
 * the only case that warns.
 */
export const THREAD_BACKFILL_MAX_PAGES = 500;

/**
 * Pages ONE slice of the worker's paced drain walks — two thousand messages.
 *
 * This constant, and the deadline below, are the whole of the placement correction. The first
 * version ran the pass to
 * exhaustion on the attach path: on a large real mailbox that held a freshly-dialled
 * IMAP connection open and idle for minutes, the socket died, and the error escaped as an
 * uncaught exception. The pass itself was never the
 * problem — an unbounded pass in front of a connection was. See `kickThreadBackfill` in
 * `index.ts` for where it runs now.
 */
export const THREAD_BACKFILL_SLICE_PAGES = 20;

/**
 * Wall-clock budget for one slice.
 *
 * `maxPages` alone is not a bound on TIME, and time is what the serial queue actually spends:
 * a page is ~100 × `resolveThread`, each several round trips, so a slow database turns 20 pages
 * into a minute the roster pass and the next sync cycle both wait behind. Checked BETWEEN pages,
 * so a slice always commits at least one batch and can never spin without progress.
 */
export const THREAD_BACKFILL_SLICE_MS = 10_000;

export interface ThreadBackfillDeps {
  repo: WorkerRepo;
  accountId: string;
  log?: Logger;
  /**
   * Pages this pass may walk, clamped to {@link THREAD_BACKFILL_MAX_PAGES}. Absent ⇒ the
   * ceiling, i.e. drain the account (what the tests and any one-shot caller want).
   */
  maxPages?: number;
  /**
   * Wall-clock budget in ms, checked between pages. Absent ⇒ no deadline. `0` is honoured and
   * means "one page, then stop" — the pass always commits at least one batch.
   */
  deadlineMs?: number;
  /** TEST SEAM: the clock the deadline is measured on. */
  now?: () => number;
}

export interface ThreadBackfillResult {
  /** Messages given a `thread_id`. */
  resolved: number;
  /** `threads` rows created. */
  threadsCreated: number;
  /**
   * The pass stopped on a bound rather than on an empty page — backlog may remain, and the
   * next pass resumes it. `false` is the only value that means "this account is drained".
   */
  truncated: boolean;
}

/**
 * The pass, as a value — the seam `WorkerConfig.threadBackfill` injects in tests.
 *
 * A guard has to be able to hand the worker a backfill that sleeps far longer than the IMAP
 * socket timeout, or one that throws, and observe that neither reaches the attach path or the
 * process's exit code. Neither is expressible against a statically imported function.
 */
export type ThreadBackfillPass = (deps: ThreadBackfillDeps) => Promise<ThreadBackfillResult>;

/**
 * Resolve the unthreaded messages of ONE account, oldest first, 100 per transaction, up to
 * {@link ThreadBackfillDeps.maxPages} pages or {@link ThreadBackfillDeps.deadlineMs}.
 *
 * ── ACCOUNT-SCOPED, NOT MAILBOX-SCOPED ─────────────────────────────────────────────────────
 *
 * Because the threading key is. A reply delivered to one of the user's mailboxes can answer
 * mail that arrived in another, and a per-mailbox pass would split that conversation in two.
 * It is also why the worker's slices are round-robin over ACCOUNTS and not over mailboxes: a
 * second mailbox of the same account would only find the backlog already drained.
 *
 * ── DATE ASCENDING IS AN OPTIMISATION, NOT A CORRECTNESS REQUIREMENT ───────────────────────
 *
 * Oldest first means a parent is resolved before its replies, so each reply takes the cheap
 * path (`parent.thread_id` already set) rather than the anchor path. Correctness does not
 * depend on it: `root_message_id_header` makes any arrival order converge on one thread, which
 * is the property `threading.test.ts` proves by ingesting a 4-deep chain backwards.
 *
 * ── TWO PASSES AT ONCE ─────────────────────────────────────────────────────────────────────
 *
 * One worker cannot produce this any more — slices run on the serial queue, one account at a
 * time — but two WORKERS can (a deploy overlap, a shard split, the desktop engine beside Cloud),
 * and the property is cheap to keep. `listThreadBacklog` takes `FOR UPDATE OF messages`, so the
 * loser blocks; when it re-reads under READ COMMITTED the rows no longer satisfy
 * `thread_id IS NULL` and drop out of its result set. One thread per conversation, one
 * `change_log` row per message. That claim is `thread-backfill.pg.test.ts` on real Postgres,
 * because PGlite is single-connection and cannot host the race at all.
 */
export async function runThreadBackfill(deps: ThreadBackfillDeps): Promise<ThreadBackfillResult> {
  const { repo, accountId } = deps;
  const log = deps.log ?? silentLogger;
  const now = deps.now ?? Date.now;
  // Clamped, not trusted: a caller-supplied budget may shrink the ceiling, never raise it.
  const maxPages = Math.max(1, Math.min(deps.maxPages ?? THREAD_BACKFILL_MAX_PAGES, THREAD_BACKFILL_MAX_PAGES));
  const deadline = deps.deadlineMs === undefined ? null : now() + deps.deadlineMs;

  let resolved = 0;
  let threadsCreated = 0;
  let truncated = true;
  /** Which bound stopped the pass — the ceiling is a regression, a slice budget is routine. */
  let stoppedBy: "pages" | "deadline" = "pages";

  for (let page = 0; page < maxPages; page++) {
    // BETWEEN pages and never inside one: a half-written page is not a thing this pass can
    // produce (the transaction is the unit), and a deadline checked before the first page
    // would let a zero budget make no progress at all and re-read the same rows for ever.
    if (page > 0 && deadline !== null && now() >= deadline) { stoppedBy = "deadline"; break; }
    const batch = await repo.transaction(async (tx) => {
      const rows = await tx.listThreadBacklog(accountId, THREAD_BACKFILL_BATCH);
      let created = 0;
      // BUFFERED, and the buffer is the deadlock fix rather than a micro-optimisation.
      // `allocateSeq` holds the account's `account_sync_state` row lock to COMMIT, so
      // recording row 1's change here and then locking row 2's `threads` row would leave this
      // transaction holding the seq lock while it waits on a `threads` row a concurrent ingest
      // holds — and that ingest waits on the seq lock. Draining the buffer after the loop puts
      // every `threads` lock before the first `recordChange`, which is the order ingest already
      // uses. See `ThreadResolution.changes`.
      const owed: Array<{ entityType: "thread" | "message"; entityId: string; op: "create" | "update" }> = [];
      for (const row of rows) {
        const r = await resolveThread(tx, {
          accountId,
          messageId: row.messageId,
          messageIdHeader: row.messageIdHeader,
          headers: row.headers,
          subject: row.subject,
          // The sender alone. `insertMessage` writes `messages.to_addresses` only from the
          // recipients slice onward, and the rows this pass exists for are older than that — a
          // row ingested since then already got its thread at ingest, so it is never selected
          // here. There are no persisted recipients to add — see
          // `ThreadResolutionInput.participants`.
          participants: participantsOf(row),
          date: row.date,
          // TRUE here and false at ingest. The client's mirror already holds this message from
          // an earlier sync; a `message` create is not coming to carry the new `thread_id`, so
          // without this the conversation would be invisible until a re-bootstrap.
          emitMessageUpdate: true,
        });
        if (r.created) created++;
        owed.push(...r.changes);
      }
      for (const c of owed) {
        await tx.recordChange({ accountId, entityType: c.entityType, entityId: c.entityId, op: c.op, meta: null });
      }
      return { rows, created };
    });

    resolved += batch.rows.length;
    threadsCreated += batch.created;
    if (batch.rows.length === 0) { truncated = false; break; }
  }

  if (truncated) {
    // WARN only for the absolute ceiling, and INFO for a slice budget. The two are not the same
    // event: a slice that fills its budget is the paced drain working exactly as designed, and
    // logging it at warn would have made every slice of a real first drain look like a fault.
    // Reaching 500 pages with no caller budget is the other thing — the predicate has stopped
    // extinguishing and the same hundred rows are coming back — and that is worth a pager-shaped
    // line.
    const ceiling = stoppedBy === "pages" && maxPages === THREAD_BACKFILL_MAX_PAGES;
    if (ceiling) {
      log.warn("thread_backfill_truncated", {
        accountId, resolved, threadsCreated, maxPages,
        reason: "the unthreaded backlog exceeded the absolute page ceiling — nothing is marked, " +
          "so the next pass resumes it from where the predicate now starts",
      });
    } else {
      log.info("thread_backfill_paused", {
        accountId, resolved, threadsCreated, maxPages, stoppedBy,
        reason: "the slice spent its budget — the predicate is `thread_id IS NULL`, so the next " +
          "slice resumes without a marker",
      });
    }
    return { resolved, threadsCreated, truncated };
  }

  if (resolved > 0) {
    log.info("thread_backfill_complete", { accountId, resolved, threadsCreated });
  }
  return { resolved, threadsCreated, truncated: false };
}

/** The one participant a persisted row can honestly supply. */
function participantsOf(row: ThreadBacklogRow): Array<{ name: string | null; address: string }> {
  return row.fromAddress ? [{ name: null, address: row.fromAddress.toLowerCase() }] : [];
}
