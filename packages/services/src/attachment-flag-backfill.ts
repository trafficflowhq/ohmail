import { and, asc, eq, gt, sql } from "drizzle-orm";
import { messages, attachments, auditLog, recordChange, type Tx } from "@trafficflow/db";
import type { SQL } from "drizzle-orm";
import { silentLogger, type Logger } from "@trafficflow/core";
import type { Db } from "./context.js";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE PAPERCLIP THAT OPENS AN EMPTY STRIP — no migration
   ══════════════════════════════════════════════════════════════════════════════════════════

   ── WHAT WAS WRONG, MEASURED ────────────────────────────────────────────────────────────────

   `mime.ts:411` used to read `hasAttachments: attachments.length > 0` — every MIME part
   mailparser surfaced, `inline` cid: parts included. `attachments-service.ts:322/359/370`
   meanwhile select the Files list and download-all with `eq(attachments.inline, false)`. Two
   definitions of "a file", and the gap between them is what the user sees: on the mailbox this
   was measured against, over forty percent of the paperclipped mail held nothing to download at
   all — newsletter logos, signature images, tracking pixels — while NOT ONE unflagged message
   held a real file.

   That last fact is the important one. **The flag only ever over-reports**, so this pass is
   strictly one-directional and can never invent a paperclip.

   The ingest fix is forward-looking only. Rows already on disk keep their old value for
   ever, because nothing in this codebase has ever UPDATED `has_attachments` — until this.

   ── WHY IT WRITES `change_log` AND WHY THAT IS THE WHOLE POINT ──────────────────────────────

   Clients hold a local mirror (`client-engine/src/store.ts`) fed by `/sync`. A row corrected in
   Postgres with no delta is a row the user's browser keeps at the old value indefinitely — the
   fix would be invisible to precisely the person who reported it. `sync-service.ts:91,106`
   re-materializes the full `MessageDTO` for any non-delete `message` change, and
   `client-engine/src/apply.ts:55` upserts it on `create|update`, so ONE `op: "update"` per
   corrected row carries the new `hasAttachments` **and** `attachmentCount` to every mirror.

   ── WHY THERE IS NO MIGRATION AND NO MARKER COLUMN ─────────────────────────────────────────

   `sensitive-rescreen.ts` stamps `mailboxes.sensitive_rescreen_at` because its candidate set is
   NOT self-limiting: a candidate the re-evaluation decides to KEEP stays a candidate for ever, so
   termination had to be a stamp. This pass has the opposite property — {@link selectCandidates}
   selects exactly the rows whose stored pair disagrees with the attachment rows, and every row it
   selects it corrects. The set drains. A second run reads zero rows and writes nothing, with no
   marker to consult and nothing to `--force`.

   So: no `0033`, no `health.ts` marker, no 503 window against a production migrated through 0032.
   The operator visibility a marker would have given is a terminal `audit_log` row instead —
   queryable, and it costs no schema.

   ── AND WHY IT DOES *NOT* SKIP MAIL THE USER HAS ACTED ON ──────────────────────────────────

   A deliberate departure from the precedent, because the precedent's reason does not transfer.
   `sensitive-rescreen.ts` excludes triaged, replied-to and ruled-on messages because it MOVES
   mail: yanking a message out of a pile the user built destroys their arrangement. This pass
   moves nothing, routes nothing, deletes nothing and changes no folder. It corrects a derived
   display flag so it agrees with the attachment rows that were already there.

   The sharper form of the argument: **no user action anywhere in this system writes
   `has_attachments` or `attachment_count`.** There is no intent in these columns to preserve —
   they are ingest's arithmetic about MIME structure. Excluding acted-on mail would pin a false
   paperclip permanently onto exactly the messages the user reads and replies to most.

   What replaces the exclusion, so this is not merely "we skipped the safety rail":

     · The pass never touches a row whose stored pair already matches its attachment rows. That
       is the candidate query, not a check bolted on afterwards.
     · Every corrected row gets an `audit_log` entry whose `inverse` carries the PRIOR pair, so
       "put it back" is expressible per row rather than as a regenerated guess.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * ── HOW MANY DOWNLOADABLE PARTS THIS MESSAGE HAS — AND WHY THE QUALIFICATION IS LOAD-BEARING ─
 *
 * `inline = false`, the same predicate `attachments-service.ts:322/359/370` selects the Files
 * list and download-all with, so "a file" means one thing on both sides of the badge.
 *
 * **`${messages}.${sql.identifier(...)}` and NOT `${messages.id}`.** Drizzle emits a bare column
 * interpolation UNQUALIFIED — `${messages.id}` becomes `"id"` — and `attachments` has an `id`
 * column of its own, so inside this subquery the unqualified name binds to the ATTACHMENT's id.
 * The correlation silently becomes `att.message_id = att.id`, which is never true, and the count
 * is 0 for every message alive.
 *
 * That is not a hypothetical. It is what this function returned on its first run, and it is the
 * worst possible failure for this pass: `real = 0` would have been true for every flagged
 * row, so the backfill would have stripped the paperclip off every message that legitimately
 * carries files — turning a cosmetic over-report into real data loss on somebody's live mail.
 * `attachment-flag-backfill.pg.test.ts`'s mixed-message cases are what caught it; a suite seeded
 * only with inline-only messages passes happily with the broken correlation, because the answer
 * it wants is 0 either way. Do not "simplify" this back.
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
 * Correct `messages.has_attachments` / `attachment_count` wherever they disagree with the
 * attachment rows, emitting one `message`/`update` change per corrected row.
 *
 * ── IDEMPOTENCY IS THE CANDIDATE QUERY, NOT A FLAG ─────────────────────────────────────────
 *
 * A row this pass corrects satisfies `has_attachments = (real > 0) AND attachment_count = real`,
 * which is the negation of {@link selectCandidates}' predicate. It cannot be selected again. A
 * second run therefore reads zero rows, writes zero `change_log` entries and zero audit rows —
 * and that is asserted rather than claimed, in `attachment-flag-backfill.test.ts`.
 *
 * ── TERMINATION IS THE EMPTY PAGE, AND THE CURSOR IS BELT AND BRACES ───────────────────────
 *
 * Every selected row is corrected, so the set shrinks monotonically and an empty page means done.
 * `afterId` is still carried, monotone in `messages.id`: without it a row that somehow failed to
 * leave the set would be re-read for ever at the head of page 0. Same construction as the
 * kickstart and the rescreen, for a weaker reason, on purpose.
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

        // ── WHY THERE IS NO SECOND "IS IT STILL WRONG?" CHECK ON THIS LINE ────────────────
        //
        // There WAS one, and it was removed because no mutation could turn it red — deleting it
        // left all ten tests green, including the twelve-message concurrency case. A guard
        // nobody has watched fail is not evidence, so it does not get to sit here looking like
        // protection.
        //
        // What actually protects the row is `FOR UPDATE OF messages` plus the shape of the
        // candidate predicate, and the two are the same fact: the predicate selects exactly the
        // rows whose stored pair DISAGREES with their attachment rows, so "already corrected"
        // and "no longer a candidate" are one condition. Two runs block on the same row; when
        // the loser is granted the lock Postgres re-fetches the committed tuple and re-evaluates
        // the outer quals against it (EvalPlanQual, standard READ COMMITTED behaviour for a
        // locking select). `has_attachments` is now false, or the count now equals `real`, so
        // the row is dropped before this loop ever sees it.
        //
        // That the LOCK is what does it, and not luck: a mutation check removed `.for("update")` and
        // the concurrency case went red with `expected 24 to be 12` — every message corrected
        // twice and every client told so twice, a convergence break. PGlite cannot see
        // this at all; it is single-connection and `FOR UPDATE` there always succeeds, which is
        // why that assertion lives in a `.pg.test.ts` on :5433.
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
 * ONE page of messages whose stored pair disagrees with their attachment rows — LOCKED FOR
 * UPDATE, oldest id first.
 *
 * ── THE CANDIDATE SET, AND WHY IT HAS TWO ARMS ─────────────────────────────────────────────
 *
 * `real` is `count(*) where inline = false` — the same predicate `attachments-service.ts` uses
 * for the Files list and download-all, so "a file" means one thing on both sides of the badge.
 *
 *  1. `real = 0` on a flagged row — the 804. The paperclip that opens an empty strip.
 *  2. `attachment_count <> real` — the mixed messages. This arm is NOT optional dressing: once
 *     `pipeline.ts` writes `countRealFiles(...)`, a column left half-corrected would carry
 *     "all parts" for old rows and "downloadable parts" for new ones, with nothing on the row
 *     saying which. A count whose meaning depends on the row's age is worse than the wrong
 *     count it replaces, because no later reader can tell the two apart.
 *
 * `has_attachments = true` gates BOTH arms, and that is a deliberate bound rather than an
 * oversight. Measured: zero unflagged rows have a real file, so an "unflagged but
 * should be flagged" arm would select nothing while widening the pass's blast radius from
 * "rows that claim a file" to every message in the database. If that measurement ever stops
 * holding, the missing arm is a NEW defect and deserves its own slice and its own evidence.
 *
 * ── AND THE LOCK ───────────────────────────────────────────────────────────────────────────
 *
 * `FOR UPDATE OF messages` — `of` the one table, because the lateral count subquery is not
 * lockable and locking it would be meaningless anyway: `attachments` rows are written once at
 * ingest, in the same transaction as the message, and never updated.
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
