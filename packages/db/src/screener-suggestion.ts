import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { messages, routingDecisions } from "./schema-mail.js";
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

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE SENDER IDENTITY OF A SUGGESTION — asked in ONE place, because three callers need it
   ══════════════════════════════════════════════════════════════════════════════════════════

   ── WHY THE ROW IS PER MESSAGE AND THE QUESTION IS PER SENDER ───────────────────────────────

   A suggestion is stored against a MESSAGE — `routing_decisions.message_id` is the only key the
   table has — and it is ABOUT A SENDER: the question bought is "does this sender belong in this
   person's Ohbox", the verdict is applied to the sender's whole held bag, and the surface draws one
   row per sender. Those two facts sat unreconciled and one of them was load-bearing for money.

   The Screener picks a REPRESENTATIVE per sender (their newest held message) and every layer keyed
   off it: the ledger source, the stored-suggestion skip, the surface's "already answered". So a
   sender who simply SENT AGAIN promoted a new representative that carried no suggestion row, was
   admitted by every skip, and was bought a second time — once per message, on a path with no press
   anywhere in it. The bound the automatic path advertised ("one model call per NEW held sender,
   ever") was really "one per message", and the party choosing how many messages there are is the
   sender.

   So the identity below is `lower(from_address)` — the same normalisation `heldSenderPage`,
   `heldRowsForSender` and `core/rules.ts#matches` use, and the one
   `messages_account_from_addr_idx` is built on. `account_id` LEADS every predicate here: a sender
   address is attacker-choosable, so it is never a filter applied to a cross-account result.

   ── AND WHY THE LEDGER SOURCE DID NOT MOVE ──────────────────────────────────────────────────

   The obvious fix is to re-key `screenerLedgerSource` on the sender. It is the wrong one, for two
   reasons that only appear when you write it out — both recorded at
   {@link ../src/ledger-source.ts screenerLedgerSource}. In short: a ledger `source` is APPEND-ONLY
   and a normalised address is remote-controlled and guessable, so it would build the confirmation
   oracle `classifyLedgerSource` destroyed its plaintexts to close; and one source shared by the
   cron and the button is what makes SEC3-MONEY-1's claim serialise them, which two namespaces
   would undo (two credits and two model calls for one sender, seen once).

   The entitlement lives here instead: a QUERY over rows we already hold, which cannot leak an
   identifier because it writes nothing. */

/**
 * DOES THIS ACCOUNT ALREADY HOLD SCREENER ADVICE ABOUT THIS SENDER? — as an `EXISTS` fragment, for
 * a candidate query that must answer it per row without a second round trip.
 *
 * `senderExpr` must be an ALREADY-LOWERED sql expression naming the sender of the row being tested
 * (`sql`lower(${reps.fromAddress})``). It is a parameter rather than a column because the callers
 * test a subquery's projection, not a table's.
 *
 * The subquery walks from the SENDER to their messages to those messages' suggestions, in that
 * order, so it is served by `messages_account_from_addr_idx` and then
 * `routing_decisions_account_message_idx` — bounded by how much mail that one sender has sent, not
 * by how many routing decisions the account has accumulated. Written the other way round (all of
 * the account's suggestion rows, joined back to `messages`) it is a scan of the account.
 */
export function screenerSuggestedSenderExists(accountId: string, senderExpr: SQL): SQL<boolean> {
  return sql<boolean>`exists (
    select 1
      from ${messages} sm
      join ${routingDecisions} rd
        on rd.message_id = sm.id
       and rd.account_id = ${accountId}::uuid
       and rd.input_provenance = ${SCREENER_SUGGESTION_PROVENANCE}
     where sm.account_id = ${accountId}::uuid
       and lower(sm.from_address) = ${senderExpr}
  )`;
}

/** One sender's most recent stored verdict, and which of their messages it was bought about. */
export interface StoredSenderSuggestion {
  /** The message the verdict was generated from — NOT necessarily the sender's current representative. */
  messageId: string;
  destination: string;
  confidence: number | null;
  rationale: string | null;
  spam: boolean;
}

/**
 * THE NEWEST STORED VERDICT PER SENDER, for a bounded set of senders.
 *
 * One query for the whole set and none for an empty one. `DISTINCT ON (lower(from_address))` with
 * `ORDER BY … rd.created_at DESC, rd.id DESC` is what makes "newest wins" a property of the
 * database rather than of a loop — and there genuinely can be several rows per sender: one per
 * message they have been advised about (see {@link SCREENER_SUGGESTION_PROVENANCE} for why two
 * concurrent buys of ONE message can also leave two).
 *
 * `senders` must already be lower-cased; the map is keyed the same way.
 */
export async function screenerSuggestionsBySender(
  db: Tx, accountId: string, senders: string[],
): Promise<Map<string, StoredSenderSuggestion>> {
  const out = new Map<string, StoredSenderSuggestion>();
  if (senders.length === 0) return out;

  const sender = sql<string>`lower(${messages.fromAddress})`;
  const rows = await db.selectDistinctOn([sender], {
    sender: sender.as("sender"),
    messageId: routingDecisions.messageId,
    destination: routingDecisions.destination,
    confidence: routingDecisions.confidence,
    rationale: routingDecisions.rationale,
    spam: routingDecisions.spam,
  }).from(routingDecisions)
    .innerJoin(messages, and(
      eq(messages.id, routingDecisions.messageId),
      // `account_id` on BOTH sides of the join, so the sender identity is resolved inside this
      // account even if a `routing_decisions` row ever named a message that is not its own.
      eq(messages.accountId, accountId),
    ))
    .where(and(
      eq(routingDecisions.accountId, accountId),
      eq(routingDecisions.inputProvenance, SCREENER_SUGGESTION_PROVENANCE),
      inArray(sender, senders),
    ))
    .orderBy(sender, desc(routingDecisions.createdAt), desc(routingDecisions.id));

  for (const r of rows) {
    out.set(r.sender, {
      messageId: r.messageId,
      destination: r.destination,
      confidence: r.confidence,
      rationale: r.rationale,
      spam: r.spam,
    });
  }
  return out;
}

/**
 * Does this account hold advice about ONE sender? {@link screenerSuggestionsBySender} for a set of
 * one, so the identity rule has exactly one implementation.
 *
 * `sender` must already be lower-cased.
 */
export async function hasScreenerSuggestionForSender(
  db: Tx, accountId: string, sender: string,
): Promise<boolean> {
  return (await screenerSuggestionsBySender(db, accountId, [sender])).size > 0;
}
