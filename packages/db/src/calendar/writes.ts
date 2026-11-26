/**
 * THE CALENDAR'S WRITE QUEUE, AS ITS WORDS: what a `cal_writes` row may say it is (`op`), where it
 * stands (`state`) and why it was refused (`refusal`). Each list is the one constant its doors read;
 * the refusal words are the wire's, held equal to the providers' two lists where both are read (the
 * worker's composition, which imports both).
 */
import type { Assert, CalendarWriteFault, Complete } from "@ohmail/wire";
import { CALENDAR_SYNC_FAULTS } from "./closed-sets.js";

/** What a write asks of the provider. A move without a provider's own call is a create and a delete, two rows. */
export const CAL_WRITE_OPS = ["create", "update", "delete", "answer", "move"] as const;
export type CalWriteOp = (typeof CAL_WRITE_OPS)[number];

/** `pending`: owed to the provider. `applied`: the provider took it. `refused`: it will not be sent again unless the person asks. */
export const CAL_WRITE_STATES = ["pending", "applied", "refused"] as const;
export type CalWriteState = (typeof CAL_WRITE_STATES)[number];

/** Why a write was refused: the reading's words, the writers' own and the queue's. */
export const CALENDAR_WRITE_FAULTS = [
  ...CALENDAR_SYNC_FAULTS,
  "version_stale", "version_unknown", "event_gone", "read_only", "left_out",
  "invitees_unsupported", "repeat_unsupported", "field_unwritable",
  "earlier_refused", "content_refused", "expired", "answer_unconfirmed", "move_copy_left", "move_unresolved", "move_destination_unavailable",
] as const satisfies readonly CalendarWriteFault[];
type _WriteFaults = Assert<Complete<CalendarWriteFault, typeof CALENDAR_WRITE_FAULTS>>;

const memberOf = <T extends string>(list: readonly T[]) => {
  const set: ReadonlySet<string> = new Set(list);
  return (v: unknown): v is T => typeof v === "string" && set.has(v);
};

export const isCalWriteOp = memberOf(CAL_WRITE_OPS);
export const isCalWriteState = memberOf(CAL_WRITE_STATES);
export const isCalendarWriteFault = memberOf(CALENDAR_WRITE_FAULTS);

/** A stored or received refusal word as a word of the list: one this build does not know reads as `unknown`. */
export function asCalendarWriteFault(word: unknown): CalendarWriteFault {
  return isCalendarWriteFault(word) ? word : "unknown";
}
