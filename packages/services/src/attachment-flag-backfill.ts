import { and, asc, eq, gt, sql } from "drizzle-orm";
import { messages, attachments, auditLog, recordChange, type Tx } from "@trafficflow/db";
import type { SQL } from "drizzle-orm";
import { silentLogger, type Logger } from "@trafficflow/core";
import type { Db } from "./context.js";

/**
 * The paperclip that opens an empty strip — no migration. `mime.ts` once counted every MIME part
 * while `attachments-service.ts` selects files with `inline = false`: two definitions of "a
 * file", and over forty percent of measured paperclipped mail held nothing to download while not
 * one unflagged message held a real file — the flag only over-reports, so this pass cannot invent
 * a paperclip. One `change_log` update per corrected row reaches every client mirror. No marker
 * column: {@link selectCandidates} selects exactly the rows whose stored pair disagrees — the set
 * drains, a second run writes nothing. It does NOT skip acted-on mail: no user action writes
 * these columns; each corrected row's `audit_log` `inverse` carries the prior pair.
 */

/**
 * How many downloadable parts this message has — `inline = false`, the same predicate
 * `attachments-service.ts` selects the Files list with. `${messages}.${sql.identifier(...)}` and
 * NOT `${messages.id}`: drizzle emits a bare column interpolation UNQUALIFIED, and `attachments`
 * has its own `id`, so the correlation silently becomes `att.message_id = att.id` — never true,
 * count 0 for every message. That is what this returned on its first run — the worst failure for
 * this pass: `real = 0` would strip the paperclip off every message that legitimately carries
 * files. `attachment-flag-backfill.pg.test.ts`'s mixed-message cases caught it. Do not "simplify"
 * this back.
 */
function realFileCount(): SQL<number> {
  return sql<number>`(
    select count(*)::int from ${attachments} att
     where att.message_id = ${messages}.${sql.identifier(messages.id.name)}
       and att.inline = false
  )`;
}

/**
 * Rows corrected per transaction.
 *
 * The same 100 as {@link SENSITIVE_RESCREEN_BATCH} and for the same reason: `recordChange` takes
 * the account's `account_sync_state` row lock for the length of its transaction, so a
 * whole-backlog transaction would stall every API write for that account while a couple of
 * thousand rows
 * drained. 100 rows is a few milliseconds of lock, and the pass is resumable between batches by
 * construction.
 */
export const ATTACHMENT_FLAG_BATCH = 100;

/**
 * Pages the pass will walk before giving up and saying so — a bound of 50 000 rows at the batch
 * above, orders of magnitude past any candidate set this pass has been pointed at.
 *
 * A bound and not a `while (true)`. Unlike the rescreen, termination here IS the empty page (the
 * set drains), so this cap only ever fires on a paging bug — and one warning line is a better
 * outcome for that than an unbounded loop against somebody's live data.
 */
export const ATTACHMENT_FLAG_MAX_PAGES = 500;

export interface AttachmentFlagBackfillDeps {
  db: Db;
  /** Restrict to one mailbox. Absent ⇒ every mailbox. */
  mailboxId?: string;
  log?: Logger;
  /** Test seam. Default {@link ATTACHMENT_FLAG_BATCH}. */
  batch?: number;
  /** Test seam. Default {@link ATTACHMENT_FLAG_MAX_PAGES}. */
  maxPages?: number;
}

export interface AttachmentFlagBackfillResult {
  /** Candidate rows locked and examined. */
  examined: number;
  /** Rows whose flag went `true` → `false` (nothing to download). */
  cleared: number;
  /**
   * Rows that KEPT `has_attachments = true` and had only `attachment_count` corrected — a
   * message with both real files and embedded images, whose count used to include the images.
   */
  recounted: number;
  /** The pass hit {@link ATTACHMENT_FLAG_MAX_PAGES} before the set drained. */
  truncated: boolean;
}

/** One candidate: the stored pair, and the truth from the attachment rows. */
interface CandidateRow {
  messageId: string;
  accountId: string;
  storedHasAttachments: boolean;
  storedCount: number;
  realFiles: number;
}

/**
 * Correct `messages.has_attachments`/`attachment_count` wherever they disagree with the
 * attachment rows, one `message`/`update` change per corrected row. Idempotency IS the candidate
 * query: a corrected row is the negation of {@link selectCandidates}' predicate and cannot be
 * selected again — a second run reads zero rows, asserted in `attachment-flag-backfill.test.ts`.
 * Termination is the empty page; `afterId` is belt and braces, monotone in `messages.id`, so a
 * row that somehow failed to leave the set is not re-read for ever at the head of page 0.
 */
export async function runAttachmentFlagBackfill(
  deps: AttachmentFlagBackfillDeps,
): Promise<AttachmentFlagBackfillResult> {
  const tx = deps.db as unknown as Tx;
  const log = deps.log ?? silentLogger;
  const batch = deps.batch ?? ATTACHMENT_FLAG_BATCH;
  const maxPages = deps.maxPages ?? ATTACHMENT_FLAG_MAX_PAGES;

  let examined = 0;
  let cleared = 0;
  let recounted = 0;
  let truncated = true;
  let afterId: string | undefined;
  const touchedAccounts = new Set<string>();

  for (let page = 0; page < maxPages; page++) {
    const result = await tx.transaction(async (t) => {
      const rows = await selectCandidates(t, { mailboxId: deps.mailboxId, limit: batch, afterId });
      let didClear = 0;
      let didRecount = 0;

      for (const row of rows) {
        const nextHas = row.realFiles > 0;
        const nextCount = row.realFiles;

        // Why there is no second "is it still wrong?" check here: there was one, and no mutation
        // could turn it red — deleting it left all ten tests green, and a guard nobody has
        // watched fail is not evidence. What protects the row is `FOR UPDATE OF messages` plus
        // the candidate predicate — "already corrected" and "no longer a candidate" are one
        // condition: the loser of a lock wait re-evaluates the quals against the committed tuple
        // (EvalPlanQual) and the row is dropped before this loop sees it. That the LOCK does it
        // is measured: removing `.for("update")` turned the concurrency case red with `expected
        // 24 to be 12` — every message corrected twice. PGlite cannot see this
        // (single-connection), which is why that assertion lives in a `.pg.test.ts` on :5433.
        await t.update(messages)
          .set({ hasAttachments: nextHas, attachmentCount: nextCount })
          .where(eq(messages.id, row.messageId));

        // The delta. Without this line the user's mirror keeps the old paperclip for ever and
        // the whole pass is invisible to the person who reported the defect.
        await recordChange(t, {
          accountId: row.accountId,
          entityType: "message",
          entityId: row.messageId,
          op: "update",
        });

        // The inverse carries the PRIOR PAIR and not just the flag. An inverse of
        // `{hasAttachments: true}` alone would restore the badge and leave the count at the new
        // value — not an undo, a third state.
        await t.insert(auditLog).values({
          accountId: row.accountId,
          action: "attachment_flag_backfill_row",
          payload: {
            messageId: row.messageId,
            hasAttachments: nextHas,
            attachmentCount: nextCount,
            realFiles: row.realFiles,
          },
          inverse: {
            messageId: row.messageId,
            hasAttachments: row.storedHasAttachments,
            attachmentCount: row.storedCount,
          },
        });

        touchedAccounts.add(row.accountId);
        if (nextHas) didRecount++;
        else didClear++;
      }
      return { rows, didClear, didRecount };
    });

    examined += result.rows.length;
    cleared += result.didClear;
    recounted += result.didRecount;
    if (result.rows.length === 0) { truncated = false; break; }
    afterId = result.rows[result.rows.length - 1]!.messageId;
  }

  if (truncated) {
    log.warn("attachment_flag_backfill_truncated", {
      mailboxId: deps.mailboxId ?? null, examined, cleared, recounted, maxPages,
      reason: "the candidate set did not drain within the page cap — re-run to resume; the pass " +
        "is idempotent and picks up exactly where it stopped",
    });
    return { examined, cleared, recounted, truncated: true };
  }

  // ── THE TERMINAL SUMMARY ROW, WHICH IS WHAT A MARKER COLUMN WOULD HAVE BEEN ───────────────
  //
  // One per account actually touched — an account whose rows were all already correct gets no
  // row, because "this pass ran and did nothing" is not a fact worth a write. `inverse: null`:
  // the per-row entries above are the undo; this one is a receipt.
  if (touchedAccounts.size > 0) {
    await tx.transaction(async (t) => {
      for (const accountId of touchedAccounts) {
        await t.insert(auditLog).values({
          accountId,
          action: "attachment_flag_backfill",
          payload: { mailboxId: deps.mailboxId ?? null, examined, cleared, recounted },
          inverse: null,
        });
      }
    });
  }

  log.info("attachment_flag_backfill_complete", {
    mailboxId: deps.mailboxId ?? null, examined, cleared, recounted,
  });
  return { examined, cleared, recounted, truncated: false };
}

/**
 * One page of messages whose stored pair disagrees with their attachment rows — locked FOR
 * UPDATE, oldest id first. `real` is `count(*) where inline = false`, the Files-list predicate.
 * Two arms: (1) `real = 0` on a flagged row; (2) `attachment_count <> real` — mixed messages: a
 * half-corrected column would mean "all parts" on old rows and "downloadable parts" on new ones.
 * `has_attachments = true` gates BOTH arms, a deliberate bound: measured, zero unflagged rows
 * hold a real file, so a third arm would select nothing while widening the blast radius to every
 * message. `FOR UPDATE OF messages` — `of` the one table: the lateral count subquery is not
 * lockable, and `attachments` rows are written once at ingest.
 */
async function selectCandidates(
  t: Tx,
  opts: { mailboxId?: string; limit: number; afterId?: string },
): Promise<CandidateRow[]> {
  const real = realFileCount();

  const filters = [
    eq(messages.hasAttachments, true),
    sql`(${real} = 0 or ${messages.attachmentCount} <> ${real})`,
  ];
  if (opts.mailboxId) filters.push(eq(messages.mailboxId, opts.mailboxId));
  if (opts.afterId) filters.push(gt(messages.id, sql`${opts.afterId}::uuid`));

  const rows = await t.select({
    messageId: messages.id,
    accountId: messages.accountId,
    storedHasAttachments: messages.hasAttachments,
    storedCount: messages.attachmentCount,
    realFiles: real,
  }).from(messages)
    .where(and(...filters))
    .orderBy(asc(messages.id))
    .limit(opts.limit)
    .for("update", { of: messages });

  return rows.map((r) => ({
    messageId: r.messageId,
    accountId: r.accountId,
    storedHasAttachments: r.storedHasAttachments,
    storedCount: r.storedCount,
    realFiles: Number(r.realFiles),
  }));
}

/**
 * The READ-ONLY counts the `plan` command prints. No `FOR UPDATE`, no write, one statement.
 *
 * Reported per mailbox because the blast radius is per mailbox and an operator staring at a
 * single total cannot tell one mailbox's 728 rows from two mailboxes' 364.
 */
export async function planAttachmentFlagBackfill(db: Db): Promise<Array<{
  mailboxId: string; flagged: number; inlineOnly: number; miscounted: number; correct: number;
}>> {
  const tx = db as unknown as Tx;
  const real = realFileCount();
  const rows = await tx.select({
    mailboxId: messages.mailboxId,
    flagged: sql<number>`count(*)::int`,
    inlineOnly: sql<number>`count(*) filter (where ${real} = 0)::int`,
    miscounted: sql<number>`count(*) filter (
      where ${real} > 0 and ${messages.attachmentCount} <> ${real})::int`,
    correct: sql<number>`count(*) filter (
      where ${real} > 0 and ${messages.attachmentCount} = ${real})::int`,
  }).from(messages)
    .where(eq(messages.hasAttachments, true))
    .groupBy(messages.mailboxId)
    .orderBy(asc(messages.mailboxId));

  return rows.map((r) => ({
    mailboxId: r.mailboxId,
    flagged: Number(r.flagged),
    inlineOnly: Number(r.inlineOnly),
    miscounted: Number(r.miscounted),
    correct: Number(r.correct),
  }));
}
