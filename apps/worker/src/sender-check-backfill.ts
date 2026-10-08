import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  contacts, fencedAccountWrite, folderState, messages, SCREENER_ACT_TRIGGER_PREFIX, type Tx,
} from "@trafficflow/db";
/* The mail leaf, never the barrel: the local engines bundle this pass, and a value import from the
   barrel carries the model half into them (the engine census refuses the build). */
import { silentLogger, type Logger } from "@trafficflow/core/mail";
import { writeSenderChecks } from "@trafficflow/core/adapters/drizzle-repo";
// The one write, re-exported for the passes that import it from here (the act, the gate release, the retro).
export { writeSenderChecks, type UncheckedRow } from "@trafficflow/core/adapters/drizzle-repo";

/**
 * THE IDENTITY BACKFILL (mail 0148) — the identity fact for the rows ingested before the column
 * existed, written once. Only the two places a sentence is read at the moment of a decision: the
 * Ohbox and the Screener — inbound mail by construction, so Sent copies (which ingest checks
 * without computing) are out of scope. Per row the fact function, exactly what ingest writes. It
 * writes the fact and, for a marked row only, a `message` update so every mirror repaints it —
 * never a move: already-placed mail stays where it is.
 * Idempotent by construction: the NULL set is the cursor, so a second run writes nothing.
 */

/** Rows per page — one transaction each. */
export const SENDER_CHECK_BACKFILL_BATCH = 500;
/** Pages per call: one, so a cycle tail pays one page and a 20k-row scope takes ~40 cycles. */
export const SENDER_CHECK_BACKFILL_PAGES = 1;

export interface SenderCheckBackfillDeps {
  accountId: string;
  batch?: number;
  maxPages?: number;
  /** The caller's clock, asked before every page after the first; true stops the walk. */
  until?: () => boolean;
  log?: Logger;
}

export interface SenderCheckBackfillResult {
  /** Rows given a fact. */
  checked: number;
  /** Of those, rows the fact marks — each with one `message` update delta. */
  marked: number;
  /** True ⇒ the NULL set in scope answered empty: nothing is left to check. */
  done: boolean;
}

/** The two places a banner is read when a person decides. Archive and Sent rows stay unchecked. */
const IN_SCOPE = ["INBOX", "ohmail/Screener"] as const;

/** Contacts one call examines for {@link markLegacyActContacts}. */
export const LEGACY_ACT_CONTACTS_BATCH = 5000;

/**
 * THE ACT'S CONTACTS FROM BEFORE THE COLUMN (mail 0148): a contact the act on suggestions wrote
 * before `contacts.source` existed is NULL, which reads as a person's. Every NULL row the pass
 * examines is written in one statement: inferred where each Screener decision on record came from
 * the act (`screener:auto:`), person — the reading NULL already had — otherwise. No contact is
 * read twice, so a call costs what is new. Bounded per call, logged; it moves no mail.
 */
export async function markLegacyActContacts(
  db: Tx, deps: { accountId: string; batch?: number },
): Promise<number> {
  // A literal, not a parameter: the sidecar names this statement, and a generic plan over a bound
  // pattern loses the (account, trigger) index its custom plan uses.
  const act = sql.raw(`'${SCREENER_ACT_TRIGGER_PREFIX.replace(/'/g, "''")}%'`);
  return fencedAccountWrite(db, { accountId: deps.accountId }, async (tx) => {
    const ids = (await tx.select({ id: contacts.id }).from(contacts)
      .where(and(eq(contacts.accountId, deps.accountId), isNull(contacts.source)))
      .limit(deps.batch ?? LEGACY_ACT_CONTACTS_BATCH)).map((r) => r.id);
    if (ids.length === 0) return 0;
    // The senders whose every Screener decision came from the act, read once for the statement.
    const actOnly = sql`select lower(ls.sender_address) from learning_signals ls
       where ls.account_id = ${deps.accountId} and ls.kind = 'screener' and ls.sender_address is not null
       group by lower(ls.sender_address)
      having min(case when ls.triggering_action_id like ${act} then 1 else 0 end) = 1`;
    await tx.update(contacts)
      .set({ source: sql`case when lower(${contacts.address}) in (${actOnly}) then 'inferred' else 'person' end` })
      .where(and(eq(contacts.accountId, deps.accountId), inArray(contacts.id, ids), isNull(contacts.source)));
    const [n] = await tx.select({ n: sql<number>`count(*)` }).from(contacts)
      .where(and(eq(contacts.accountId, deps.accountId), inArray(contacts.id, ids), eq(contacts.source, "inferred")));
    return Number(n?.n ?? 0);
  });
}

export async function senderCheckBackfillPass(
  db: Tx, deps: SenderCheckBackfillDeps,
): Promise<SenderCheckBackfillResult> {
  const log = deps.log ?? silentLogger;
  const batch = deps.batch ?? SENDER_CHECK_BACKFILL_BATCH;
  const maxPages = deps.maxPages ?? SENDER_CHECK_BACKFILL_PAGES;
  const result: SenderCheckBackfillResult = { checked: 0, marked: 0, done: false };

  for (let page = 0; page < maxPages; page++) {
    if (page > 0 && deps.until?.()) break;
    const n = await fencedAccountWrite(db, { accountId: deps.accountId }, async (tx) => {
      // Newest first: the mail a person is about to read gets its sentence before the backlog.
      const rows = await tx.select({
        id: messages.id, fromName: messages.fromName, fromAddress: messages.fromAddress,
        subject: messages.subject,
      }).from(messages)
        .innerJoin(folderState, eq(folderState.messageId, messages.id))
        .where(and(
          eq(messages.accountId, deps.accountId),
          isNull(messages.senderCheck),
          isNull(messages.deletedAt),
          inArray(folderState.desiredFolder, [...IN_SCOPE]),
        ))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(batch);
      if (rows.length === 0) return { rows: 0, marked: 0 };
      const marked = await writeSenderChecks(tx, deps.accountId, rows);
      return { rows: rows.length, marked: marked.length };
    });
    result.checked += n.rows;
    result.marked += n.marked;
    if (n.rows < batch) { result.done = true; break; }
  }

  if (result.checked > 0) {
    // The logger's own field names: `scanned` is the rows given a fact this call.
    log.info("sender_check_backfill", { accountId: deps.accountId, scanned: result.checked, marked: result.marked });
  }
  const inferred = await markLegacyActContacts(db, { accountId: deps.accountId });
  if (inferred > 0) log.info("act_contacts_inferred", { accountId: deps.accountId, count: inferred });
  return result;
}
