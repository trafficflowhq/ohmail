/**
 * THE CALENDAR'S CONNECT DOOR ON A DEVICE: how a setup reaches our server's six routes. Direct calls,
 * never the durable queue: what a person types to connect a calendar is a secret, and a queued act is
 * a stored record. So nothing here keeps a request. It is sent once, under the key the press made, and
 * what our server made of it is its answer; a refusal throws as every write's does, with our server's
 * word in `code` and, for a refused address or a way that is off, the closed word in `details.fault`.
 *
 * WHERE THESE ROUTES ARE CARRIED: our server's own door, and every relay to it. A desktop paired to an
 * account and a phone ask through a relay that forwards all six, each as it was sent: what was typed
 * is in the one request's body, and a relay keeps none of it. A door of a server that keeps no calendar
 * answers 404: `calendarWays()` names no way there.
 */
import type {
  Assert, CalendarConnectBody, CalendarConnectionRecord, CalendarPatchBody, CalendarRecord, CalendarSettingsBody, CalendarSettingsWire, CalendarSignInBody, CalendarWay, Complete,
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
  /** `GET /calendar/connect`, its ways. No way on any failure: a door that does not carry the route, a server without a calendar, no network. */
  calendarWays(): Promise<CalendarWay[]>;
  /**
   * `GET /calendar/connect`, its connections: what the account holds on our server, oldest first, WHETHER ITS CALENDAR IS ON
   * OR OFF. While the calendar is off the feed sends no calendar record and a device holds none: a settings pane lists these
   * then, each with Remove. A read that failed throws, and so does an answer that names no list (a server whose door is older
   * than this read): "nothing is connected" is said only where our server said it.
   */
  calendarConnections(): Promise<CalendarConnectionRecord[]>;
  /** `POST /calendar/connections` under `key`, one key a press. `202`: sealed, and tried by our server's worker. */
  connectCalendar(ask: CalendarConnectBody, key: string): Promise<{ readonly connection: CalendarConnectionRecord; readonly seq: number | null }>;
  /**
   * `DELETE /calendar/connections/:id`. `removed: false`: its records are still going, and NOTHING else continues the
   * removal: call again at once until it answers `removed: true`. No worker pass finishes a connection left half removed.
   */
  removeCalendarConnection(connectionId: string): Promise<{ readonly removed: boolean; readonly seq: number | null }>;
  /** `POST /calendar/connections/:id/check`. Refused `rate_limited` inside a minute of the last one, or of a sign-in typed again. */
  checkCalendarConnection(connectionId: string): Promise<{ readonly connection: CalendarConnectionRecord; readonly seq: number | null }>;
  /**
   * `POST /calendar/connections/:id/sign-in`: the sign-in typed again, whole. Tried at once, or within a minute where a check or
   * a sign-in came inside the last one. A password refused with `details.fault` `sign_in_incomplete` can not be typed again for
   * this connection: it is removed and connected again.
   */
  signInCalendarAgain(connectionId: string, signIn: CalendarSignInBody): Promise<{ readonly connection: CalendarConnectionRecord; readonly seq: number | null }>;
  /** `PATCH /calendar/calendars/:id`. `seq` is `null` when nothing changed. */
  setCalendar(calendarId: string, patch: CalendarPatchBody): Promise<{ readonly calendar: CalendarRecord; readonly seq: number | null }>;
}

/** The connection and settings capabilities a host can hand to the calendar. */
export type CalendarSetupTransport = Omit<CalendarConnectTransport, "calendarConnections"> & {
  calendarConnections?: CalendarConnectTransport["calendarConnections"];
  saveCalendarSettings?(body: CalendarSettingsBody): Promise<CalendarSettingsWire>;
};

export interface CalendarSetupAdapter {
  calendarSetupTransport(): CalendarSetupTransport | null;
}
