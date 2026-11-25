/**
 * THE PORT a composition that keeps a calendar hands the feed's reader (`ApiServices.calendar`):
 * the switch, the builders, the window and the first load's pages. A composition that keeps none
 * hands nothing, and the reader then serves no calendar at all.
 */
import { and, eq, isNull } from "drizzle-orm";
import { calendarDelta, invitationCalendarId, invitationStanding } from "@trafficflow/db";
import { calEvents } from "@trafficflow/db/mail";
import type { CalendarFeedPort } from "../calendar-port.js";
import { CALENDAR_BUILDERS, calendarEnabledAt } from "./feed.js";
import { CALENDAR_WINDOW, calendarSnapshotPage } from "./snapshot.js";

export const calendarFeed: CalendarFeedPort = {
  enabledAt: calendarEnabledAt,
  build: (db, accountId, kind, ids) => CALENDAR_BUILDERS[kind](db, accountId, ids),
  window: CALENDAR_WINDOW,
  snapshotPage: calendarSnapshotPage,
  async recordMailAnswer(tx, row, answer) {
    const standing = await invitationStanding(tx, row);
    if (standing.cancelled || standing.replacedBy !== null) return;
    const [copy] = await tx.update(calEvents).set({ mailAnswer: answer }).where(and(
      eq(calEvents.accountId, row.accountId), eq(calEvents.id, invitationCalendarId(row)),
      isNull(calEvents.myAnswer), isNull(calEvents.organizer),
    )).returning({ id: calEvents.id });
    return copy ? calendarDelta(row.accountId, "calendar_event", copy.id, "update") : undefined;
  },
};
