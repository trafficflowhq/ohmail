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
 * ── AND IT IS NOW SAID IN THE READER'S LANGUAGE ─────────────────────────────────────────────
 *
 * This paragraph used to argue for leaving the three sentences as English literals: the whole
 * install surface around them was English, and translating one row while its neighbours stayed
 * literal would have hidden the real gap rather than closing it. That gap is closed. Both panes
 * read `desktopDoor` now, and so does this module — through `DOOR_COPY`, the non-hook route,
 * because there is no React here and the table test below drives the function directly.
 */
import { DOOR_COPY } from "./door-copy.js";

export function mailboxRowWhy(readOnly: { name: string | null } | null): string {
  if (readOnly === null) return DOOR_COPY.mailboxWhyOrganizes;
  return readOnly.name
    ? DOOR_COPY.mailboxWhyReadsNamed(readOnly.name)
    : DOOR_COPY.mailboxWhyReads;
}
