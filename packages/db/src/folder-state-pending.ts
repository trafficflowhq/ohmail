/**
 * The predicates over `folder_state` the strip and the reconciler share. The two sites claimed
 * one set and had two: the strip counts `pending` ∧ `last_set_by = 'us'` ∧ `desired <> observed`;
 * the reconciler queues `pending` ∧ `dueNow(next_attempt_at)`. A DEFERRED row was in the count
 * and absent from the queue: the strip announced a filing nothing would touch. One shared query
 * would be WRONG — the queue must keep two shapes the strip must never count: `desired =
 * observed` still `pending` (a status repair; narrowing strands them forever) and `last_set_by =
 * 'external'` (the user tidying in their own client). So ONE module owns every predicate and each
 * site composes the ones it means. The join is the caller's.
 */
import { and, eq, isNull, lte, not, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { folderState } from "./schema-mail.js";

/**
 * "This deferred mutation may be attempted again" — the due predicate every pending query shares
 * (mail 0058). `IS NULL` is the FIRST arm and not a convenience: NULL is what every row is born
 * with and what a fresh intent resets to, so comparing instants alone would hide every
 * never-yet-refused mutation in the product. The instant comes from the APPLICATION clock,
 * matching the write side: one clock decides both when a mutation becomes due and when it was
 * deferred to, so database-vs-worker skew cannot stretch a deferral. `now` is a parameter with no
 * default: the DTO builder reads the request's own instant, and a hidden `new Date()` would make
 * the number and the timestamp beside it two readings.
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
 * A filing of OURS the mail server has not applied — the three predicates, without the schedule.
 * Each excludes a real shape, and each exclusion is why the strip's number is not the queue's:
 * `pending` (`reconciled` is what this number counts down to); `last_set_by = 'us'` (an external
 * pending row is the user tidying in their own client, which the organizer ADOPTS — counting it
 * would report their housekeeping as our backlog); `desired <> observed` (a pending row whose
 * folders already agree is a no-op the reconciler retires without touching IMAP — `upsertDesired`
 * writes `pending` unconditionally, so these exist). The mailbox scope is NOT here: it belongs to
 * the caller's join.
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
 * Why a filing was refused — the closed set `folder_state.last_error_class` may hold, with the
 * membership the migration's CHECK enforces (mail 0097). Four words this codebase chose, mapped
 * from the server's structured IMAP response code by the worker; the free text stays in the audit
 * row, and a screen shows a value we picked. Lives here because both sides need it and neither
 * may import the other: the worker WRITES it and may not import `@trafficflow/services`; the DTO
 * builder NARROWS it and is in the desktop engine's closure. `refused` is a real member, not a
 * fallback: a server that says `NO` with no response code has refused the move.
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
