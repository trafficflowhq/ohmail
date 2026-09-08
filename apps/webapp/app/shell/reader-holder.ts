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

/**
 * ═══ AND THE ROUTING QUESTION, WHICH IS A DIFFERENT ONE ═══════════════════════════════════
 *
 * {@link readerHolder} answers "which of three SENTENCES is true", and for a sentence it is right
 * that an API too old to send the field and one saying "no holder" collapse: neither names an
 * install, so neither may print a name. For a decision about which SCREEN somebody sees, that
 * collapse is the defect — it reads "this build has not been told" as "the mailbox is free", and
 * the screen it takes away is the one that asks whether to displace an existing organizer.
 *
 * MEASURED: with the claim question on screen and the cursor parked on it, a read that carried no
 * organizer answer released the cursor and the run resumed on the consent statement — where
 * Continue, then Agree, authorizes a takeover with the choice never having been shown.
 *
 * So this asks whether a read ANSWERED the question, and it has three answers rather than three
 * sentences:
 *
 *  · `unknown` — no row was read at all (a run whose mailbox the facts do not hold: a removal
 *    from another surface, a failing or stale list, an add that has not created yet), or a row
 *    that carried no organizer field. Nothing was said, so nothing may be concluded.
 *  · `nobody`  — the field was there and it was empty. That is an ANSWER: nothing organizes it.
 *  · `somebody` — a holder was recorded, named or not.
 *
 * ── WHAT IT STILL CANNOT TELL, SAID HERE RATHER THAN LEFT TO BE DISCOVERED ──────────────────
 *
 * It cannot tell a CURRENT `nobody` from a STALE one. Two reads of the same account can be in
 * flight at once and settle in either order, and an older answer landing second is a legitimate
 * `nobody` about a moment that has passed. Ordering them needs a fact this shape does not carry —
 * see `OnboardingMailbox`, where the missing field is named.
 */
export type HolderVerdict = "unknown" | "nobody" | "somebody";

/** What a read said about who organizes one mailbox — see {@link HolderVerdict}. */
export function holderVerdict(
  mailbox: { organizedBy?: ReaderHolderColumns | null } | null | undefined,
): HolderVerdict {
  /* NO ROW, NO ANSWER. `undefined` and `null` are one case here for the same reason they are two
     in `readerHolder`: there, both mean "name nobody"; here, neither is the mailbox saying
     anything about itself, because there is no mailbox in the run to say it. */
  if (mailbox === null || mailbox === undefined) return "unknown";
  /* ABSENT IS NOT EMPTY. `undefined` is a read that did not carry the field; `null` is the field,
     carried, saying nothing holds this mailbox — which every current producer distinguishes in
     its type and neither emits today, both mapping absent to `null` at their own seam. Honoured
     anyway, and named as unreachable rather than counted as a defence: the state it guards is one
     a wire change would reintroduce silently. */
  if (mailbox.organizedBy === undefined) return "unknown";
  return mailbox.organizedBy === null ? "nobody" : "somebody";
}
