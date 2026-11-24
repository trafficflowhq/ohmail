/**
 * THE CALENDAR'S FAMILY, TABLE BY TABLE: total over its ten tables in the mail journal, so a table
 * added there without its row does not compile, and the catalog test holds the store to it. Each
 * row says what its keys run to (composite, `(column, account_id)` onto the parent's
 * `(id, account_id)`), which columns name a row with no key behind them, how far the worker reads
 * it, and which sweep takes it. Its class for row security is the lock's (`row-security/policies.ts`,
 * the one list of a table's class) and its staff columns are `STAFF_SELECT_GRANTS`'; neither is
 * written here a second time. `worker: "roster"` says again what the lock's `WORKER_WIDE_READ` says
 * of a table, in the family's own words; the family's catalog case holds the two equal.
 */
import type { PgTable } from "drizzle-orm/pg-core";
import {
  calAlarms, calAttendees, calCalendars, calConnections, calCredentials, calEvents, calLinks, calSettings,
  calSuggestions, calWrites,
} from "../schema-mail.js";

export type CalendarTableName =
  | "cal_connections" | "cal_credentials" | "cal_calendars" | "cal_events" | "cal_attendees"
  | "cal_alarms" | "cal_writes" | "cal_links" | "cal_suggestions" | "cal_settings";

export interface CalendarTableRow {
  readonly table: PgTable;
  /** Keys inside the family, each `(column, account_id)` onto the parent's `(id, account_id)`. */
  readonly parents: ReadonlyArray<{ readonly column: string; readonly parent: CalendarTableName }>;
  /** A root's key to `accounts`, on `account_id` alone. */
  readonly root?: true;
  /** Columns that name a row with no key behind them, and what they name. Every reader joins them on the account. */
  readonly plain: Readonly<Record<string, string>>;
  /**
   * What the worker reads: `roster` every row before it binds an account, `bound` only inside an
   * account's transaction, `none` nothing.
   */
  readonly worker: "roster" | "bound" | "none";
  /**
   * Which sweep takes it besides the account's: `connection` with the connection it hangs on when
   * that rides an erased mailbox; `mailbox` by its own `mailbox_id`; `account` the account's alone.
   */
  readonly sweep: "connection" | "mailbox" | "account";
}

export const CALENDAR_TABLES: Readonly<Record<CalendarTableName, CalendarTableRow>> = {
  cal_connections: {
    table: calConnections, parents: [], root: true,
    plain: { mailbox_id: "mailboxes" }, worker: "roster", sweep: "mailbox",
  },
  cal_credentials: {
    table: calCredentials, parents: [{ column: "connection_id", parent: "cal_connections" }],
    plain: {}, worker: "none", sweep: "connection",
  },
  cal_calendars: {
    table: calCalendars, parents: [{ column: "connection_id", parent: "cal_connections" }],
    plain: {}, worker: "bound", sweep: "connection",
  },
  cal_events: {
    table: calEvents, parents: [{ column: "calendar_id", parent: "cal_calendars" }],
    plain: {}, worker: "none", sweep: "connection",
  },
  cal_attendees: {
    table: calAttendees, parents: [{ column: "event_id", parent: "cal_events" }],
    plain: {}, worker: "none", sweep: "connection",
  },
  cal_alarms: {
    table: calAlarms,
    parents: [{ column: "event_id", parent: "cal_events" }, { column: "calendar_id", parent: "cal_calendars" }],
    plain: {}, worker: "none", sweep: "connection",
  },
  cal_writes: {
    table: calWrites, parents: [{ column: "calendar_id", parent: "cal_calendars" }],
    plain: { event_id: "cal_events" }, worker: "bound", sweep: "connection",
  },
  cal_links: {
    table: calLinks, parents: [],
    plain: { message_id: "messages", mailbox_id: "mailboxes" }, worker: "none", sweep: "mailbox",
  },
  cal_suggestions: {
    table: calSuggestions, parents: [],
    plain: { message_id: "messages", mailbox_id: "mailboxes", event_id: "cal_events" }, worker: "none", sweep: "mailbox",
  },
  cal_settings: {
    table: calSettings, parents: [], root: true,
    plain: { new_events_calendar_id: "cal_calendars" }, worker: "none", sweep: "account",
  },
};

/** The family's tables, children before the rows they hang on: the order every sweep deletes in. */
export const CALENDAR_DELETE_ORDER: readonly CalendarTableName[] = [
  "cal_attendees", "cal_alarms", "cal_writes", "cal_suggestions", "cal_links", "cal_events",
  "cal_calendars", "cal_credentials", "cal_connections", "cal_settings",
];
