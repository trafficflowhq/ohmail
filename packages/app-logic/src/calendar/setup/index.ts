/** The calendar's setup and settings, for their screens: the port, the ways and steps, the accounts, the fault sentences. */
export {
  CALENDAR_WAYS,
  isCalendarOAuthProvider,
  type CalendarOAuthProvider,
  type CalendarChange,
  type CalendarSetupPort,
  type CalendarWay,
  type ConnectAnswer,
  type ConnectAsk,
} from "./port.js";
export type { CalendarSettingsBody, CalendarSyncFault } from "@ohmail/wire";
export {
  SETUP_STEPS,
  calendarOAuthResultOf,
  offeredWays,
  stepOf,
  waysSaid,
  type CalendarOAuthResult,
  type SetupStep,
  type StandingStep,
  type SteppedWay,
} from "./steps.js";
export { CONNECT_FAULT_KEYS, connectFaultKeyOf, type ConnectFaultKey } from "./faults.js";
export {
  accountsOf,
  newEventsCalendarOf,
  wayOfConnection,
  writableOf,
  type AccountState,
  type CalendarAccount,
} from "./accounts.js";

export { calendarSetupPortOf } from "./port-of.js";
