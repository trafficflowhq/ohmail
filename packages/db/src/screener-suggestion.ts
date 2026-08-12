import { and, eq } from "drizzle-orm";
import { routingDecisions } from "./schema-mail.js";
import type { Tx } from "./change-log.js";

/**
 * WHERE A BOUGHT SCREENER SUGGESTION IS STORED — the row shape, in ONE place, for the two
 * callers that write it.
 *
 * ── WHY THIS IS A LEAF IN `db` AND NOT A METHOD ON THE SCREENER SERVICE ────────────────────
 *
 * It was a private method on `ScreenerService` while there was one writer. There are now two: the
 * user-pressed purchase (`POST /screener/suggest`, in `@trafficflow/services`) and the always-on
 * pass that buys for INCOMING held senders on an opted-in account. That second writer runs in a
 * deployment whose dependency closure is `@trafficflow/core` and `@trafficflow/db` and nothing
 * else from this workspace — a boundary enforced by what its image installs, not by convention —
 * so "both call the service method" is not available to it, and the alternative to this file is
 * the same INSERT typed out twice.
 *
 * Typed out twice is not a style complaint here. The three fields below are what a suggestion IS,
 * and every one of them is read back by somebody else:
 *
 *  · {@link SCREENER_SUGGESTION_PROVENANCE} is the WHERE clause of the read path
 *    (`ScreenerReadService.storedSuggestions`) and of the delete below. A second writer that
 *    spelled it differently would produce rows nothing ever reads — bought, charged, invisible —
 *    and the surface would go on offering to buy the same sender for ever.
 *  · {@link SCREENER_SUGGESTION_STATUS} is what keeps these rows INERT. Nothing acts on a
 *    `routing_decisions` row except by `status`, and no reader acts on this one.
 *  · the delete-then-insert is scoped to this provenance so a pipeline routing decision about the
 *    same message is never touched.
 *
 * ── AND WHY IT IS `db` RATHER THAN `core` ──────────────────────────────────────────────────
 *
 * It names a table. That is the whole test, and it is the same one `recordChange` and
 * `claimIdempotencyKey` pass on this barrel. It reaches `schema-mail.js` only, so it stays inside
 * the closure rule the barrel's header states: no `schema.js`, no Cloud journal, nothing that
 * would put the hosted schema into the desktop engine's bundle.
 */

/**
 * The `input_provenance` that MARKS a row as a bought suggestion rather than a routing decision.
 *
 * `routing_decisions` is the one table both belong in — same shape, same message, same model —
 * and this string is what tells them apart. It has no unique key behind it: there is no
 * `UNIQUE (account_id, message_id)`, which is why {@link storeScreenerSuggestion} deletes and
 * then inserts rather than upserting, and why two concurrent buys of one message can leave two
 * rows (the read path takes the newest and the ledger charges once, so the duplicate costs a row
 * and nothing else).
 */
export const SCREENER_SUGGESTION_PROVENANCE = "screener_suggestion";

/**
 * The `status` these rows carry, and the reason they are genuinely inert.
 *
 * A suggestion emits NO `approvals` row and nothing reads it as an instruction: the code that
 * performs a routing decision acts on `pending_approval` / `approved`, which no row written here
 * ever has. "AI proposes, the user decides" is that absence, not a convention anybody has to
 * remember.
 */
export const SCREENER_SUGGESTION_STATUS = "suggestion";

/** What one classifier verdict contributes to the stored row. */
export interface ScreenerSuggestionRow {
  accountId: string;
  messageId: string;
  destination: string;
  confidence: number;
  rationale: string;
  spam: boolean;
}

/**
 * Persist ONE bought suggestion, in its OWN transaction.
 *
 * The transaction is per message and not per batch, and that is a property the callers depend on
 * rather than a detail: a run of N senders is N model round trips, and a host that dies at sender
 * 40 with one pending write would lose every result the account has already paid for. Per
 * message, a death costs only the writes that had not happened yet — and the money already spent
 * buys those back for free, because the ledger source is the message.
 *
 * **No `recordChange`.** A suggestion is advice ABOUT mail, not a change TO it; emitting a
 * `change_log` row would put model output into `/sync` and make every client's delta stream carry
 * something nobody asked for.
 */
export async function storeScreenerSuggestion(db: Tx, row: ScreenerSuggestionRow): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(routingDecisions).where(and(
      eq(routingDecisions.accountId, row.accountId),
      eq(routingDecisions.messageId, row.messageId),
      eq(routingDecisions.inputProvenance, SCREENER_SUGGESTION_PROVENANCE),
    ));
    await tx.insert(routingDecisions).values({
      accountId: row.accountId,
      messageId: row.messageId,
      inputProvenance: SCREENER_SUGGESTION_PROVENANCE,
      destination: row.destination,
      confidence: row.confidence,
      rationale: row.rationale,
      spam: row.spam,
      status: SCREENER_SUGGESTION_STATUS,
    });
  });
}
