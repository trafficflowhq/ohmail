/**
 * `@ohmail/organizer/calendar-sync` — the calendar's passes, as the worker runs them and as a
 * desktop's engine will: handed its providers, its pool, its clock and its zones, reading no
 * environment and starting no timer of its own. The worker's start file (`../start/calendar.ts`)
 * composes it; nothing here knows which program it runs in.
 */
/* The pass itself has a door of its own (`@ohmail/organizer/calendar-sync-pass`): a pass is declared once and exported where it is declared. */
export { calendarTurnFailed, isProviderWord, parkConnection } from "./sync-pass.js";
export { loadDueConnections, type ShardRule } from "./roster.js";
export {
  calendarPool, inConnection, passDb, LIVE_STATUSES,
  type CalendarPool, type ConnectionDb, type ConnectionKey, type ConnectionTx, type HeldConnection,
} from "./connection.js";
export { newCalendarSyncMemory } from "./memory.js";
export { rowsOfObject, occurrenceKey, uidOf, type EventRowValues, type InviteeValues, type AlarmValues, type MappedRow, type MapContext, type MapRefusal } from "./map.js";
export * from "./words.js";
export * from "./types.js";
