/**
 * `@trafficflow/services/calendar-connect`: the calendar's connect door, behind an entry of its
 * own. Not on the calendar's entry (`./index.ts`) on purpose: a desktop's engine and the worker
 * import that one for the feed's builders and the store's rules, and neither takes a sign-in. Only
 * a server's routes import this, so the code that holds what a person typed, and the providers'
 * address reader behind it, are in no program that has no door.
 */
export {
  calendarWays, connectCalendar, offeredWays, parseConnectAsk, parseSignInAsk,
  CalendarConnectionTaken, CalendarSealFault, CALENDAR_CEREMONIES_BUILT, CALENDAR_CONNECTION_CEILING,
  type CalendarConnectAsk, type CalendarConnectDoor, type CalendarSignInAsk,
} from "./connect.js";
export {
  checkCalendarConnection, removeCalendarConnection, setCalendar, signInCalendarAgain,
  CALENDAR_CHECK_EVERY_MS, CALENDAR_REMOVE_STEPS_PER_REQUEST,
} from "./connect-acts.js";
