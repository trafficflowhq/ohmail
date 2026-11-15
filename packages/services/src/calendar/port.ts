/**
 * THE PORT a composition that keeps a calendar hands the feed's reader (`ApiServices.calendar`):
 * the switch, the builders, the window and the first load's pages. A composition that keeps none
 * hands nothing, and the reader then serves no calendar at all.
 */
import type { CalendarFeedPort } from "../calendar-port.js";
import { CALENDAR_BUILDERS, calendarEnabledAt } from "./feed.js";
import { CALENDAR_WINDOW, calendarSnapshotPage } from "./snapshot.js";

export const calendarFeed: CalendarFeedPort = {
  enabledAt: calendarEnabledAt,
  build: (db, accountId, kind, ids) => CALENDAR_BUILDERS[kind](db, accountId, ids),
  window: CALENDAR_WINDOW,
  snapshotPage: calendarSnapshotPage,
};
