/**
 * THE PROVIDER'S NOTICES: for each calendar read by token, a channel at the provider that rings
 * this deployment when the calendar changes, opened before the last one ends; polling stays the
 * floor under it. Worker-only: the channel table is the Cloud's.
 *
 * Reached by nothing yet. A channel needs a public address for the provider to call
 * (`OHCAL_NOTICE_ORIGIN`), the route that answers it, and the channel table, and none of the three
 * is on this line: with no address this pass makes no request and writes no row, and with one it
 * still opens nothing until the table and the route exist. It says so once, at the worker's start.
 */
import type { Logger } from "@trafficflow/core";
import type { CalendarNoticeInput } from "@ohmail/organizer/calendar/types";

export interface CalendarNoticeDeps {
  /** The public origin a provider's notices are sent to, or `null`. */
  readonly origin: string | null;
  readonly log: Logger;
}

/** After a turn that ended well: is a channel alive for every calendar of the connection? */
export async function calendarNoticesPass(deps: CalendarNoticeDeps, input: CalendarNoticeInput): Promise<{ readonly live: boolean }> {
  if (deps.origin === null || input.calendars.length === 0 || input.signal.aborted) return { live: false };
  return { live: false };
}
