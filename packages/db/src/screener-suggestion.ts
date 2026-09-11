import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { messages, routingDecisions } from "./schema-mail.js";
import type { Tx } from "./change-log.js";
import type { Dialect } from "./dialect/index.js";

/**
 * Where a bought Screener suggestion is stored — the row shape, in ONE place, for the two callers
 * that write it. The always-on pass runs in a deployment whose closure is core + db only, so the
 * alternative to this file is the same INSERT typed twice — and {@link
 * SCREENER_SUGGESTION_PROVENANCE} is the WHERE clause of the read path and the delete: a second
 * writer spelling it differently would produce rows nothing reads (bought, charged, invisible).
 * {@link SCREENER_SUGGESTION_STATUS} keeps these rows INERT; the delete-then-insert is scoped to
 * this provenance so a pipeline routing decision is never touched. In `db` because it names a
 * table; it reaches `schema-mail.js` only.
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
 * Persist ONE bought suggestion, in its OWN transaction — per message, not per batch, and the
 * callers depend on that: a run of N senders is N model round trips, and a host that dies at
 * sender 40 with one pending write would lose every result the account already paid for. Per
 * message, a death costs only the writes that had not happened yet — and the money already spent
 * buys those back for free, because the ledger source is the message. No `recordChange`: a
 * suggestion is advice ABOUT mail, not a change TO it; a `change_log` row would put model output
 * into `/sync` and make every client's delta stream carry something nobody asked for.
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

/**
 * The sender identity of a suggestion — asked in ONE place for three callers. A suggestion is
 * stored against a MESSAGE and is ABOUT A SENDER: every layer keyed off the per-sender
 * representative, so a sender who simply SENT AGAIN was bought again — once per message, the
 * sender choosing how many. The identity is `lower(from_address)`; `account_id` LEADS every
 * predicate. The ledger source did NOT move to the sender: an append-only `source` with a
 * guessable identifier would rebuild the oracle `classifyLedgerSource` destroyed its plaintexts
 * to close, and one shared source serialises the cron and the button. The entitlement is a QUERY
 * over rows we already hold — it writes nothing and cannot leak.
 */

/**
 * Does this account already hold Screener advice about this sender? — as an `EXISTS` fragment,
 * for a candidate query that must answer it per row without a second round trip. `senderExpr`
 * must be an ALREADY-LOWERED sql expression naming the sender of the row being tested; a
 * parameter rather than a column because the callers test a subquery's projection, not a table's.
 * The subquery walks from the SENDER to their messages to those messages' suggestions, in that
 * order, so it is served by `messages_account_from_addr_idx` and then the routing-decisions index
 * — bounded by how much mail that one sender has sent, not by how many routing decisions the
 * account has accumulated. Written the other way round it is a scan of the account.
 */
export function screenerSuggestedSenderExists(
  d: Dialect, accountId: string, senderExpr: SQL,
): SQL<boolean> {
  // The id is cast through the seam: the server needs the type to pick the index, and the device
  // store has no such type at all — its ids are text and a server cast is a syntax error there.
  const account = d.castUuid(accountId);
  return sql<boolean>`exists (
    select 1
      from ${messages} sm
      join ${routingDecisions} rd
        on rd.message_id = sm.id
       and rd.account_id = ${account}
       and rd.input_provenance = ${SCREENER_SUGGESTION_PROVENANCE}
     where sm.account_id = ${account}
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
 * The newest stored verdict per sender, for a bounded set of senders. One query for the whole set
 * and none for an empty one. A ranked window with `ORDER BY … created_at DESC, id DESC` makes
 * "newest wins" a property of the database rather than of a loop — and there genuinely can be
 * several rows per sender: one per message they have been advised about (see {@link
 * SCREENER_SUGGESTION_PROVENANCE} for why two concurrent buys of ONE message can also leave two).
 * `senders` must already be lower-cased; the map is keyed the same way.
 */
export async function screenerSuggestionsBySender(
  db: Tx, accountId: string, senders: string[],
): Promise<Map<string, StoredSenderSuggestion>> {
  const out = new Map<string, StoredSenderSuggestion>();
  if (senders.length === 0) return out;

  const sender = sql<string>`lower(${messages.fromAddress})`;
  // One row per sender, as a WINDOW rather than `DISTINCT ON`: `distinct on (k) … order by k, o`
  // and `row_number() over (partition by k order by o) = 1` pick the same row — the first in `o`
  // within each `k`. The first spelling exists only on the server; the second is standard and
  // both stores have it, so this is one statement rather than a branch, which is what a seam is
  // for when the answer really is shared. The ordering moves INSIDE the window, where it belongs
  // — under `distinct on` the leading `k` in the ORDER BY was there to satisfy the clause rather
  // than to order the result, the detail that makes the two look different when they are not.
  const ranked = db.select({
    sender: sender.as("sender"),
    messageId: routingDecisions.messageId,
    destination: routingDecisions.destination,
    confidence: routingDecisions.confidence,
    rationale: routingDecisions.rationale,
    spam: routingDecisions.spam,
    rank: sql<number>`row_number() over (
      partition by ${sender}
      order by ${routingDecisions.createdAt} desc, ${routingDecisions.id} desc
    )`.as("rank"),
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
    .as("ranked");

  const rows = await db.select({
    sender: ranked.sender,
    messageId: ranked.messageId,
    destination: ranked.destination,
    confidence: ranked.confidence,
    rationale: ranked.rationale,
    spam: ranked.spam,
  }).from(ranked).where(eq(ranked.rank, 1));

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
