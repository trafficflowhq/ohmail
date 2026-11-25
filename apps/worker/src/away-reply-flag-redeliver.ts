import { sql } from "drizzle-orm";
import { autoReplyByUsWhere, messages, recordChanges, type AccountRelations, type Tx } from "@trafficflow/db";
import { dialect, type Dialect } from "@trafficflow/db/dialect";
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
  /** The relation the host selected for this runtime. */
  relations?: AccountRelations;
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

/** The ordered live messages whose mirrors need the away reply flag. */
export function awayReplyCandidatesSql(
  d: Dialect, accountId: string, afterId: string | null, throughView: boolean,
) {
  const account = d.castUuid(accountId);
  // On the account's view Postgres can use the sender index. The explicit account filter also
  // scopes the scan when the host reads the table directly.
  const source = throughView ? sql`ohmail.messages as messages` : sql`${messages}`;
  return sql`
    with matches as materialized (
      select ${messages.id} from ${source}
      where ${messages.accountId} = ${account}
        and ${messages.deletedAt} is null
        ${afterId === null ? sql`` : sql`and ${messages.id} > ${d.castUuid(afterId)}`}
        and ${autoReplyByUsWhere(d, {
          accountId: account,
          id: sql`${messages.id}`,
          fromAddress: sql`${messages.fromAddress}`,
          messageIdHeader: sql`${messages.messageIdHeader}`,
          indexSender: throughView ? true : undefined,
        })}
    )
    select id from matches order by id`;
}

/**
 * Re-deliver the flag for one account, once.
 *
 * Read the candidate IDs once. Each batch is its own transaction so the account's sync sequence
 * lock is released between writes. The cursor carries unfinished work past the safety bound.
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

  const d = dialect(db);
  const rows = maxPages > 0
    ? await d.exec(db, awayReplyCandidatesSql(
      d, deps.accountId, deps.afterId ?? null,
      deps.relations?.through === "views",
    ))
    : [];
  const limit = maxPages * batch;
  for (let offset = 0; offset < rows.length && offset < limit; offset += batch) {
    const ids = rows.slice(offset, offset + batch).map(([id]) => String(id));
    result.examined += ids.length;

    // ONE TRANSACTION PER PAGE, `db.transaction` directly — the sibling passes' shape. The type
    // matters and is not ceremony: `recordChanges` takes a `LedgerTx`, which makes
    // `recordChanges(db, …)` uncompilable, because the seq allocation and the rows must commit
    // together. The account's `account_sync_state` lock is held for this page and no longer.
    await db.transaction(async (tx) => {
      await recordChanges(tx, ids.map((id) => ({
        accountId: deps.accountId,
        entityType: "message" as const,
        entityId: id,
        op: "update" as const,
        // NO meta. `change_log.meta` is the folder-move shape two passes read as one
        // (`meta ->> 'to' = 'INBOX'`); this row is a re-read instruction and carries no move.
        meta: null,
      })));
    });
    result.redelivered += ids.length;
    result.cursor = ids[ids.length - 1]!;
  }
  result.exhausted = rows.length < limit;
  if (result.exhausted) result.cursor = null;

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
