/**
 * ═══ IS THERE A HOLDER, AND DOES IT HAVE A NAME ═══════════════════════════════════════════
 *
 * THE DEFECT THIS EXISTS FOR, measured on a released build: connect a mailbox on this computer,
 * decline to let it organize, and nothing anywhere holds the mailbox. Every reader surface said
 * *"Organized by another install · Since —. This computer reads the mailbox; it moves nothing and
 * screens nothing"* — a named relationship with an install that does not exist, and a date line
 * with no date in it. There was no other install.
 *
 * The cause was one question standing in for another. The surfaces branched on the holder's
 * DISPLAY NAME being absent, and a name is absent in two completely different states: a holder
 * exists and this build has no name for it, and NOBODY HOLDS THE MAILBOX AT ALL. One of those
 * deserves "another install"; the other deserves a sentence saying the mailbox is unorganized and
 * which press changes that. Collapsing them made the second one wear the first one's words.
 *
 * ── WHY `organizedBy` PRESENT/ABSENT IS THE DISCRIMINATOR, AND NOT THE NAME ────────────────
 *
 * The four holder columns are written together, and the wire projection emits the object only
 * when at least one of them was written — `mailbox-service.ts` (the `organizedBy` field):
 * *"`organizedBy` is NULL as a whole when nothing is named, rather than an object of three
 * nulls"*. So the object's PRESENCE is exactly the fact "something recorded a holder here", which
 * is the fact the sentence needs, and the shell must not re-derive it from the fields: a second
 * definition of one fact in the client is how the three surfaces would drift apart again.
 *
 * An object whose name is empty is therefore {@link ReaderHolder.unnamed} and never `nobody` — a
 * holder was recorded and this build cannot name it, which is the state the legacy label was
 * written for.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────────────────────
 *
 * NOT the routing predicate. `deriveOnboardingStep`'s row 3 and `DesktopMailboxes`' `role` ask
 * "did we see a FOREIGN claim worth putting a screen or a takeover button in front of somebody",
 * and they answer it from `kind || name` for a reason their own comments carry. This answers the
 * narrower question "which of three sentences is true", and it is deliberately the only reader of
 * its own rule, so the sentence cannot say one thing on the summary and another in Settings.
 *
 * NOT about consent either. Whether this account ever agreed to organize the mailbox does not
 * change what is true about the holder, and folding it in here would have made a fourth state out
 * of two facts that answer different questions.
 */
export type ReaderHolder = "nobody" | "unnamed" | "named";

/** The holder columns as every door serves them — `MailboxFacts` and `OnboardingMailbox` alike. */
export interface ReaderHolderColumns {
  kind?: string | null;
  name?: string | null;
  since?: string | null;
}

/**
 * WHICH OF THE THREE READER STATES this mailbox is in.
 *
 * `undefined` and `null` are one answer — `nobody` — because an API too old to send the field and
 * one saying "no holder" are both builds in which nothing is known to organize the mailbox, and
 * the sentence for that state names no install and promises no date. Absent must NOT read as a
 * holder: that is the direction that puts a stranger's name over somebody's own mailbox.
 */
export function readerHolder(organizedBy?: ReaderHolderColumns | null): ReaderHolder {
  if (!organizedBy) return "nobody";
  const name = organizedBy.name;
  return name !== null && name !== undefined && name.trim() !== "" ? "named" : "unnamed";
}
