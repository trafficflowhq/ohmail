/**
 * `@trafficflow/services/calendar` — the calendar's part of the services, behind an entry of its
 * own. No barrel re-exports it: the phone's engine is built from the services' entries, and it may
 * hold no calendar code (its bundle census refuses one). A composition that keeps a calendar
 * imports this and hands `calendarFeed` to the sync feed's reader as its port.
 */
export { setCalendarSuggestionDismissed } from "./suggestions.js";
export { calendarFeed } from "./port.js";
export { calendarEnabledAt, CALENDAR_BUILDERS, cutToFit } from "./feed.js";
export {
  calendarSnapshotPage, heldBySpanSql, windowSpan, CALENDAR_SNAPSHOT_SUGGESTIONS, CALENDAR_WINDOW,
} from "./snapshot.js";
export { calendarSettings, setCalendarSettings, requireCalendarOn, CALENDAR_ZONE_NAME_MAX } from "./settings-service.js";
export { derivedRange, CALENDAR_RANGE_SLACK_MS, type EventRange, type EventRangeInput } from "./event-range.js";
export { eventTimeOf, storedTimeOf, momentOrUtc, isExactMoment } from "./time.js";
export { calendarExport, CALENDAR_EXPORT, type CalendarExport, type ExportAnswer } from "./export.js";
export {
  checkedAct, dismissCalendarWrite, enqueueCalendarWrite, recordCalendarWrite, retryCalendarWrite, wakeCalendarConnection,
  type EnqueuedCalendarWrite,
} from "./writes.js";
export { writeMarksOf } from "./write-marks.js";
export {
  pullCalendarsDue, pullConnectionDue, pullForNotice, NOTICE_LOCK_TIMEOUT_MS, NOTICE_SPACING_SECONDS, type ConnectionScope,
} from "./wake.js";

export { sendInvitationProposal } from "./proposals.js";
