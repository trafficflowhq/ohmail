import { and, eq } from "drizzle-orm";
import {
  mailboxes, mailboxProfileMirror, isOrganizerKind, isOrganizerRole,
  MailboxNotFoundError, type OrganizedBy,
} from "@trafficflow/db";
import type { ServiceContext } from "./context.js";

/**
 * WHAT A READER SHOWS FOR SETTINGS IT DOES NOT OWN — `mailbox_profile_mirror` (mail 0094). On a
 * mailbox another install organizes, the local rows are dead copies; in force is the organizer's
 * PUBLISHED DOCUMENT, cached here by the reader's cycle. One indexed row by mailbox, no
 * per-request dial. FOUR STATES, never collapsed: `organizing: true` (local rows ARE the
 * configuration); a row present (`profile` + `asOf`, so staleness can be said); no row, `from`
 * names a holder ("no settings from <machine> yet"); no row, `from.kind` null (nobody known to
 * hold it). A MISSING ROW IS THE ABSENCE, never a row of nulls: the cycle replaces rows WHOLE, so
 * "no document" and "the document says nothing" stay distinct.
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
 * indistinguishable from a missing one, the rule every read on this table follows. The generation
 * check does NOT live here, deliberately: rows are written only by the reader's cycle, which
 * holds the live connection and knows the folder's current UIDVALIDITY — a row read under a stale
 * generation is DISCARDED THERE, where the two facts are known together. Re-checking here would
 * need a dial, and a generation fetched at a different moment is not the one the uid was read
 * under — the defect `(uidvalidity, uid)` exists to prevent. This read trusts the row; the cycle
 * owns the discarding.
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
