import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { autoReplyByUsWhere, messages, recordChanges, type Tx } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { silentLogger, type Logger } from "@trafficflow/core/mail";

/**
 * THE ONE-TIME RE-DELIVERY OF `MessageDTO.autoReplyByUs`. The flag is computed at MATERIALIZE time and a
 * client only re-materializes a message when a `change_log` row for it arrives, so it reaches mail written
 * AFTER it shipped and none before — and the replies that need it are all in the second group. Without
 * this pass the fix is invisible on a warm mirror (the client reads `undefined` as "the person's" and the
 * replies stay in "Earlier"), a reliability feature rendering as its own healthy state. Server-side, not
 * a client one-shot, because of deploy order (API → worker → web, the worker second), reach (every client
 * repaired by the same rows) and cost (no new durable client state). It RUNS TO EXHAUSTION (an earlier
 * page budget re-sent the first thousand every start and the rest never); {@link AWAY_REPLY_REDELIVER_MAX_PAGES}
 * is a SAFETY BOUND, not a budget, and {@link makeAwayReplySweep} closes its gate only when every account is `exhausted`. Once per worker process, no durable marker (candidate set `autoReplyByUsWhere`); a REPAIR, deletable once rolled out. Writes only `change_log`; deleted rows excluded. */

/** One page. Small on purpose: the whole candidate set is one account's responder replies. */
export const AWAY_REPLY_REDELIVER_BATCH = 200;
/**
 * A SAFETY BOUND, NOT A BUDGET — one million rows at the default page size.
 *
 * The walk is meant to reach the end of the candidate set; this exists only so that a bug in the
 * cursor cannot spin a worker cycle for ever. Reaching it is reported (`exhausted: false`) and the
 * caller resumes from the returned cursor, so even the pathological case makes progress rather
 * than repeating its first page — which is exactly what the old five-page budget did.
 */
export const AWAY_REPLY_REDELIVER_MAX_PAGES = 5_000;

export interface AwayReplyRedeliverDeps {
  /** Scope to ONE account — the worker loops its served accounts. */
  accountId: string;
  log?: Logger;
  /** Test seam. Default {@link AWAY_REPLY_REDELIVER_BATCH}. */
  batch?: number;
  /** Test seam. Default {@link AWAY_REPLY_REDELIVER_MAX_PAGES}. */
  maxPages?: number;
  /** Resume point from a previous run that did not exhaust the set. `null` starts at the top. */
  afterId?: string | null;
}

export interface AwayReplyRedeliverResult {
  /** Candidates seen. */
  examined: number;
  /** `change_log` rows written — the number of mirrors' rows that will be refreshed. */
  redelivered: number;
  /**
   * TRUE ⇒ the walk reached the END of the candidate set for this account.
   *
   * The gate that stops the sweep repeating reads THIS and nothing else, so an account whose walk
   * was cut short keeps the sweep open instead of being silently abandoned.
   */
  exhausted: boolean;
  /** Where to resume when `exhausted` is false. Null when there is nothing left to do. */
  cursor: string | null;
}

/**
 * Re-deliver the flag for one account, once.
 *
 * Each page is its own transaction, so a long walk never holds the account's seq counter — the
 * lock `recordChanges` takes is released per page. The walk carries an ID CURSOR and must: the
 * candidate predicate is the rows' own state and this pass does not change that state, so a page
 * it has emitted for still matches and a re-reading walk would loop on page one for ever. Ordering
 * by `id` with `id > afterId` is what makes it terminate.
 */
export async function awayReplyFlagRedeliverPass(
  db: Tx, deps: AwayReplyRedeliverDeps,
): Promise<AwayReplyRedeliverResult> {
  const log = deps.log ?? silentLogger;
  const batch = deps.batch ?? AWAY_REPLY_REDELIVER_BATCH;
  const maxPages = deps.maxPages ?? AWAY_REPLY_REDELIVER_MAX_PAGES;
  const result: AwayReplyRedeliverResult = {
    examined: 0, redelivered: 0, exhausted: false, cursor: null,
  };

  let afterId: string | null = deps.afterId ?? null;
  for (let page = 0; page < maxPages; page++) {
    const rows = await db.select({ id: messages.id })
      .from(messages)
      .where(and(
        eq(messages.accountId, deps.accountId),
        // A TOMBSTONED ROW IS NEVER RE-DELIVERED. `materializeMessages` omits it and `/sync`
        // turns that absence into a tombstone, so an update change for one would ask every
        // mirror to re-tombstone mail it has already discarded.
        isNull(messages.deletedAt),
        autoReplyByUsWhere(dialect(db), {
          accountId: sql`${messages.accountId}`,
          id: sql`${messages.id}`,
          fromAddress: sql`${messages.fromAddress}`,
          messageIdHeader: sql`${messages.messageIdHeader}`,
        }),
        ...(afterId === null ? [] : [gt(messages.id, sql`${afterId}::uuid`)]),
      ))
      .orderBy(asc(messages.id))
      .limit(batch);

    // `break`, never `return`: an early return here would skip the log line below, and a
    // pass that ran silently is indistinguishable from one that never did.
    if (rows.length === 0) { result.exhausted = true; break; }
    result.examined += rows.length;

    // ONE TRANSACTION PER PAGE, `db.transaction` directly — the sibling passes' shape. The type
    // matters and is not ceremony: `recordChanges` takes a `LedgerTx`, which makes
    // `recordChanges(db, …)` uncompilable, because the seq allocation and the rows must commit
    // together. The account's `account_sync_state` lock is held for this page and no longer.
    await db.transaction(async (tx) => {
      await recordChanges(tx, rows.map((r) => ({
        accountId: deps.accountId,
        entityType: "message" as const,
        entityId: r.id,
        op: "update" as const,
        // NO meta. `change_log.meta` is the folder-move shape two passes read as one
        // (`meta ->> 'to' = 'INBOX'`); this row is a re-read instruction and carries no move.
        meta: null,
      })));
    });
    result.redelivered += rows.length;
    afterId = rows[rows.length - 1]!.id;

    // A SHORT PAGE IS THE END OF THE SET — `limit batch` returned fewer than it could, so there is
    // nothing after it. This is the ordinary exit.
    if (rows.length < batch) { result.exhausted = true; break; }
    // Falling out of the loop instead means the safety bound was reached: not exhausted, and the
    // cursor goes back to the caller so the next attempt continues from here.
    if (page === maxPages - 1) result.cursor = afterId;
  }

  if (result.redelivered > 0 || !result.exhausted) {
    /**
     * `marked`, not `redelivered`, and the difference is not cosmetic: `log.ts#ALLOWED_FIELDS` is
     * an ALLOWLIST that DROPS an unregistered key rather than failing, so a field named
     * `redelivered` would vanish from the line with nothing to show it had — the same
     * looks-healthy failure this whole lane is about. `marked` is already registered and says the
     * true thing (these rows are marked for re-delivery). Widening the allowlist is the sanctioned
     * alternative, one reviewed name at a time; it is not worth a `packages/core` edit in a hotfix
     * for a counter an existing name already carries.
     */
    log.info("away_reply_flag_redelivered", {
      accountId: deps.accountId,
      examined: result.examined, marked: result.redelivered, capped: !result.exhausted,
    });
  }
  return result;
}
