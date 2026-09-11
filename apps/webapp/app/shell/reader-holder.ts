/**
 * Is there a holder, and does it have a name. Measured on a released build: connect a mailbox, decline to organize,
 * and every reader surface said "Organized by another install · Since —" — a named relationship with an install that
 * does not exist. The cause was one question standing in for another: the surfaces branched on the display NAME being
 * absent, and a name is absent in two different states — a holder exists that this build cannot name, and nobody
 * holds the mailbox at all.
 */

/**
 * `organizedBy` present/absent is the discriminator, not the name: the wire emits the object only when at least one
 * holder column was written (`mailbox-service.ts`), so its PRESENCE is exactly "something recorded a holder", and the
 * shell must not re-derive it from the fields. An object with an empty name is {@link ReaderHolder.unnamed}, never
 * `nobody`. NOT the routing predicate (that is `deriveOnboardingStep` row 3's, answered from `kind || name`), and not
 * about consent — folding consent in would make a fourth state out of two unrelated questions.
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
 * And the routing question, which is a different one. {@link readerHolder} answers "which of three SENTENCES is
 * true", and for a sentence it is right that an API too old to send the field and one saying "no holder" collapse —
 * neither may print a name. For a decision about which SCREEN somebody sees, that collapse is the defect: it reads
 * "this build has not been told" as "the mailbox is free", and the screen it takes away is the one asking whether to
 * displace an existing organizer (measured: a read carrying no organizer answer released the cursor and the run
 * resumed on the consent statement, one Agree from an unshown takeover).
 */

/**
 * So this asks whether a read ANSWERED: `unknown` — no row, or a row with no organizer field: nothing may be
 * concluded; `nobody` — the field was there and empty, an ANSWER; `somebody` — a holder recorded, named or not. It
 * cannot tell a CURRENT `nobody` from a STALE one — ordering needs a fact this shape does not carry; see
 * `OnboardingMailbox`, where the missing field is named.
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
