/**
 * THE CALENDAR'S CLOSED LISTS, each the one constant its write door and the store's CHECK read.
 *
 * Three grow with the product (a connection's provider, status and error code): the store holds
 * each to the one-word shape (`closed-set-shape.ts`) and the write doors hold the members. The
 * four kinds of time never grow and are a CHECK on the server. All of them are the server's alone:
 * a phone's own store has no calendar table, so none is carried there. `closed-set-parity.test.ts`
 * reads this list beside the mail's `CLOSED_SETS`.
 */
import type {
  Assert, CalendarConnectionStatus, CalendarProvider, CalendarSyncFault, CalendarTimeKind, Complete,
} from "@ohmail/wire";
import { GROWING_LIST_SHAPE } from "../closed-set-shape.js";
import type { ClosedSet } from "../closed-sets.js";

export const CALENDAR_PROVIDERS = ["google", "caldav", "microsoft", "ics"] as const satisfies readonly CalendarProvider[];
type _Providers = Assert<Complete<CalendarProvider, typeof CALENDAR_PROVIDERS>>;

export const CALENDAR_CONNECTION_STATUSES = [
  "active", "reconnect", "failing", "removing",
] as const satisfies readonly CalendarConnectionStatus[];
type _Statuses = Assert<Complete<CalendarConnectionStatus, typeof CALENDAR_CONNECTION_STATUSES>>;

/** The providers' refusal words, as `cal-providers`' `PROVIDER_REFUSALS` writes them. */
export const CALENDAR_SYNC_FAULTS = [
  "sign_in_refused", "sign_in_incomplete", "consent_needed",
  "forbidden", "not_found", "no_service", "not_a_calendar", "ended", "token_gone",
  "throttled", "unavailable",
  "address_invalid", "address_not_allowed", "port_not_allowed", "host_unresolved",
  "host_changed", "too_many_redirects", "redirect_invalid", "page_link_refused",
  "timeout", "connection_failed", "too_large", "unreadable",
  "unsupported", "provider_off",
  "unknown",
] as const satisfies readonly CalendarSyncFault[];
type _Faults = Assert<Complete<CalendarSyncFault, typeof CALENDAR_SYNC_FAULTS>>;

export const CALENDAR_TIME_KINDS = ["date", "instant", "zoned", "floating"] as const satisfies readonly CalendarTimeKind[];
type _TimeKinds = Assert<Complete<CalendarTimeKind, typeof CALENDAR_TIME_KINDS>>;

const memberOf = <T extends string>(list: readonly T[]) => {
  const set: ReadonlySet<string> = new Set(list);
  return (v: unknown): v is T => typeof v === "string" && set.has(v);
};

export const isCalendarProvider = memberOf(CALENDAR_PROVIDERS);
export const isCalendarConnectionStatus = memberOf(CALENDAR_CONNECTION_STATUSES);
export const isCalendarSyncFault = memberOf(CALENDAR_SYNC_FAULTS);
export const isCalendarTimeKind = memberOf(CALENDAR_TIME_KINDS);

/** A stored or received refusal word as a word of the list: one this build does not know reads as `unknown`. */
export function asCalendarSyncFault(word: unknown): CalendarSyncFault {
  return isCalendarSyncFault(word) ? word : "unknown";
}

const GROWS = "grows with the product: a provider, a state or a refusal word is added without a "
  + "change to any table, and the staff role reads the column, so no sentence may stand in it";

export const CALENDAR_CLOSED_SETS: readonly ClosedSet[] = [
  {
    constraint: "cal_connections_provider_shape", table: "cal_connections", column: "provider", nullable: false,
    members: CALENDAR_PROVIDERS, isMember: isCalendarProvider, kind: "shape", shape: GROWING_LIST_SHAPE,
    why: `the way a connection reaches its calendars; ${GROWS}`,
  },
  {
    constraint: "cal_connections_status_shape", table: "cal_connections", column: "status", nullable: false,
    members: CALENDAR_CONNECTION_STATUSES, isMember: isCalendarConnectionStatus, kind: "shape",
    shape: GROWING_LIST_SHAPE, why: `how a connection's sync stands; ${GROWS}`,
  },
  {
    constraint: "cal_connections_error_code_shape", table: "cal_connections", column: "error_code", nullable: true,
    members: CALENDAR_SYNC_FAULTS, isMember: isCalendarSyncFault, kind: "shape", shape: GROWING_LIST_SHAPE,
    why: `why a connection last failed to read, the providers' one refusal list; ${GROWS}`,
  },
  {
    constraint: "cal_events_start_kind_closed", table: "cal_events", column: "start_kind", nullable: false,
    members: CALENDAR_TIME_KINDS, isMember: isCalendarTimeKind, kind: "immutable",
    why: "the four kinds of time the calendar format has (a day, an instant, a clock time in a zone "
      + "and one in none); a fifth would be another standard, not a wider list",
  },
  {
    constraint: "cal_events_end_kind_closed", table: "cal_events", column: "end_kind", nullable: true,
    members: CALENDAR_TIME_KINDS, isMember: isCalendarTimeKind, kind: "immutable",
    why: "the same four kinds for an end as written; empty when the event gives a length or "
      + "nothing, which the end's other columns follow",
  },
];
