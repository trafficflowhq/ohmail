/**
 * WHAT THE PAGE LEAVES THE PHONE'S NATIVE SIDE: one record, version 1, written whole each time.
 * Alerts and widgets read it with the app closed and no connection. The page has already applied
 * every choice and rule (which alerts this device rings, what a private or a hidden title says);
 * the native side holds no setting and no rule, writes the words for the numbers, and draws
 * nothing once `scope` is no longer the signed-in one. Kept in the app's own files, outside
 * backups, and deleted at sign-out. Whatever writes the file reads the record closed first
 * (`readCalendarSnapshot`, `closed.ts`): the file never holds a member that is not listed here.
 */
import type { Clock, EventLabel, NoticeDate } from "./kinds.js";
import type { NoticeAhead } from "./emitter.js";

export const CALENDAR_SNAPSHOT_VERSION = 1;
/** The file's name in the app's own files folder. */
export const CALENDAR_SNAPSHOT_FILE = "ohcal-snapshot.json";
/** The days a widget lists: today and two more. */
export const SNAPSHOT_DAYS = 3;
/** The most events one listed day carries; `more` counts the rest. */
export const SNAPSHOT_DAY_EVENTS_MAX = 12;

export interface SnapshotEvent {
  readonly eventId: string;
  readonly label: EventLabel;
  readonly startMs: number;
  /** `null` where the event states no end. */
  readonly endMs: number | null;
  readonly allDay: boolean;
  /** The person has not answered its invitation yet. */
  readonly toAnswer: boolean;
}

export interface SnapshotDay {
  readonly year: number;
  readonly date: NoticeDate;
  /** In the order a day lists them: all day first, then by start. */
  readonly events: readonly SnapshotEvent[];
  /** Events of the day that are not listed. */
  readonly more: number;
}

/** The month a widget draws as a grid: which of its days hold something. */
export interface SnapshotMonth {
  readonly year: number;
  readonly month: number;
  /** Days of the month, ascending, each once. */
  readonly marked: readonly number[];
}

/** The daily summary to ring, or `null` while its switch is off. */
export interface SnapshotSummary {
  readonly atMs: number;
  readonly events: number;
  readonly first: Clock | null;
  readonly toAnswer: number;
}

export interface CalendarSnapshot {
  readonly v: typeof CALENDAR_SNAPSHOT_VERSION;
  /** The account's scope it was written under. */
  readonly scope: string;
  /** Milliseconds since the epoch. */
  readonly writtenAt: number;
  /** The zone the days and the month were laid out in, by its name. */
  readonly zone: string;
  /** Only the alerts this device rings, under `scope`: the set a surface is handed (`aheadSet`), by its alerts. */
  readonly alerts: readonly NoticeAhead[];
  /** Today first. */
  readonly days: readonly SnapshotDay[];
  readonly month: SnapshotMonth;
  /** Invitations waiting for the person's answer. */
  readonly toAnswer: number;
  readonly summary: SnapshotSummary | null;
}
