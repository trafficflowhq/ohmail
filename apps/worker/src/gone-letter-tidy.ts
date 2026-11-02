import { and, eq, exists, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import {
  fencedAccountWrite, goneEverywhereWhere, mailboxes, messageBodies, messages, messageSearch, routingDecisions,
  trackerEvents, WHOLE_BLOCK_HEADER_KEYS, type Tx,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";

/* THE GONE-LETTER TIDY — a letter that left the server takes its preview, its search document, the
 * classifier's summary, a tracker's address and its header lines but seven with its text (the
 * repo's `scrubGone`). Letters emptied before that existed still hold them, and so do letters
 * scrubbed before the header block was cut. This pass runs the same scrub over them, one account
 * at a time, bounded per run: a cleaned letter drops out of the set, so a short page means none is
 * left, and the account is not asked again in this process (a restart asks once more). New gone
 * letters never need it: they are cleaned when they are emptied. No change row, no `updated_at`,
 * no storage counter: every read a person sees already skips a tombstone. */

/** Letters one run may tidy. */
export const GONE_LETTER_TIDY_LIMIT = 500;
/** Letters per transaction. */
export const GONE_LETTER_TIDY_BATCH = 100;

export interface GoneLetterTidyOptions {
  /** Letters this run may tidy. Default {@link GONE_LETTER_TIDY_LIMIT}; a local drain takes one page. */
  limit?: number;
  /** Test seam. Default {@link GONE_LETTER_TIDY_BATCH}. */
  batch?: number;
  /** The tail's clock, asked before every page after the first. */
  until?: () => boolean;
  /** The accounts this process found clean; a run that ends on a short page adds its account. */
  done?: Set<string>;
}

export interface GoneLetterTidyResult {
  /** False: this process already found the account clean, and nothing was read. */
  ran: boolean;
  /** Letters scrubbed this run. */
  tidied: number;
  /** A short page ended the run: nothing is left to tidy. */
  done: boolean;
}

/**
 * One page of this account's letters that left the server with something still on them. No order
 * and no cursor: a tidied letter leaves the set. Gone is the store's own proof
 * (`goneEverywhereWhere`): deleted, emptied, no copy on record, not in Trash, no filing owed; a
 * mailbox being erased is the erasure's.
 */
async function leftWithWords(db: Tx, accountId: string, limit: number): Promise<string[]> {
  const d = dialect(db);
  const rows = await db.select({ id: messages.id }).from(messages)
    .innerJoin(messageBodies, eq(messageBodies.messageId, messages.id))
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(and(
      eq(messages.accountId, accountId),
      isNotNull(messages.deletedAt),
      isNotNull(messageBodies.withheldReason),
      isNull(mailboxes.erasedAt),
      goneEverywhereWhere({ messageId: messages.id, mailboxId: messages.mailboxId }),
      or(
        ne(messages.snippet, ""),
        exists(db.select({ one: sql`1` }).from(messageSearch).where(and(
          eq(messageSearch.messageId, messages.id), eq(messageSearch.accountId, accountId),
        ))),
        exists(db.select({ one: sql`1` }).from(routingDecisions).where(and(
          eq(routingDecisions.messageId, messages.id), eq(routingDecisions.accountId, accountId),
          isNotNull(routingDecisions.rationale),
        ))),
        exists(db.select({ one: sql`1` }).from(trackerEvents).where(and(
          eq(trackerEvents.messageId, messages.id), eq(trackerEvents.accountId, accountId), isNotNull(trackerEvents.url),
        ))),
        d.jsonHasAny(messageBodies.headers, WHOLE_BLOCK_HEADER_KEYS),
      ),
    ))
    .limit(limit);
  return rows.map((r) => r.id);
}

/** THE PASS, for ONE account. */
export async function goneLetterTidyPass(
  db: Tx, accountId: string, opts: GoneLetterTidyOptions = {},
): Promise<GoneLetterTidyResult> {
  if (opts.done?.has(accountId)) return { ran: false, tidied: 0, done: true };
  const limit = opts.limit ?? GONE_LETTER_TIDY_LIMIT;
  const batch = opts.batch ?? GONE_LETTER_TIDY_BATCH;
  let tidied = 0;
  let done = false;
  for (let page = 0; tidied < limit; page++) {
    if (page > 0 && opts.until?.()) break;
    const want = Math.min(batch, limit - tidied);
    // The page is read inside its fenced transaction, so a letter that came back since is not scrubbed.
    const ids = await fencedAccountWrite(db, { accountId }, async (tx) => {
      const found = await leftWithWords(tx, accountId, want);
      const repo = makeDrizzleRepo(tx as never);
      for (const id of found) await repo.scrubGone(accountId, id);
      return found;
    });
    tidied += ids.length;
    if (ids.length < want) { done = true; break; }
  }
  if (done) opts.done?.add(accountId);
  return { ran: true, tidied, done };
}
