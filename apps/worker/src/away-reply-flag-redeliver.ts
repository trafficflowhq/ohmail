import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { autoReplyByUsWhere, messages, recordChanges, type Tx } from "@trafficflow/db";
import { silentLogger, type Logger } from "@trafficflow/core/mail";

/**
 * ═══ THE ONE-TIME RE-DELIVERY OF `MessageDTO.autoReplyByUs` ══════════════════════════════════
 *
 * `autoReplyByUs` is computed at MATERIALIZE time, and a client only re-materializes a message
 * when a `change_log` row for it arrives (`SyncService.getChanges` re-materializes the CURRENT DTO
 * per change row). So the flag reaches every message written AFTER it shipped, and reaches NO
 * message written before it — and the replies that need it are all in the second group by
 * definition, because they are the ones already sitting in somebody's Ohbox.
 *
 * Without this pass the fix is invisible on a warm mirror: the client half filters on a field its
 * stored rows do not carry, `undefined` is read as "the person's" (correctly — see
 * `EngineMessage.autoReplyByUs`), and the replies stay in "Earlier" for ever. Nothing errors, the
 * suites are green, and the reported bug survives its own fix. That was found by review as a HIGH,
 * and it is the shape this repo keeps meeting: a reliability feature rendering as its own healthy
 * state.
 *
 * ── WHY A SERVER-SIDE RE-DELIVERY AND NOT A CLIENT ONE-SHOT ─────────────────────────────────
 *
 * The alternative considered was a client-side repair: on first sight of the flag, re-fetch every
 * own-sent row once and record that it happened in the mirror's own meta. It was rejected on three
 * counts, in order of weight:
 *
 *   1. WHEN IT ARRIVES. The deploy order is worker → API → web. A server-side re-delivery repairs
 *      the mailbox on the FIRST worker cycle, before the API or the web ships anything; a client
 *      repair cannot run until the new engine reaches the device, which for the desktop is a
 *      release away.
 *   2. WHO IT REPAIRS. This is server-only code, so every client — the web now, the desktop and
 *      the phone whenever they next sync — is repaired by the same rows with no client change and
 *      no capability negotiation. A client one-shot has to be written, shipped and gated once per
 *      surface.
 *   3. WHAT IT COSTS TO GET WRONG. A client repair needs new durable client state ("I have done
 *      this"), and a mirror that loses it repeats the re-fetch; a mirror that records it too early
 *      never repairs at all. This pass carries no new state of its own — see below.
 *
 * It is also the smaller change: no protocol, no new route, no migration. The only thing it writes
 * is one `change_log` row per affected message, on a path the product already uses for "this
 * entity changed, fetch it again".
 *
 * ── WHY IT RUNS ONCE PER WORKER PROCESS AND CARRIES NO DURABLE MARKER ───────────────────────
 *
 * Two shapes were tried before this one and both are worth recording, because the second LOOKED
 * right and was not.
 *
 * A marker column is a migration, and a marker inside `change_log.meta` means widening a shared
 * type whose one shape (`{from, to}`) two passes read as a folder move. Neither is a price a
 * hosted repair should pay.
 *
 * So the second attempt made the condition "has this row been re-delivered since it was last
 * written" — no `change_log` row with `created_at > messages.updated_at`. That is WRONG, and the
 * warm-mirror control is what caught it: a change row proves the client was sent the DTO AS IT WAS
 * AT THE TIME, and every row this pass exists for was last sent BEFORE the flag existed. The
 * condition would have skipped exactly the population it was written to repair — and it would have
 * skipped it silently, with the pass reporting a tidy zero.
 *
 * A correct durable condition therefore has to reference the DEPLOY rather than the row's own
 * history, and the only such value available without a migration is a timestamp hardcoded in the
 * source. Erring early leaves mailboxes unrepaired; erring late makes the pass re-emit on every
 * cycle until the clock passes it. Both are worse than the honest alternative:
 *
 *   THE SWEEP RUNS ONCE PER WORKER PROCESS. The cycle's gate (`index.ts`) closes after one
 *   successful sweep, so a deploy repairs every account once and then never looks again until the
 *   next restart.
 *
 * What that costs is one repeat per restart, and the size of the repeat is the whole point: the
 * candidate set is `autoReplyByUsWhere` — replies the away responder actually sent — which is tens
 * of rows per mailbox at the very most. A client absorbs them as an ordinary re-fetch of rows it
 * already holds. That is a bounded, visible cost, where a mis-set cutoff is an unbounded and
 * INVISIBLE one.
 *
 * It follows that this pass is a REPAIR and not a feature: once a release carrying the flag has
 * rolled out to every client, it can be deleted outright. Nothing else depends on it.
 *
 * The candidate set is `autoReplyByUsWhere` — the same fragment the tidy, the retro and the DTO
 * batch apply, so this pass can never disagree with the flag it exists to deliver.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────────────────────
 *
 * It writes NOTHING to `messages` and nothing to `folder_state`. It does not move a message, it
 * does not touch the reply, and it does not touch the message that was answered. A `change_log`
 * row is a re-read instruction, not a change of state — which is why the control for this pass
 * asserts the mirror row leaves "Earlier" with NO message change and no manual action.
 *
 * Deleted rows are excluded: `materializeMessages` omits them and `/sync` turns that absence into
 * a tombstone, so emitting an update for a tombstoned message would ask every mirror to
 * re-tombstone mail it has already discarded.
 */

/** One page. Small on purpose: the whole candidate set is one account's responder replies. */
export const AWAY_REPLY_REDELIVER_BATCH = 200;
/** Pages per run, so a pathological account cannot hold the cycle. */
export const AWAY_REPLY_REDELIVER_MAX_PAGES = 5;

export interface AwayReplyRedeliverDeps {
  /** Scope to ONE account — the worker loops its served accounts. */
  accountId: string;
  log?: Logger;
  /** Test seam. Default {@link AWAY_REPLY_REDELIVER_BATCH}. */
  batch?: number;
  /** Test seam. Default {@link AWAY_REPLY_REDELIVER_MAX_PAGES}. */
  maxPages?: number;
}

export interface AwayReplyRedeliverResult {
  /** Candidates seen. */
  examined: number;
  /** `change_log` rows written — the number of mirrors' rows that will be refreshed. */
  redelivered: number;
  /** The page budget ended the walk rather than the candidate set. */
  capped: boolean;
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
  const result: AwayReplyRedeliverResult = { examined: 0, redelivered: 0, capped: false };

  let afterId: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const rows = await db.select({ id: messages.id })
      .from(messages)
      .where(and(
        eq(messages.accountId, deps.accountId),
        // A TOMBSTONED ROW IS NEVER RE-DELIVERED. `materializeMessages` omits it and `/sync`
        // turns that absence into a tombstone, so an update change for one would ask every
        // mirror to re-tombstone mail it has already discarded.
        isNull(messages.deletedAt),
        autoReplyByUsWhere({
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
    if (rows.length === 0) break;
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

    if (rows.length < batch) break;
    if (page === maxPages - 1) result.capped = true;
  }

  if (result.redelivered > 0 || result.capped) {
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
      examined: result.examined, marked: result.redelivered, capped: result.capped,
    });
  }
  return result;
}
