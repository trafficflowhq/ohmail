import { and, asc, eq, inArray } from "drizzle-orm";
import { folderState, messages, recordChange, upsertDesiredSeen, type Tx } from "@trafficflow/db";
import { silentLogger, type Logger } from "@trafficflow/core";

/* MARKING THE SCREENED-OUT + SPAM BACKLOG READ. `decide` now marks a screen-out or spam press read in the
 * same transaction that files it (`screener-service.ts#MARK_READ_ON_DECIDE`, forward-looking); this is the
 * RETRO half for mail screened out or quarantined before that shipped. The candidate set is EXACTLY the two
 * demoting folders — `ohmail/Screened` and `ohmail/Quarantine` — and nothing else (INBOX/Reads/Receipts are
 * admitted; `ohmail/Screener` is still waiting for the user); that scoping lives in the SQL. It writes an
 * intent, never IMAP: `flag_state.desired_seen = true` (+ the `messages.unread` mirror and a `change_log`
 * update) and stops; the worker's `reconcileFlags` (`sync.ts`) adds `\Seen` under the lease. ADDITIVE and
 * REVERSIBLE (`last_set_by = 'us'`, undone by `scripts/undo-runaway-reads.mjs`). Idempotent with no marker
 * or cursor — a marked row negates the predicate and drops out, the shrinking set IS the bookmark. The
 * per-cycle budget caps how much read-state one invocation CREATEs (the `reconcileFlags` cost, as `rule-retro.ts`). */

/** The two demoting folders whose unread backlog is marked read. The safety scope — see header. */
export const READ_RETRO_FOLDERS: readonly string[] = ["ohmail/Screened", "ohmail/Quarantine"];

/**
 * Rows written per transaction. The same 100 as the other passes, and for the same reason:
 * {@link recordChange} holds the account's `account_sync_state` row lock for the transaction,
 * so a whole-backlog transaction would stall every API write for that account while it drained.
 */
export const READ_RETRO_BATCH = 100;

/**
 * Read-marks this pass may CREATE for one account in one invocation. See the header — the bound is
 * the reconciler's serial IMAP walk, not this pass. A one-off runner calls the pass repeatedly
 * until it stops reporting `capped`.
 */
export const READ_RETRO_WRITES_PER_CYCLE = 400;

/**
 * Transactions one invocation may run before giving up and saying so. A bound and not a
 * `while (true)`: a query bug that stopped shrinking the candidate set would otherwise loop against
 * the live database for ever rather than logging one line.
 */
export const READ_RETRO_MAX_PAGES = 1000;

export interface ReadRetroDeps {
  /** REQUIRED. This pass is scoped to one account — it is never run fleet-wide. */
  accountId: string;
  /**
   * OPTIONAL further narrowing to ONE mailbox of the account. The production runner passes it so a
   * run touches exactly the mailbox named on the command line and no sibling mailbox of the same
   * account — two addresses connected to one account are decided separately.
   */
  mailboxId?: string;
  log?: Logger;
  /** Test seam. Default {@link READ_RETRO_BATCH}. */
  batch?: number;
  /** Test seam. Default {@link READ_RETRO_WRITES_PER_CYCLE}. */
  writesPerCycle?: number;
  /** Test seam. Default {@link READ_RETRO_MAX_PAGES}. */
  maxPages?: number;
}

export interface ReadRetroResult {
  /** Candidate rows examined. */
  examined: number;
  /** Rows marked read (flag_state written, unread flipped, delta emitted). */
  marked: number;
  /** True ⇒ the per-cycle write budget ran out; the rest resumes on the next invocation. */
  capped: boolean;
}

/**
 * THE PASS. For ONE account: find the unread mail filed to the two demoting folders and mark it
 * read, additively, deferring the physical `\Seen` to the reconciler.
 *
 * Pure and hermetic — a db/tx handle and a logger — so a test drives it against PGlite. The
 * transactional guarantee that matters (the flag write, the unread mirror and the delta committing
 * together) is pinned on real Postgres in `read-retro.pg.test.ts`.
 */
export async function readStateRetroPass(
  db: Tx, deps: ReadRetroDeps, now: Date = new Date(),
): Promise<ReadRetroResult> {
  const log = deps.log ?? silentLogger;
  const batch = deps.batch ?? READ_RETRO_BATCH;
  const budget = deps.writesPerCycle ?? READ_RETRO_WRITES_PER_CYCLE;
  const maxPages = deps.maxPages ?? READ_RETRO_MAX_PAGES;
  const { accountId } = deps;

  const result: ReadRetroResult = { examined: 0, marked: 0, capped: false };

  for (let pages = 0; pages < maxPages; pages++) {
    if (result.marked >= budget) { result.capped = true; break; }

    const remaining = budget - result.marked;
    const limit = Math.min(batch, remaining);

    const done = await db.transaction(async (tx) => {
      // ── THE CANDIDATE SET IS THE SAFETY BOUNDARY, WRITTEN IN SQL ──────────────────────────
      //
      // Unread mail desired into exactly the two demoting folders. FOR UPDATE OF messages so two
      // drivers cannot both claim a row — the loser blocks, wakes to find it read, and it is gone
      // from the query. `of: messages` and not the join: `folder_state` is only read here.
      const rows = await tx.select({ id: messages.id })
        .from(messages)
        .innerJoin(folderState, eq(folderState.messageId, messages.id))
        .where(and(
          eq(messages.accountId, accountId),
          ...(deps.mailboxId ? [eq(messages.mailboxId, deps.mailboxId)] : []),
          eq(messages.unread, true),
          inArray(folderState.desiredFolder, [...READ_RETRO_FOLDERS]),
        ))
        .orderBy(asc(messages.id))
        .limit(limit)
        .for("update", { of: messages });

      result.examined += rows.length;
      if (rows.length === 0) return true;

      for (const row of rows) {
        // Held/demoted mail has no flag_state row at ingest, so this is the INSERT branch:
        // observed_seen = false (the candidate is unread), desired_seen = true ⇒ pending ⇒ the
        // reconciler will add \Seen. On the rare conflict, observed_seen is preserved (worker owns
        // it) and reconcile_status is recomputed in SQL against the STORED value — THE shared
        // intent writer (`@trafficflow/db` `flag-intent.ts`); this loop carried its inline twin
        // until the spelling was unified there.
        await upsertDesiredSeen(tx, row.id, false, true, now);
        // The mirror the client renders — written by us, never the reconciler. `unread = false`
        // negates the candidate predicate, which is the whole of the idempotency.
        await tx.update(messages)
          .set({ unread: false, lastReadAt: now, updatedAt: now })
          .where(eq(messages.id, row.id));
        await recordChange(tx, {
          accountId, entityType: "message", entityId: row.id, op: "update", meta: null,
        });
        result.marked++;
      }

      // END OF BACKLOG ⟺ FEWER ROWS THAN ASKED FOR. `< limit`, never `< batch`: when the budget
      // shrank `limit` below `batch`, a page that FILLED `limit` (`rows.length === limit`) is the
      // budget biting, not the end — so this returns false and the top-of-loop `marked >= budget`
      // check sets `capped` on the next turn. Using `< batch` here would read a full budget-capped
      // page as a short one and stop with mail still unread.
      return rows.length < limit;
    });

    if (done) break;
  }

  if (result.marked > 0) {
    log.info("read_retro_marked", {
      accountId, examined: result.examined, marked: result.marked, capped: result.capped,
    });
  }
  return result;
}
