import { and, eq } from "drizzle-orm";
import {
  mailboxes, mailboxProfileMirror, isOrganizerKind, isOrganizerRole,
  MailboxNotFoundError, type OrganizedBy,
} from "@trafficflow/db";
import type { ServiceContext } from "./context.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  WHAT A READER SHOWS FOR SETTINGS IT DOES NOT OWN — `mailbox_profile_mirror` (mail 0094)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * On a mailbox another install organizes, this install's own rows are not the answer: the responder,
 * the rules, the window and the signature that are actually in force are the ones in the organizing
 * install's PUBLISHED DOCUMENT. Ruling 6's Critical is that the panes used to render the local rows
 * anyway, so a reader was shown its own dead copy as though it were live.
 *
 * The reader's cycle caches that document in `mailbox_profile_mirror`. This is the read side: one
 * indexed row by mailbox, no IMAP, no dial. There is deliberately no fallback to dialling the
 * mailbox per request — `profile-import` does that and it costs a connection from the per-mailbox
 * cap, which is the wrong price for opening a settings pane.
 *
 * ── FOUR STATES, AND THEY MUST NOT COLLAPSE INTO EACH OTHER ────────────────────────────────
 *
 * This is the shape that has already gone wrong once in this repository, when an optional prop's
 * `null` meant both "not answered yet" and "never supplied" and every door refused with a sentence
 * about another install. So each state is named:
 *
 *  · `organizing: true` — this install organizes the mailbox. There is no mirror and there should
 *    not be one: the local rows ARE the configuration, and the pane reads them directly. `profile`
 *    is null here because none was mirrored, which is not the same as "none exists".
 *  · a row is present ⇒ `profile` is the document and `asOf` says when it was read. A reader that
 *    has been offline for a day must be able to say so rather than present a day-old document as
 *    current, which is what `asOf` is for.
 *  · no row, `from` names a holder ⇒ "no settings from <machine> yet". The reader has seen who
 *    holds the mailbox but has not yet read a document — either its cycle has not got there, or
 *    that install has never published one (a mailbox whose owner has changed no settings publishes
 *    nothing, because an empty document would be litter).
 *  · no row, `from.kind` null ⇒ nobody is known to hold it. Not the same sentence, and the copy
 *    layer composes a different one.
 *
 * A MISSING ROW IS THE ABSENCE, never a row of nulls: the reader's cycle replaces the row WHOLE or
 * leaves it alone, so "we have no document" and "the document says nothing" stay distinguishable.
 */
export interface MailboxProfileView {
  mailboxId: string;
  /** True when THIS install organizes the mailbox — see the header; the local rows are the answer. */
  organizing: boolean;
  /** The organizer's published document as this install last read it, or null. */
  profile: unknown | null;
  /** Who the document came from — or would come from. `kind: null` means nobody is known. */
  from: OrganizedBy;
  /** When this install last read it. Null whenever `profile` is null. */
  asOf: string | null;
}

/**
 * READ ONE MAILBOX'S MIRRORED PROFILE. Account-scoped: a mailbox the account does not hold is
 * indistinguishable from a missing one, which is the rule every read on this table follows.
 *
 * The generation check does NOT live here, deliberately. A row is only ever written by the reader's
 * cycle, which holds the live connection and therefore knows the folder's current UIDVALIDITY; a
 * row read under a generation that no longer matches is DISCARDED THERE, at the moment the two
 * facts are known together. Re-checking here would need a dial, and a check made from a generation
 * fetched at a different moment is not the generation the uid was read under — which is the whole
 * defect `(uidvalidity, uid)` exists to prevent. So this read trusts the row and the cycle owns the
 * discarding.
 */
export async function readMailboxProfile(
  ctx: ServiceContext, mailboxId: string,
): Promise<MailboxProfileView> {
  const [mb] = await ctx.db.select({
    role: mailboxes.organizerRole,
    kind: mailboxes.organizedByKind,
    name: mailboxes.organizedByName,
    since: mailboxes.organizedSince,
    status: mailboxes.status,
  })
    .from(mailboxes)
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, ctx.accountId)))
    .limit(1);
  if (!mb) throw new MailboxNotFoundError(mailboxId);
  // A tombstone is not a mailbox with no settings; it is not a mailbox. `ScreenerService.decide`'s
  // rule, and the reason is the same: answering about a removed mailbox names a holder that holds
  // nothing.
  if (mb.status === "disabled") throw new MailboxNotFoundError(mailboxId);

  const from: OrganizedBy = {
    kind: isOrganizerKind(mb.kind) ? mb.kind : null,
    name: mb.name ?? null,
    since: mb.since ? mb.since.toISOString() : null,
  };
  const role = isOrganizerRole(mb.role) ? mb.role : "reader";

  if (role === "organizer") {
    /* NO MIRROR IS READ FOR AN ORGANIZER, and not reading it is the point rather than an
       optimisation: a stale row left over from before this install took the mailbox over would be
       served as though it were the current configuration, which is a document describing what
       somebody ELSE last published. The local rows are the answer, and `organizing` says so. */
    return { mailboxId, organizing: true, profile: null, from, asOf: null };
  }

  const [row] = await ctx.db.select({
    doc: mailboxProfileMirror.doc,
    readAt: mailboxProfileMirror.readAt,
  })
    .from(mailboxProfileMirror)
    .where(and(
      eq(mailboxProfileMirror.mailboxId, mailboxId),
      // THE ACCOUNT COLUMN IS IN THE PREDICATE, not just the primary key. The table is keyed by
      // mailbox alone, so a predicate on the id would return whatever row carried that uuid; the
      // account column is the only thing that makes "this mailbox is ours" a property of the query
      // rather than of the caller's diligence.
      eq(mailboxProfileMirror.accountId, ctx.accountId),
    ))
    .limit(1);

  if (!row) return { mailboxId, organizing: false, profile: null, from, asOf: null };
  return {
    mailboxId, organizing: false,
    profile: row.doc,
    from,
    asOf: row.readAt.toISOString(),
  };
}
