import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  accounts, accountSettings, applyBodyBytesDelta, bodyBytesOf, fencedAccountWrite, messageBodies, messages,
  recordChanges, type LedgerTx, type Tx,
} from "@trafficflow/db";
import type { SQL } from "drizzle-orm";
import { dialect } from "@trafficflow/db/dialect";
/* The mail leaf, never the barrel: the local engines bundle this pass. */
import {
  HTML_WORDS_READ_MAX, searchInputsFromStore, snippetOfText, textFromHtml, upsertMessageSearchRows,
} from "@trafficflow/core/mail";

/**
 * THE HTML-WORDS BACKFILL (mail 0172) — store-only, once per account on each store. A letter whose
 * only body is html and that was stored before ingest kept its html's words has a blank text: no
 * preview, and search on a device cannot find it by its words. This gives each such row the text
 * ingest stores now, from the stored html through the same function ({@link textFromHtml}), with its
 * preview, its search document and one update delta. It never re-reads a mailbox, never re-files,
 * and leaves identity, sensitivity and every text that is not blank alone.
 *
 * In id order from a cursor in `account_settings`; the stamp is written with the last page's writes.
 * Rendering happens outside every transaction, one row at a time, with `turn()` between rows.
 */

/** Messages one hosted page reads. */
export const HTML_WORDS_SCAN_ROWS = 500;
/** Accounts one cycle tail visits, at most. */
export const HTML_WORDS_ACCOUNTS_PER_TAIL = 16;
/** Messages one round on a device reads, and the round's rendering budget there. */
export const HTML_WORDS_LOCAL_SCAN_ROWS = 200;
export const HTML_WORDS_LOCAL_BUDGET_MS = 50;
/** A stored text longer than this, in bytes, is not blank enough to read: ingest's blank is "" or "\n". */
const BLANK_TEXT_MAX_BYTES = 256;

export interface HtmlWordsBackfillOptions {
  accountId: string;
  scanRows?: number;
  maxPages?: number;
  /** True once the caller's budget is spent: the page stops before its next row. */
  until?: () => boolean;
  /** Awaited between rows, so a render never holds the event loop for more than one row. */
  turn?: () => Promise<void>;
  now?: () => Date;
  /** TEST SEAM: runs after the renders and before the page's transaction. */
  beforeWrite?: (ids: readonly string[]) => Promise<void>;
}

export interface HtmlWordsBackfillResult {
  /** False when the stamp was already written: nothing was read. */
  readonly ran: boolean;
  readonly scanned: number;
  /** Rows whose stored text was blank, with html beside it. */
  readonly blank: number;
  readonly filled: number;
  /** Blank rows whose html has no words either (pictures only); they keep "". */
  readonly wordless: number;
  /** The last page stopped on `until()`. */
  readonly cut: boolean;
  /** The stamp was written by this call. */
  readonly marked: boolean;
}

/** The accounts still owed the walk: not erased, living mail, no stamp. `shard` is a predicate over `accounts.id`. */
export async function htmlWordsOwedAccounts(db: Tx, opts: { limit: number; shard?: SQL }): Promise<string[]> {
  const rows = await db.select({ id: accounts.id }).from(accounts)
    .leftJoin(accountSettings, eq(accountSettings.accountId, accounts.id))
    .where(and(
      isNull(accounts.erasedAt),
      isNull(accountSettings.htmlWordsBackfillAt),
      sql`exists (select 1 from ${messages} where ${messages.accountId} = ${accounts.id} and ${messages.deletedAt} is null)`,
      opts.shard,
    ))
    .orderBy(accounts.id)
    .limit(opts.limit);
  return rows.map((r) => r.id);
}

interface Fill { id: string; blank: string; htmlBytes: number; words: string }

export async function htmlWordsBackfillPass(db: Tx, opts: HtmlWordsBackfillOptions): Promise<HtmlWordsBackfillResult> {
  const { accountId } = opts;
  const scanRows = opts.scanRows ?? HTML_WORDS_SCAN_ROWS;
  const maxPages = opts.maxPages ?? 1;
  const until = opts.until ?? (() => false);
  const turn = opts.turn ?? (async () => undefined);
  const now = opts.now ?? (() => new Date());
  const [state] = await db.select({ at: accountSettings.htmlWordsBackfillAt, cursor: accountSettings.htmlWordsBackfillCursor })
    .from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1);
  const r = { ran: false, scanned: 0, blank: 0, filled: 0, wordless: 0, cut: false, marked: false };
  if (state?.at != null) return r;
  r.ran = true;
  let cursor: string | null = state?.cursor ?? null;

  for (let page = 0; page < maxPages; page += 1) {
    const ids = (await db.select({ id: messages.id }).from(messages)
      .where(and(
        eq(messages.accountId, accountId), isNull(messages.deletedAt),
        ...(cursor === null ? [] : [gt(messages.id, cursor)]),
      ))
      .orderBy(asc(messages.id))
      .limit(scanRows)).map((row) => row.id);
    const bodies = ids.length === 0 ? [] : await db.select({
      id: messageBodies.messageId, text: messageBodies.text,
      htmlBytes: sql<number>`octet_length(${messageBodies.html})`.mapWith(Number),
    }).from(messageBodies)
      .where(and(
        inArray(messageBodies.messageId, ids), isNotNull(messageBodies.html), isNull(messageBodies.withheldReason),
        sql`octet_length(${messageBodies.text}) <= ${BLANK_TEXT_MAX_BYTES}`,
      ));
    const bodyOf = new Map(bodies.map((b) => [b.id, b]));

    const fills: Fill[] = [];
    let lastId: string | null = null;
    let cut = false;
    for (const id of ids) {
      // After the first row only: a clock spent on the page's reads still moves the cursor.
      if (lastId !== null && until()) { cut = true; break; }
      const body = bodyOf.get(id);
      if (body !== undefined && body.text.trim() === "") {
        r.blank += 1;
        const [stored] = await db.select({ html: sql<string | null>`substr(${messageBodies.html}, 1, ${HTML_WORDS_READ_MAX})` })
          .from(messageBodies).where(eq(messageBodies.messageId, id)).limit(1);
        const words = textFromHtml(body.text, stored?.html ?? null);
        if (words === "") r.wordless += 1;
        else fills.push({ id, blank: body.text, htmlBytes: body.htmlBytes, words });
        await turn();
      }
      lastId = id;
      r.scanned += 1;
    }
    const finished = !cut && ids.length < scanRows;
    r.cut = cut;
    if (lastId === null && !finished) break;

    await opts.beforeWrite?.(fills.map((f) => f.id));
    const at = now();
    const filled = await fencedAccountWrite(db, { accountId }, async (tx) => {
      // Settings first: the order every settings writer holds before the change sequence.
      await tx.insert(accountSettings).values({
        accountId, htmlWordsBackfillCursor: finished ? null : lastId, htmlWordsBackfillAt: finished ? at : null,
      }).onConflictDoUpdate({
        target: accountSettings.accountId,
        set: (finished ? {
          htmlWordsBackfillCursor: null,
          htmlWordsBackfillAt: sql`coalesce(${accountSettings.htmlWordsBackfillAt}, excluded.html_words_backfill_at)`,
        } : {
          // Forward only: a walk behind another one never moves the cursor back.
          htmlWordsBackfillCursor: sql`case
            when ${accountSettings.htmlWordsBackfillCursor} is null or ${accountSettings.htmlWordsBackfillCursor} < ${lastId}
            then ${lastId} else ${accountSettings.htmlWordsBackfillCursor} end`,
        }) as never,
      });
      const written: Fill[] = [];
      for (const f of fills) {
        // Only the blank text read, beside the same html, never withheld since: nothing else is overwritten.
        const hit = await tx.update(messageBodies).set({ text: f.words })
          .where(and(
            eq(messageBodies.messageId, f.id), eq(messageBodies.text, f.blank), isNull(messageBodies.withheldReason),
            sql`octet_length(${messageBodies.html}) = ${f.htmlBytes}`,
            // Correlated to this row: an IN over the account's letters is rebuilt per fill on SQLite.
            sql`exists (select 1 from ${messages} where ${messages.id} = ${messageBodies.messageId}
              and ${messages.accountId} = ${accountId} and ${messages.deletedAt} is null)`,
          ))
          .returning({ id: messageBodies.messageId });
        if (hit.length > 0) written.push(f);
      }
      if (written.length === 0) return 0;
      await applyBodyBytesDelta(tx, dialect(db), accountId, written.reduce(
        (sum, f) => sum + bodyBytesOf({ text: f.words, html: null }) - bodyBytesOf({ text: f.blank, html: null }), 0));
      for (const f of written) {
        await tx.update(messages).set({ snippet: snippetOfText(f.words), updatedAt: at })
          .where(and(eq(messages.id, f.id), eq(messages.accountId, accountId)));
      }
      const writtenIds = written.map((f) => f.id);
      await upsertMessageSearchRows(tx, await searchInputsFromStore(tx, accountId, writtenIds), at);
      await recordChanges(tx as LedgerTx, writtenIds.map((id) => ({
        accountId, entityType: "message" as const, entityId: id, op: "update" as const, meta: null,
      })));
      return written.length;
    });
    r.filled += filled;
    if (finished) { r.marked = true; break; }
    if (cut) break;
    cursor = lastId;
  }
  return r;
}
