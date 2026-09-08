/**
 * ═══ THE PREDICATES OVER `folder_state` THE STRIP AND THE RECONCILER SHARE ═══════════════════
 *
 * ── THE COMMENT THAT WAS FALSE IN BOTH DIRECTIONS ───────────────────────────────────────────
 *
 * `mailbox-service.ts` built `MailboxDTO.pendingMoves` under a comment saying it used "the same
 * join `listPendingFolderStates` uses, and the same three predicates, so the number here and the
 * work the reconciler will actually do are one set". Neither half held:
 *
 *  · the STRIP's count filters `pending` ∧ `last_set_by = 'us'` ∧ `desired <> observed`;
 *  · the RECONCILER's queue filters `pending` ∧ `dueNow(next_attempt_at)` — and NOT the other two.
 *
 * So a DEFERRED row (refused, next attempt minutes or hours out) is IN the count and ABSENT from
 * the queue, which is the whole of the reported defect: the strip said "Filing 1 message on your
 * mail server…" about a row nothing was going to touch. And in the other direction the queue
 * carries rows the count deliberately excludes.
 *
 * ── WHY THIS IS NOT ONE SHARED QUERY, WHICH IS WHAT IT LOOKS LIKE IT SHOULD BE ──────────────
 *
 * The obvious repair is one predicate both sites import, and it is WRONG. The reconciler's queue
 * has to keep carrying two shapes the strip must never count:
 *
 *  · `desired = observed` while the status still says `pending` — a STATUS REPAIR. `reconcileFolders`
 *    reads exactly these and re-derives `reconcile_status` for them (`apps/worker/src/sync.ts`,
 *    the `p.desiredFolder === p.observedFolder` arm). Narrowing the queue to the strip's predicates
 *    would strand every one of them `pending` for ever — and invisibly, because the strip is the
 *    thing that does not count them.
 *  · `last_set_by = 'external'` — the user tidying in their own client. The queue reads them and
 *    the loop skips them under the user-wins rule; the strip must not call somebody else's move
 *    OUR backlog.
 *
 * The two sets are therefore genuinely different, and the honest shape is this: ONE module owns
 * every predicate, each named for the question it answers, and each site COMPOSES the ones it
 * means. What that buys is not a single query — it is that `dueNow` has one definition, that
 * "outstanding filing of ours" has one definition, and that the DTO can report `due` and
 * `deferred` SEPARATELY using the same notion of due the queue uses. The number and the queue can
 * now disagree only in ways this file names out loud.
 *
 * `folder_state` is keyed by message and carries no mailbox column, so every caller joins through
 * `messages` and scopes on `messages.mailbox_id` itself — the join is the caller's, the predicates
 * are here.
 */
import { and, eq, isNull, lte, not, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { folderState } from "./schema-mail.js";

/**
 * "This deferred mutation may be attempted again" — the due predicate every pending query shares
 * (mail 0058).
 *
 * `IS NULL` is the FIRST arm and it is not a convenience: NULL is what every row is born with and
 * what a fresh intent is reset to, so an implementation that only compared instants would hide
 * every never-yet-refused mutation in the product. The two arms together are the whole meaning of
 * the column — a schedule with "now" as its default.
 *
 * The instant comes from the APPLICATION clock rather than SQL `now()`, matching the write side
 * (`deferFolderReconcile` is handed a `Date` the worker computed). One clock decides both when a
 * mutation becomes due and when it was deferred to, so a skew between the database's clock and the
 * worker's cannot make a deferral shorter or longer than the policy says.
 *
 * `now` is a PARAMETER with no default, deliberately: the DTO builder reads the request's own
 * instant (which is also what it reports as `asOf`), and a hidden `new Date()` would make the
 * number and the timestamp beside it two different readings.
 */
export function dueNow(col: AnyPgColumn, now: Date): SQL | undefined {
  return or(isNull(col), lte(col, now));
}

/**
 * The complement of {@link dueNow} — asleep until `next_attempt_at`.
 *
 * Written as the NEGATION of the same expression rather than as `gt(col, now)`, because the two
 * are not equivalent: `gt` on a NULL column yields NULL, which a `WHERE` treats as false. That
 * happens to be the right answer here (a NULL row is due, not deferred), so `gt` would work by
 * luck. `not(dueNow(...))` cannot drift from its partner when either changes.
 */
export function deferredUntilLater(col: AnyPgColumn, now: Date): SQL {
  return not(or(isNull(col), lte(col, now))!);
}

/**
 * A FILING OF OURS THE MAIL SERVER HAS NOT APPLIED — the three predicates, without the schedule.
 *
 * Each one excludes a real shape, and each exclusion is why the strip's number is not the queue's:
 *
 *  · `pending` — `reconciled` is the state this whole number counts down to.
 *  · `last_set_by = 'us'` — an external pending row is the user tidying in their own client, which
 *    the organizer ADOPTS rather than pushes. Counting it would report their own housekeeping as
 *    our backlog.
 *  · `desired <> observed` — a pending row whose folders already agree is a no-op the reconciler
 *    retires without touching IMAP. `upsertDesired` writes `reconcile_status: 'pending'`
 *    unconditionally rather than deriving it, so these exist.
 *
 * The mailbox scope is NOT here: it belongs to the caller's join (see the module header).
 */
export function ourOutstandingFiling(): SQL {
  return and(
    eq(folderState.reconcileStatus, "pending"),
    eq(folderState.lastSetBy, "us"),
    sql`${folderState.desiredFolder} <> ${folderState.observedFolder}`,
  )!;
}

/** An outstanding filing of ours the next reconcile turn will pick up. */
export function filingDue(now: Date): SQL {
  return and(ourOutstandingFiling(), dueNow(folderState.nextAttemptAt, now))!;
}

/**
 * An outstanding filing of ours that is ASLEEP — refused, with its retry scheduled.
 *
 * The row the reported sentence was about: it is in `pendingMoves` and it is not in
 * `listPendingFolderStates`, so nothing will touch it until its `next_attempt_at`. A client that
 * cannot tell this from {@link filingDue} cannot say anything true about either.
 */
export function filingDeferred(now: Date): SQL {
  return and(ourOutstandingFiling(), deferredUntilLater(folderState.nextAttemptAt, now))!;
}

/**
 * WHY A FILING WAS REFUSED — the closed set `folder_state.last_error_class` may hold, and the
 * membership the migration's CHECK enforces (mail 0097).
 *
 * Four words this codebase chose, mapped from the server's structured IMAP response code by
 * `apps/worker/src/sync.ts`. `folder_state`'s schema comment forbids storing what went wrong in
 * the server's own words, and this keeps that rule: the free text stays in the
 * `reconcile.move.failed` audit row, and what reaches a screen is a value we picked.
 *
 * Lives here, in the package that owns the column, because both sides need it and neither may
 * import the other: the worker WRITES it (and may not import `@trafficflow/services`) and the DTO
 * builder NARROWS it (and is in the desktop engine's closure, so it may not import the worker).
 *
 * `refused` is the catch-all and it is a real member rather than a fallback: a server that says
 * `NO` with no response code has refused the move, and that is worth saying.
 */
export const FILING_REFUSAL_CLASSES = [
  "refused", "no_such_folder", "read_only", "over_quota",
] as const;

export type FilingRefusalClass = (typeof FILING_REFUSAL_CLASSES)[number];

/**
 * Narrow a stored class, so a value this build does not recognise cannot reach a screen.
 *
 * Reachable during a rolling deploy — a newer worker writing a fifth member against an older API
 * — and the answer is `false`, which every reader turns into its own "your server would not say
 * why" rather than into silence. That is the rule this schema follows wherever a closed set
 * crosses a version boundary: a state this build cannot NAME still gets a sentence, because
 * silence is what made the state invisible in the first place.
 */
export function isFilingRefusalClass(v: unknown): v is FilingRefusalClass {
  return typeof v === "string" && (FILING_REFUSAL_CLASSES as readonly string[]).includes(v);
}
