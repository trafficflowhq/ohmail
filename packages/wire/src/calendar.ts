/**
 * THE CALENDAR'S ONE HOME ON THE WIRE: the four kinds of record the sync feed carries for it, the
 * record each one is, the words those records use, and what a refused calendar act is answered
 * with. A kind is added here together with its member of {@link CalendarRecords}, its builder for
 * the feed, the list a request may name, the desktop copy's storing case and the device's bound:
 * the compiler refuses the lists, and the walk test refuses a builder or a storing case left out.
 */
import type { InvitationProposalTimes } from "./invitations.js";
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
  /** Rule shapes the server has verified for creating events on this connection. */
  repeatShapes?: readonly string[];
  consentedAt: ISODateTime | null;
  lastSyncedAt: ISODateTime | null;
  /** Scheduled check time. Older servers and saved device records may omit it. */
  nextPollAt?: ISODateTime | null;
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
  timeZone: string | null;
  /** The days the last reading covered (`to` inclusive), or `null` when the reading has no window. */
  window: { from: CalendarDay; to: CalendarDay } | null;
  nativeMove?: true;
  /** The CalDAV server sends invitations when this calendar stores an event with guests. */
  autoSchedule?: true;
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
  /** An owned series whose organizer is confirmed by the connection, or a legacy personal series. */
  personalSeries?: true;
  /** Delete scopes proven by the service for this stored series. */
  deleteScopes?: readonly CalendarRemoveScope["kind"][];
  /** Complete stored CalDAV audience, including components outside the sync window. */
  deleteMembers?: readonly {
    readonly at: number | null;
    readonly range: boolean;
    readonly organizer: string | null;
    readonly guests: readonly { readonly address: string; readonly name: string | null }[];
  }[];
  busy: boolean;
  private: boolean;
  organizer: { address: string; name: string | null } | null;
  /** Whether CalDAV evidence verifies organizer authority. True also identifies a verified cloud organizer. */
  ownOrganizer?: boolean;
  /** A shared CalDAV copy with guests whose stored object has no organizer. */
  sharedWithoutOrganizer?: true;
  /** The account's own answer, where it is invited. */
  myAnswer: CalendarAnswer | null;
  /** The mailed answer on a personal copy. The provider sees a guest-free event. */
  mailAnswer?: "accepted" | "tentative" | "declined";
  /** Cancelled or declined occurrences removed from this account’s calendar. The empty key covers the record or series. */
  removedOccurrences?: readonly string[];
  /** A verified copy where this account can hide an invitation. */
  hideAttendee?: string;
  /** Occurrences explicitly hidden without answering. The empty key covers the record or series. */
  hiddenOccurrences?: readonly string[];
  /** An invitation not yet shown on the calendar. */
  heldBack: boolean;
  invitees: CalendarInvitee[];
  alarms: CalendarAlarm[];
  /**
   * The record was too heavy to send whole: times, repeat and title are whole, notes and
   * invitees are empty. The full event stays at the provider and on the server.
   */
  cut: boolean;
  /** Stored content fits the fields a portable move preserves. */
  portableCopy?: true;
  /** The Google provider allows native moves for this event type. */
  googleDefaultEvent?: true;
  /**
   * The person's writes to this event that the provider has not taken yet, or refused: oldest
   * first. The record itself is the provider's copy; what waits rides here, beside it.
   */
  writes: CalendarWriteMark[];
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
/** The standalone calendar's feed excludes proposals read from letters. */
export type CalendarOnlyRecordKind = Exclude<CalendarRecordKind, "calendar_suggestion"> | "settings";

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
  /** The account has no saved calendar settings yet. */
  unconfigured?: true;
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

// ── connecting ───────────────────────────────────────────────────────────────

/**
 * A way an account connects a calendar. `icloud` is CalDAV at Apple's own address with the Apple
 * Account and an app password; `caldav` any other server by its address; `ics` a subscription by
 * address. `google` and `microsoft` sign in at their provider, and are offered only where the
 * server says so.
 */
export type CalendarWay = "icloud" | "caldav" | "ics" | "google" | "microsoft";

/** A mailbox whose saved iCloud sign-in can be used for a new calendar connection. */
export interface CalendarMailboxSource {
  id: string;
  address: string;
}

/**
 * `GET /calendar/connect`: where the account's connecting stands on this server.
 *
 * `ways`: the ways offered to the account now. A way that is absent is off, and while the
 * account's calendar is off there is none.
 *
 * `connections`: the connections the account holds, as the feed's own records, oldest first,
 * WHETHER ITS CALENDAR IS ON OR OFF. The feed sends no calendar record while the calendar is off,
 * so this is what a settings pane lists then: a person who switched the calendar off still sees
 * what is kept for them, and can have each removed.
 */
export interface CalendarConnectWire {
  ways: CalendarWay[];
  connections: CalendarConnectionRecord[];
  icloudMailboxes?: CalendarMailboxSource[];
  /** Mailboxes whose saved sign-in a retained calendar connection was created from. */
  linkedMailboxIds?: string[];
}

/**
 * `POST /calendar/connections`: what a person typed, sent once. `connectionId` is a uuid the device
 * makes and the server adopts, so the device knows which record to wait for. `password`, and a
 * subscription's `address` whole (whoever has it reads the calendar), are secrets: the server seals
 * them and no route reads them back; of an address only its host is ever answered.
 */
export type CalendarConnectBody =
  | { way: "icloud"; connectionId: string; user: string; password: string }
  | { way: "icloud"; connectionId: string; fromMailbox: string }
  | { way: "caldav"; connectionId: string; server: string; user: string; password: string }
  | { way: "ics"; connectionId: string; address: string };

/**
 * `POST /calendar/connections/:id/sign-in`: the connection's sign-in typed again, whole. A CalDAV
 * connection takes a user and a password, a subscription its address; the other shape is refused.
 * A server is named by no request for a connection that stands: a password typed again is kept for
 * the server the connection was typed with at its connect. Where the server can no longer tell
 * which that is, it keeps nothing and refuses with `sign_in_incomplete`
 * ({@link CalendarConnectRefusal}): the connection is removed and connected again.
 */
export type CalendarSignInBody = { user: string; password: string } | { address: string };

/**
 * `PATCH /calendar/calendars/:id`: a field present is acted on, and at least one is present.
 * `shown` is taken for every calendar. `name` and `color` (`#rrggbb`, or null for none) are taken
 * for a subscription's calendar only: where a provider lists its calendars, both are the provider's.
 */
export interface CalendarPatchBody {
  shown?: boolean;
  name?: string;
  color?: string | null;
}

/** `DELETE /calendar/connections/:id`: `false` (202) while the connection's records are still going. */
export interface CalendarRemovalWire {
  removed: boolean;
}

/**
 * What a refused connect or sign-in names in its envelope's `details`: the word a client has a
 * sentence for. An address refused by its shape says which rule, a way that is switched off says
 * `provider_off`, and a password typed again for a connection that has to be connected again
 * says `sign_in_incomplete`.
 */
export interface CalendarConnectRefusal {
  fault: CalendarSyncFault;
}

// ── acts ─────────────────────────────────────────────────────────────────────

/**
 * Why a write did not reach the provider, or was not carried out there: the reading's words, the
 * writers' own, and the queue's. Never a provider's text.
 */
export type CalendarWriteFault =
  | CalendarSyncFault
  /** The provider's copy changed since the copy the change was made on. Nothing was overwritten. */
  | "version_stale"
  /** No version to make the change against, and none could be read. Nothing was sent. */
  | "version_unknown"
  /** The event is no longer at the provider. */
  | "event_gone"
  /** The provider refused the write: the calendar can be looked at, not written. */
  | "read_only"
  /** The provider's object was read with something left out, so it is not written back. */
  | "left_out"
  | "invitees_unsupported"
  | "repeat_unsupported"
  /** A field the provider would not keep as written. */
  | "field_unwritable"
  /** An earlier write of the same event was refused, so this one was not sent. */
  | "earlier_refused"
  /** The recorded act is no shape this version writes. */
  | "content_refused"
  /** Too old, or tried too often, to be sent late. */
  | "expired"
  /** A provider action may have sent the reply, but its outcome could not be confirmed. */
  | "answer_unconfirmed"
  | "move_copy_left"
  | "move_unresolved"
  | "move_destination_unavailable";

/** One invitee of an event as a person writes it. */
export interface CalendarWriteInvitee {
  address: string;
  name: string | null;
  role: "required" | "optional";
}

/** An event's fields as a person writes them: times as the store keeps them, an end always. */
export interface CalendarEventFields {
  title: string;
  start: CalendarTime;
  end: CalendarTime;
  notes: string | null;
  place: string | null;
  /** A call's link, https only. */
  callLink: string | null;
  busy: boolean;
  private: boolean;
  /** One `RRULE` value, or `null` for an event that does not repeat. */
  repeat: string | null;
  invitees: CalendarWriteInvitee[];
  /** Reminders, each in minutes before the start. */
  alarms: number[];
}

/**
 * Which part of an event a change or a removal is about: the record whole, one occurrence of a
 * series, or one occurrence and every later one. `at` is the occurrence's key as a record writes
 * it (`recurrenceId`). A change to the later ones makes a new series, `newEventId`.
 */
export type CalendarChangeScope =
  | { kind: "record" }
  | { kind: "occurrence"; at: string }
  | { kind: "following"; at: string; newEventId: string };
export type CalendarRemoveScope =
  { kind: "record" } | { kind: "occurrence"; at: string } | { kind: "following"; at: string };

/**
 * What an act on an event the device holds names: the event, the record's `updatedAt` as the device
 * held it (`base`), and the key of the device's previous act on the same event (`after`), so that a
 * change is only ever written onto the copy it was made on.
 */
export interface CalendarEventBase {
  eventId: string;
  base: ISODateTime;
  after?: string;
}

/**
 * A person's act on one event, as the queue carries it and the server records it. Ids are the
 * store's rows (`eventId` of a new event, and `newEventId`, are uuids the device makes and the
 * server adopts); no act names a provider's id, an address or a version.
 */
/** The attendee and calendar of the invitation the person reviewed. */
export interface CalendarAttendeeCopy {
  readonly calendarId: string;
  readonly attendee: string;
}

export type CalendarEventAct =
  | {
      kind: "calendar_event_create";
      eventId: string;
      calendarId: string;
      event: CalendarEventFields;
      invitationMessageId?: string;
      /** The rule was selected in the new event editor. */
      repeatSelected?: true;
    }
  | (CalendarEventBase & {
      kind: "calendar_event_update";
      scope: CalendarChangeScope;
      change: Partial<CalendarEventFields>;
      /** The invitation letter whose reply is being filed on this personal copy. */
      invitationMessageId?: string;
      /** Apply the chosen scope only while the provider's series remains personal. */
      personalSeries?: true;
      /** The people this editor expects the provider to notify, checked under the same tag as its write. */
      audience?: { readonly organizer: string | null; readonly guests: readonly string[] };
    })
  | (CalendarEventBase & {
      kind: "calendar_event_delete";
      /** Remove a cancelled or declined event from this account’s calendar without writing to the provider. */
      localOnly?: true;
      /** Hide an active own attendee copy in ohcal without changing its RSVP. */
      hide?: true;
      copy?: CalendarAttendeeCopy;
      /** A cancellation letter to verify when the provider still shows an active event. */
      cancelledBy?: string;
      scope: CalendarRemoveScope;
      cancellationMessage?: string;
      /** Audience confirmed against the stored object for this scope. */
      audience?: { readonly organizer: string | null; readonly guests: readonly string[] };
    })
  | (CalendarEventBase & {
      kind: "calendar_event_move";
      toCalendarId: string;
      copyThenRemove?: true;
      /** Guests confirmed before moving the event to another calendar. */
      audience?: { readonly organizer: string | null; readonly guests: readonly string[] };
    })
  | (CalendarEventBase & {
      kind: "calendar_event_answer";
      scope: { kind: "record" } | { kind: "occurrence"; at: string };
      answer: "accepted" | "tentative" | "declined";
      copy?: CalendarAttendeeCopy;
    });

export type CalendarProposalAct = {
  recordId: string;
  base: ISODateTime;
  occurrence: string;
} & (
  | ({ kind: "calendar_event_propose" } & InvitationProposalTimes)
  | { kind: "calendar_proposal_keep"; messageId: string }
);

/**
 * What a person can do to the calendar from a client, as the queue carries it: an act on an
 * event, or a word on a write that was refused (send it again; let it go).
 */
export type CalendarAct =
  | CalendarEventAct
  | { kind: "calendar_write_retry"; writeId: string; resendReply?: true }
  | { kind: "calendar_write_dismiss"; writeId: string };

/**
 * The words a refused calendar act is answered with. `calendar_off`: the account has not switched
 * the calendar on, or this server has none. `calendar_read_only`: the calendar or the event takes
 * no such write (a subscription, a calendar shared to look at, an invitation the account does not
 * organise). `calendar_writes_full`: too many writes are waiting. `calendar_write_left`: the write
 * is under way or done and can no longer be let go. `calendar_connection_stopped`: the calendar's
 * connection waits for the person (signed out, being removed).
 */
export type CalendarReason =
  | "calendar_off"
  | "calendar_read_only"
  | "calendar_writes_full"
  | "calendar_write_left"
  | "calendar_connection_stopped";

/**
 * A write that waits for the provider, or that it refused, as the event's record carries it.
 * `act` is the act as recorded; `null` only where the record was cut to fit. `part` is 2 for the
 * second half of a two-part act whose first half is done (a series ended, the new one not made).
 */
export interface CalendarWriteMark {
  id: string;
  key: string;
  state: "pending" | "refused";
  reason: CalendarWriteFault | null;
  act: CalendarEventAct | null;
  part: 1 | 2 | null;
  at: ISODateTime;
  /** This reply has been dispatched and is awaiting the provider's confirmation. */
  replyUnconfirmed?: true;
}

/** What a recorded write stands at, as the route answers it. */
export interface CalendarWriteReceipt {
  id: string;
  key: string;
  state: "pending" | "applied" | "refused";
  reason: CalendarWriteFault | null;
}

/**
 * What a calendar write's route answers: where the write stands (`null` for one let go), and the
 * records of the events it touched, each with its marks, so a device passes from its own queue to
 * the record without a gap.
 */
export interface CalendarWriteAnswer {
  write: CalendarWriteReceipt | null;
  events: CalendarEventRecord[];
}
