/**
 * THE WORDS A CONNECTION AND A CALENDAR STAND AT, AND WHAT EACH COSTS IN TIME.
 *
 * A refusal is stored as the providers' own word (`error_code`, one closed list, no text of a
 * provider beside it) and the wait it causes is written into `next_poll_at`. No word is new here: a
 * connection's `status` keeps the store's four, and a failure count lives in this process only.
 * Everything below is a first value; the preview batch's reading settles it.
 */
import { asCalendarSyncFault, type CALENDAR_SYNC_FAULTS } from "@trafficflow/db/calendar";
import {
  SUBSCRIPTION_INTERVAL_MS, type ProviderRefusal, type ProviderWord,
} from "@ohmail/cal-providers";

/** A refusal as the store keeps it: a member of the providers' list, or `unknown`. */
export type CalendarSyncFault = (typeof CALENDAR_SYNC_FAULTS)[number];

type Same<A, B> = [Exclude<A, B>] extends [never] ? ([Exclude<B, A>] extends [never] ? true : false) : false;
/** The store's list is the providers' list, word for word: a word added on one side alone does not compile. */
const SAME_WORDS: Same<CalendarSyncFault, ProviderRefusal> = true;
void SAME_WORDS;

/** The one door to a stored word: a member of the list, or `unknown`. Never a provider's text. */
export const faultWord = (reason: unknown): CalendarSyncFault => asCalendarSyncFault(reason);

// ── the cadence ──────────────────────────────────────────────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** How often the roster is read when nothing rings: a connection made due waits at most this. */
export const CALENDAR_TICK_MS = 15_000;
/** The least time between two roster reads started by a ring. */
export const CALENDAR_RING_GAP_MS = 1_000;
/** Connections the roster hands over in one read. */
export const ROSTER_LIMIT = 64;
/** Turns run at once. One lane holds a pool connection only for one store transaction. */
export const CALENDAR_LANES = 1;
/** A turn ends at a page boundary after this many pages or this long, and the connection queues again. */
export const TURN_PAGES = 8;
export const TURN_MS = 10_000;
/**
 * No turn outlasts this, whatever call of it is open: three of the request port's own bounds. A
 * turn it ends says `timeout`, and its connection waits as after any other.
 */
export const TURN_HARD_MS = 90_000;
/** Pages one reading may take: a subscription's hundred thousand objects in Google's pages of 250. */
export const MAX_READING_PAGES = 400;
/** Readings kept in memory from one turn to the next. One that is being read is never given up for another. */
export const MAX_OPEN_READINGS = 8;
/** A reading that found no place to be kept is asked again after this. */
export const READING_PLACE_WAIT_MS = 60_000;
/** Connections one roster read is told to pass over: those queued, running or waiting in this process. */
export const ROSTER_EXCEPT_MAX = 1_000;

/** Why a turn's signal ended when its own time ran out. Any other end of it is the worker's stop. */
export class CalendarTurnOverdue extends Error {
  constructor() {
    super("a calendar turn's time ran out");
    this.name = "CalendarTurnOverdue";
  }
}

/** Did the turn's own time run out? A worker that is stopping writes nothing; a turn that ran too long says so. */
export const turnOverdue = (signal: AbortSignal): boolean => signal.aborted && signal.reason instanceof CalendarTurnOverdue;

/** A calendar read by token (Google, Microsoft, CalDAV): asked again after this. */
export const TOKEN_POLL_MS = 5 * MINUTE;
/** The same with a provider's notice channel alive for it: the notice rings, polling is the floor. */
export const TOKEN_POLL_WITH_NOTICES_MS = 60 * MINUTE;
/** The calendars of a connection are listed again at most this often. */
export const LIST_EVERY_MS = HOUR;
/** A connection or a calendar whose word waits for a day. */
export const WAIT_DAY_MS = 24 * HOUR;
/** The calendar off, a provider not served, a parked account: looked at again after this. */
export const OFF_RECHECK_MS = HOUR;
/** A connection's backoff for a word that waits for time: from this, doubling, to the ceiling. */
export const RETRY_FLOOR_MS = MINUTE;
export const RETRY_CEILING_MS = 6 * HOUR;
/** From this many failures in a row a connection reads `failing`. */
export const FAILING_FROM = 3;
/** `page_link_refused` this many times in a row: the calendar is read whole again from no token. */
export const PAGE_LINK_RESET_AFTER = 3;
/** A whole reading that would drop more than half of at least this many stored objects waits for a second one. */
export const MASS_DROP_FLOOR = 20;
/** And the second one is asked after this. */
export const MASS_DROP_RETRY_MS = MINUTE;
/** Microsoft's unknown `gone` reads the window whole again, at most this often per calendar. */
export const FORCED_REREAD_EVERY_MS = 15 * MINUTE;
/** Microsoft's window: days back and ahead of today, and how far it may slide before it is read anew. */
export const MS_WINDOW_DAYS_BACK = 366;
export const MS_WINDOW_DAYS_AHEAD = 731;
export const MS_WINDOW_SLIDE_DAYS = 30;

// ── the plan of the words ────────────────────────────────────────────────────────

/**
 * What a word does, and to what:
 * - `reconnect`: the connection waits for the person (`status = 'reconnect'`); nothing asks again.
 * - `ended`: the calendar stops for good and keeps its copy; a subscription's connection waits for the person too.
 * - `retry`: the connection waits for time, the longer of the provider's wish and its own doubling backoff.
 * - `calendar_day`: the calendar waits a day and keeps its copy; its word is shown.
 * - `connection_day`: the connection reads `failing` at once and waits a day.
 * - `calendar_retry`: the calendar waits, doubling; a page link refused three times reads it from no token.
 * - `off`: no request was made; looked at again in an hour.
 */
export type WordAct = "reconnect" | "ended" | "retry" | "calendar_day" | "connection_day" | "calendar_retry" | "off";

export const WORD_PLAN: Readonly<Record<CalendarSyncFault, WordAct>> = {
  sign_in_refused: "reconnect",
  sign_in_incomplete: "reconnect",
  consent_needed: "reconnect",
  ended: "ended",
  throttled: "retry",
  unavailable: "retry",
  timeout: "retry",
  connection_failed: "retry",
  host_unresolved: "retry",
  unknown: "retry",
  forbidden: "calendar_day",
  not_found: "calendar_day",
  too_large: "calendar_day",
  unreadable: "calendar_day",
  not_a_calendar: "calendar_day",
  address_invalid: "connection_day",
  address_not_allowed: "connection_day",
  port_not_allowed: "connection_day",
  host_changed: "connection_day",
  too_many_redirects: "connection_day",
  redirect_invalid: "connection_day",
  no_service: "connection_day",
  unsupported: "connection_day",
  page_link_refused: "calendar_retry",
  token_gone: "calendar_retry",
  provider_off: "off",
};

/** Does this word act on the whole connection (and end the turn), or on one calendar? */
export function actsOnConnection(word: CalendarSyncFault, provider: string): boolean {
  const act = WORD_PLAN[word];
  if (act === "ended") return provider === "ics";
  return act === "reconnect" || act === "retry" || act === "connection_day" || act === "off";
}

/** The doubling wait of the `failures`-th failure in a row, from the floor to the ceiling. */
export function doublingWait(failures: number): number {
  const n = Math.max(1, Math.min(failures, 30));
  return Math.min(RETRY_CEILING_MS, RETRY_FLOOR_MS * 2 ** (n - 1));
}

/** How long a word makes its connection or calendar wait, from now. `retryAfterMs` is the provider's own wish, at most a day. */
export function waitFor(word: CalendarSyncFault, failures: number, retryAfterMs: number | null): number {
  switch (WORD_PLAN[word]) {
    case "retry":
      return Math.max(retryAfterMs ?? 0, doublingWait(failures));
    case "calendar_retry":
      return Math.max(retryAfterMs ?? 0, doublingWait(failures));
    case "calendar_day":
    case "connection_day":
      return WAIT_DAY_MS;
    case "off":
      return OFF_RECHECK_MS;
    case "reconnect":
    case "ended":
      // Held by a word, never by a time; a day is only the floor of a row nobody reads.
      return WAIT_DAY_MS;
  }
}

/**
 * When a calendar read well is asked again. A subscription at the file's own wish (already held
 * inside the floor and the ceiling by its reader), else every six hours, spread by up to a tenth
 * at random so that one publisher's subscribers do not all ask at once. A calendar read by token
 * every five minutes, or every hour where a notice channel stands for it.
 */
export function pollAfterRead(o: {
  readonly provider: ProviderWord; readonly refreshMs: number | null; readonly notices: boolean; readonly random: () => number;
}): number {
  if (o.provider === "ics") {
    const every = o.refreshMs ?? SUBSCRIPTION_INTERVAL_MS;
    const spread = Math.min(Math.max(o.random(), 0), 1);
    return Math.round(every + spread * every / 10);
  }
  return o.notices ? TOKEN_POLL_WITH_NOTICES_MS : TOKEN_POLL_MS;
}
