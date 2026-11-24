/**
 * NO CALENDAR ON THIS STORE: the phone's twin of `packages/db/src/calendar/erasure.ts`.
 *
 * A phone that organizes on its own keeps no calendar in 2.0 (its journal carries a `.noop` where
 * the calendar's tables are), so a mailbox's erasure has no calendar part to take there. The
 * mailbox sweep asks the calendar's step only on a Postgres store; this twin stands in the
 * phone's build so that no calendar code and no calendar table enters its engine, and answers
 * done, with nothing taken, should anything ask it.
 */
export const NO_CALENDAR_ON_THIS_STORE = "a phone's own store keeps no calendar";

export async function sweepMailboxCalendarStep(): Promise<{ deleted: Record<string, number>; done: true; seq: null }> {
  return { deleted: {}, done: true, seq: null };
}
