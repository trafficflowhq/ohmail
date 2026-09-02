/**
 * WHAT THIS INSTALL DOES WITH THE MAILBOX ITS PANES NAME — "organizes" or "reads", never both.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────
 *
 * MEASURED on the released 0.13.7, on a standalone install reading a mailbox ohmail Cloud held
 * the live lease on: Settings → Desktop and Settings → About both said
 *
 *     "Mailbox — The mailbox this copy of ohmail organizes."
 *
 * on a machine whose own Mailboxes pane said, correctly and at the same moment, *"Organized by
 * ohmail Cloud · This computer reads the mailbox; it moves nothing and screens nothing."* Two
 * panes, one install, opposite claims — and the Remove confirmation's first bullet, "ohmail stops
 * organizing this mailbox.", made a third about an install that never had.
 *
 * ── WHY A MODULE OF ITS OWN ─────────────────────────────────────────────────────────────────
 *
 * Because two panes render the row and a third renders the bullet, and this repository's own
 * measured failure mode is one rule written twice and drifting. It is a pure function of the
 * predicate, so it has a table test with no React in it.
 *
 * The predicate itself is NOT here: it is `screenerReadOnly` over `readerStandDown` in
 * `app/shell/mail-state.ts`, the same one Settings → Mailboxes renders its banner from and the
 * same one the Screener pane asks. `null` means this install organizes, which is what an absent
 * provider and a host too old to send the role both answer — the safe direction, because the
 * dangerous default would put "reads" on a pane belonging to the organizer.
 *
 * ── ENGLISH IN PLACE, AND THAT IS DELIBERATE ────────────────────────────────────────────────
 *
 * Every sentence on those two panes is an English literal today; the whole install surface is
 * untranslated. Moving one row into a catalogue while its neighbours stay literal buys a German
 * reader nothing and hides the real gap. This fixes what the row SAYS. What language it says it
 * in is a separate and much larger piece of work, and it is filed as its own row rather than
 * half-done here.
 */
export function mailboxRowWhy(readOnly: { name: string | null } | null): string {
  if (readOnly === null) return "The mailbox this copy of ohmail organizes.";
  return readOnly.name
    ? `The mailbox this copy of ohmail reads. ${readOnly.name} organizes it.`
    : "The mailbox this copy of ohmail reads. Another ohmail organizer organizes it.";
}
