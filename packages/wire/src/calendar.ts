/**
 * THE CALENDAR'S ONE HOME ON THE WIRE: the four kinds of record the sync feed carries for it, the
 * record each one is, the words those records use, and what a refused calendar act is answered
 * with. A kind is added here together with its member of {@link CalendarRecords}, its builder for
 * the feed, the list a request may name, the desktop copy's storing case and the device's bound:
 * the compiler refuses the lists, and the walk test refuses a builder or a storing case left out.
 */
import type { ISODateTime } from "./base.js";

// ── times ────────────────────────────────────────────────────────────────────

/**
 * The four kinds of time a calendar writes: a whole day, an instant, a clock time in a named zone,
 * and a clock time with no zone. The calendar core's own words (`EventTime["kind"]`); the services'
 * calendar folder holds the two the same. They never grow, so the store holds them to a CHECK.
 */
export type CalendarTimeKind = "date" | "instant" | "zoned" | "floating";

/**
 * One time of an event, as the store keeps it and the record carries it: its kind, the text the
 * calendar core writes for it (`YYYYMMDD`, `YYYYMMDDTHHMMSS`, the same with `Z`), and for a clock
 * time in a zone the zone's name as written. A builder copies it; nothing on the way parses it.
 */
export interface CalendarTime {
  kind: CalendarTimeKind;
  value: string;
  /** Present exactly when `kind` is `zoned`. */
  zone?: string;
}

/** A calendar day, `YYYY-MM-DD`, the same day for every reader. */
export type CalendarDay = string;

// ── words ────────────────────────────────────────────────────────────────────

/** Which way a connection reaches its calendars. */
export type CalendarProvider = "google" | "caldav" | "microsoft" | "ics";

/**
 * How a connection's sync stands. `reconnect`: its sign-in is no longer accepted and only the
 * person can renew it. `removing`: a disconnect is under way and the rows are going.
 */
export type CalendarConnectionStatus = "active" | "reconnect" | "failing" | "removing";

/**
 * Why a connection or a calendar last failed to read: the providers' one closed list, copied word
 * for word from the readers' own (`cal-providers`, `PROVIDER_REFUSALS`). Never a provider's text.
 */
export type CalendarSyncFault =
  | "sign_in_refused"
  | "sign_in_incomplete"
  | "consent_needed"
  | "forbidden"
  | "not_found"
  | "no_service"
  | "not_a_calendar"
  | "ended"
  | "token_gone"
  | "throttled"
  | "unavailable"
  | "address_invalid"
  | "address_not_allowed"
  | "port_not_allowed"
  | "host_unresolved"
  | "host_changed"
  | "too_many_redirects"
  | "redirect_invalid"
  | "page_link_refused"
  | "timeout"
  | "connection_failed"
  | "too_large"
  | "unreadable"
  | "unsupported"
  | "provider_off"
  | "unknown";

/** What the account may do with a calendar. A word the store does not know reads as `reader`. */
export type CalendarAccess = "owner" | "writer" | "reader" | "busy";

export type CalendarEventStatus = "confirmed" | "tentative" | "cancelled";

/** Where an invitee stands, or the account's own answer. `none`: not answered yet. */
export type CalendarAnswer = "none" | "accepted" | "declined" | "tentative" | "delegated";

export type CalendarInviteeRole = "chair" | "required" | "optional" | "info";

/** How a reminder reaches the person: a notice on the device, or a letter. */
export type CalendarAlarmMethod = "notice" | "mail";

export interface CalendarAlarm {
  minutesBefore: number;
  method: CalendarAlarmMethod;
}

export interface CalendarInvitee {
  address: string;
  name: string | null;
  role: CalendarInviteeRole;
  answer: CalendarAnswer;
}

// ── the records ──────────────────────────────────────────────────────────────

/**
 * One way the account reaches calendars. It never carries a sign-in, a token, a server's path or
 * anything of a subscription's address beyond its host.
 */
export interface CalendarConnectionRecord {
  id: string;
  provider: CalendarProvider;
  /** The person's own name for it. */
  label: string;
  status: CalendarConnectionStatus;
  errorCode: CalendarSyncFault | null;
  /**
   * The mailbox whose sign-in this connection rides, where it rides one. Not `mailboxId`: a
   * device's mailbox cascade takes every record carrying that field, and this record leaves by its
   * own tombstone.
   */
  grantMailboxId: string | null;
  /** The host a CalDAV server or a subscription is read from; `null` for the other two. */
  serverHost: string | null;
  consentedAt: ISODateTime | null;
  lastSyncedAt: ISODateTime | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/** One calendar of a connection. */
export interface CalendarRecord {
  id: string;
  connectionId: string;
  name: string;
  color: string | null;
  access: CalendarAccess;
  shown: boolean;
  isDefault: boolean;
  timeZone: string | null;
  /** The days the last reading covered (`to` inclusive), or `null` when the reading has no window. */
  window: { from: CalendarDay; to: CalendarDay } | null;
  /** The reminders a new event of this calendar starts with. */
  defaultAlarms: CalendarAlarm[];
  lastSyncedAt: ISODateTime | null;
  errorCode: CalendarSyncFault | null;
  updatedAt: ISODateTime;
}

/** A series' rules (`RRULE` values) and its excluded and added dates. */
export interface CalendarRepeat {
  rules: string[];
  excluded: CalendarTime[];
  added: CalendarTime[];
}

/**
 * An event: a series, one changed occurrence of a series, or a single event. Its invitees and its
 * reminders ride inside it, so a device never holds the event without them.
 */
export interface CalendarEventRecord {
  id: string;
  calendarId: string;
  uid: string;
  /** The occurrence this record replaces, in the calendar core's key form; `""` for a series or a single event. */
  recurrenceId: string;
  /** This occurrence and every later one (`RANGE=THISANDFUTURE`). */
  thisAndFuture: boolean;
  sequence: number;
  status: CalendarEventStatus;
  title: string;
  notes: string | null;
  place: string | null;
  callLink: string | null;
  start: CalendarTime;
  /** The end as written; `null` when the event gives a length instead, or neither. */
  end: CalendarTime | null;
  /** The length as written (`PT1H`), never beside an end. */
  duration: string | null;
  /** The first moment the event can touch, a series' first occurrence. */
  startsAt: ISODateTime;
  /** The last moment it can touch; `null` only for a series that does not end. */
  endsAt: ISODateTime | null;
  /** The moment of the occurrence this record replaces; `null` when it replaces none. */
  occurrenceAt: ISODateTime | null;
  repeat: CalendarRepeat | null;
  busy: boolean;
  private: boolean;
  organizer: { address: string; name: string | null } | null;
  /** The account's own answer, where it is invited. */
  myAnswer: CalendarAnswer | null;
  /** An invitation not yet shown on the calendar. */
  heldBack: boolean;
  invitees: CalendarInvitee[];
  alarms: CalendarAlarm[];
  /**
   * The record was too heavy to send whole: times, repeat and title are whole, notes and
   * invitees are empty. The full event stays at the provider and on the server.
   */
  cut: boolean;
  updatedAt: ISODateTime;
}

/** An event a letter seems to propose, served while nobody has decided it. */
export interface CalendarSuggestionRecord {
  id: string;
  messageId: string;
  mailboxId: string;
  /** Why it was proposed: a word. */
  evidence: string;
  proposed: { title: string; start: CalendarTime; end: CalendarTime | null; place: string | null };
  /** The letter's words the proposal was read from, where they are kept. */
  sourceWords: string | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/**
 * Each calendar record kind and the record that travels under it. A kind is added here and
 * nowhere else first: {@link CalendarRecordKind} follows, and every list proved complete against
 * it refuses to compile until it names the new kind.
 */
export interface CalendarRecords {
  calendar_connection: CalendarConnectionRecord;
  calendar: CalendarRecord;
  calendar_event: CalendarEventRecord;
  calendar_suggestion: CalendarSuggestionRecord;
}

/** The kinds of calendar record the sync feed carries. */
export type CalendarRecordKind = keyof CalendarRecords;

// ── the first load ───────────────────────────────────────────────────────────

/**
 * The span of events a first load serves and a device keeps, stated by the server: `daysBack`
 * before today and `daysAhead` after it, at most `maxRows` events, the farthest from today
 * left out first. Absent from a server without the calendar.
 */
export interface CalendarWindow {
  daysBack: number;
  daysAhead: number;
  maxRows: number;
}

// ── the account's switch ─────────────────────────────────────────────────────

/** `GET /calendar/settings`, and what its `PATCH` answers: the account's calendar settings. */
export interface CalendarSettingsWire {
  /** When the account switched its calendar on; null while it is off. */
  enabledAt: ISODateTime | null;
  /** A second time zone a day or a week shows beside the person's own (an IANA name), or null. */
  secondZone: string | null;
  /** Whether a week and a month show the week's number. */
  weekNumbers: boolean;
  /** The hours a day opens on, in minutes after midnight: both set, or neither. */
  dayFromMinute: number | null;
  dayToMinute: number | null;
  /** The calendar a new event goes to unless the person picks one; null when none is chosen. */
  newEventsCalendarId: string | null;
}

/** `PATCH /calendar/settings`: a field present is acted on, and at least one is present. */
export interface CalendarSettingsBody {
  enabled?: boolean;
  secondZone?: string | null;
  weekNumbers?: boolean;
  dayFromMinute?: number | null;
  dayToMinute?: number | null;
  newEventsCalendarId?: string | null;
}

// ── acts ─────────────────────────────────────────────────────────────────────

/** What a person can do to the calendar from a client, as the queue carries it. None yet. */
export type CalendarAct = never;

/**
 * The words a refused calendar act is answered with. `calendar_off`: the account has not switched
 * the calendar on, or this server has none.
 */
export type CalendarReason = "calendar_off";
