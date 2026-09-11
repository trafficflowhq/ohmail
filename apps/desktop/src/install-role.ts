/**
 * WHAT THIS INSTALL DOES WITH THE MAILBOX ITS PANES NAME — "organizes" or "reads", never both.
 * Measured on the released 0.13.7: Settings → Desktop and About said "The mailbox this copy of
 * ohmail organizes." on a machine whose own Mailboxes pane said, correctly, that ohmail Cloud
 * organizes it — two panes, opposite claims, and the Remove confirmation made a third. A
 * module of its own because two panes render the row and a third renders the bullet, and one
 * rule written twice drifts; it is a pure function of the predicate, table-tested with no
 * React. The predicate is `screenerReadOnly` over `readerStandDown` (`app/shell/mail-state.ts`);
 * `null` means this install organizes — the safe direction. `DOOR_COPY` is the non-hook route.
 */
import { DOOR_COPY, machineWord } from "./door-copy.js";

/**
 * ── A THIRD ANSWER, FOR AN INSTALL THAT READS THROUGH ANOTHER COMPUTER ─────────────────────
 * The predicate cannot reach this one: `readerHolder` asks whether the mailbox rows this
 * install sees say somebody else organizes, and on a paired desktop those rows are mirrored
 * from the host — which IS the organizer, so its rows carry no holder and the predicate
 * answers `null`, "this install organizes". Correct about the rows, false about the install.
 * So the door is asked separately, and it wins; `host` is null on every other door and falls
 * through to the two answers this function has always given.
 */
export function mailboxRowWhy(
  readOnly: { name: string | null } | null,
  host?: string | null,
): string {
  if (host) return DOOR_COPY.mailboxWhyViaHost(machineWord(), host);
  if (readOnly === null) return DOOR_COPY.mailboxWhyOrganizes;
  return readOnly.name
    ? DOOR_COPY.mailboxWhyReadsNamed(readOnly.name)
    : DOOR_COPY.mailboxWhyReads;
}
