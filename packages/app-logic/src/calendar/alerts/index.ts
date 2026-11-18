/**
 * The calendar's alerts and notices as the page makes them: what is set ahead to ring, a start on the reader's clock,
 * and the calendar as the notices' gate compares it. With them the platform's zone rules, so a shell that rings alerts
 * reads them through this one door.
 */
export { alertsAhead, noticeClockOf, startMsOf, type AheadInput } from "./ahead.js";
export { calendarReadsOf, type CalendarReadsSource } from "./reads.js";
export {
  calendarLookOf,
  calendarSampleOf,
  type CalendarLookInput,
  type CalendarSampleInput,
} from "./sample.js";
export { calendarSnapshotOf, type SnapshotInput } from "./snapshot.js";
export { readerZones } from "../spans/days.js";
export { liveCalendarScope, useHostCalendarNotices } from "./host.js";
