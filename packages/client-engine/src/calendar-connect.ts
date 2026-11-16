/**
 * THE CALENDAR'S CONNECT DOOR ON A DEVICE: how a setup reaches our server's six routes. Direct calls,
 * never the durable queue: what a person types to connect a calendar is a secret, and a queued act is
 * a stored record. So nothing here keeps a request. It is sent once, under the key the press made, and
 * what our server made of it is its answer; a refusal throws as every write's does, with our server's
 * word in `code` and, for a refused address or a way that is off, the closed word in `details.fault`.
 *
 * WHERE THESE ROUTES ARE CARRIED: our server's own door, and no relay. A desktop paired to an account
 * and a phone ask through a door that does not carry them, so `calendarWays()` answers no way there
 * and the other five are refused as a route that is not there (404).
 */
import type {
  Assert, CalendarConnectBody, CalendarConnectionRecord, CalendarPatchBody, CalendarRecord, CalendarSignInBody, CalendarWay, Complete,
} from "@ohmail/wire";

/** Every way this build knows, whether or not a server offers it. */
export const CALENDAR_WAYS = ["icloud", "caldav", "ics", "google", "microsoft"] as const satisfies readonly CalendarWay[];
type _CalendarWaysComplete = Assert<Complete<CalendarWay, typeof CALENDAR_WAYS>>;

const KNOWN: ReadonlySet<unknown> = new Set(CALENDAR_WAYS);

/**
 * The ways an answer names, as this build knows them, each once and in our server's order. A word
 * this build does not know is dropped, and an answer that is no list names no way: a client holds
 * no list of its own to fall back to.
 */
export function calendarWaysOf(ways: unknown): CalendarWay[] {
  if (!Array.isArray(ways)) return [];
  return [...new Set(ways.filter((w): w is CalendarWay => KNOWN.has(w)))];
}

/** How a device reaches the connect door. The engine's HTTP adapter is one. */
export interface CalendarConnectTransport {
  /** `GET /calendar/connect`. No way on any failure: a door that does not carry the route, a server without a calendar, no network. */
  calendarWays(): Promise<CalendarWay[]>;
  /** `POST /calendar/connections` under `key`, one key a press. `202`: sealed, and tried by our server's worker. */
  connectCalendar(ask: CalendarConnectBody, key: string): Promise<{ readonly connection: CalendarConnectionRecord; readonly seq: number | null }>;
  /**
   * `DELETE /calendar/connections/:id`. `removed: false`: its records are still going, and NOTHING else continues the
   * removal: call again at once until it answers `removed: true`. No worker pass finishes a connection left half removed.
   */
  removeCalendarConnection(connectionId: string): Promise<{ readonly removed: boolean; readonly seq: number | null }>;
  /** `POST /calendar/connections/:id/check`. Refused `rate_limited` inside a minute of the last one, or of a sign-in typed again. */
  checkCalendarConnection(connectionId: string): Promise<{ readonly connection: CalendarConnectionRecord; readonly seq: number | null }>;
  /** `POST /calendar/connections/:id/sign-in`: the sign-in typed again, whole. Tried at once, or within a minute where a check or a sign-in came inside the last one. */
  signInCalendarAgain(connectionId: string, signIn: CalendarSignInBody): Promise<{ readonly connection: CalendarConnectionRecord; readonly seq: number | null }>;
  /** `PATCH /calendar/calendars/:id`. `seq` is `null` when nothing changed. */
  setCalendar(calendarId: string, patch: CalendarPatchBody): Promise<{ readonly calendar: CalendarRecord; readonly seq: number | null }>;
}
