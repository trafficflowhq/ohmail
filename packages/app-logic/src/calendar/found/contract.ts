/**
 * FROM MAIL'S ROW, as a type: what the list draws of one event found in a letter, and what Add writes. Worked out from
 * the mirror on every version and kept by nobody.
 */
import type { CalendarEventFields } from "@ohmail/wire";
import type { ListedRef } from "../invitations/index.js";
import type { DaySpan } from "../spans/days.js";

/** An event found in a letter that may be offered: what its row says, and what Add writes. */
export interface FoundRow {
  /** The suggestion's id. */
  readonly id: string;
  readonly title: string;
  /** Its first day on the reader's clock, `YYYY-MM-DD`. */
  readonly day: string;
  readonly when: DaySpan;
  readonly place: string | null;
  /** The letter's words it was read from, as text. */
  readonly sourceWords: string | null;
  /** The event Add makes. */
  readonly fields: CalendarEventFields;
  /** The same event on a shown calendar already: the row says so and leads to it, and offers no Add. */
  readonly alreadyOn: ListedRef | null;
}
