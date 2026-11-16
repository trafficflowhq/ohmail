/**
 * `@trafficflow/db/calendar` — the calendar's part of the database package, behind an entry of its
 * own. The root barrel never re-exports it: the phone's engine is built from that barrel, and it
 * may hold no calendar code and name no calendar table (its bundle census refuses both). The
 * tables themselves are declared with the mail schema (`schema-mail.ts`, mail 0205).
 */
export {
  CALENDAR_PROVIDERS, CALENDAR_CONNECTION_STATUSES, CALENDAR_SYNC_FAULTS, CALENDAR_TIME_KINDS,
  CALENDAR_CLOSED_SETS,
  isCalendarProvider, isCalendarConnectionStatus, isCalendarSyncFault, isCalendarTimeKind, asCalendarSyncFault,
} from "./closed-sets.js";
export {
  CALENDAR_TABLES, CALENDAR_DELETE_ORDER, type CalendarTableName, type CalendarTableRow,
} from "./classes.js";
export {
  CALENDAR_UID_MAX_BYTES, CALENDAR_OCCURRENCE_KEY_MAX_BYTES, CALENDAR_ADDRESS_MAX_BYTES, CALENDAR_PROVIDER_ID_MAX_BYTES,
  fitsCalendarBytes,
} from "./bounds.js";
export {
  sweepCalendarConnectionStep, sweepMailboxCalendarStep, CALENDAR_ERASE_BATCH, type CalendarErasureStep,
} from "./erasure.js";
export {
  holdCalendarConnection, holdCalendarMailbox, fencedConnectionWrite, CalendarConnectionGone, type HeldCalendarConnection,
} from "./fence.js";
export {
  CAL_WRITE_OPS, CAL_WRITE_STATES, CALENDAR_WRITE_FAULTS, isCalWriteOp, isCalWriteState, isCalendarWriteFault, asCalendarWriteFault,
  type CalWriteOp, type CalWriteState,
} from "./writes.js";
export {
  CALENDAR_WRITE_LIMITS, CALENDAR_WRITE_PAYLOAD_VERSION, isSeriesRow, isWriteKey, isWriteUuid, parseCalendarAct, parseWritePayload, writePayloadOf,
  type CalendarWritePayload,
} from "./write-act.js";
