/**
 * The one port every provider stands behind: the same three requests for Google, CalDAV, Microsoft
 * and a subscription by address, answered in the calendar core's types, and beside the reader the
 * writer of the three that take writes. Types only.
 *
 * A reader answers; it does not throw. A provider's refusal, a network's and an address the gate
 * refuses are all an `Answer` with a word of the closed list. A throw out of a reader is a fault of
 * this program. A writer is held to the same.
 *
 * A writer is handed what a reading handed out (an object's `id`, its `version`, its `text`) and a
 * typed draft; it is never handed an address, a header or a query. An `upsert`'s `version` is the
 * precondition of a change, its `text` the object a change is written back from, a calendar says
 * whether it is `writable`, and a checked sign-in names the `principal`.
 */
import type { CalEvent, CalendarRefusal, EventTime, Instant, ReadRefusal, RRule } from "@ohmail/cal-core";
import type { ProviderRefusal, WriteRefusal } from "./refusals.js";

/** The provider's word, as a connection is stored with it. */
export type ProviderWord = "google" | "caldav" | "microsoft" | "ics";

/** Now, in epoch milliseconds. Always handed in: nothing in this package reads a clock of its own. */
export interface Clock {
  now(): number;
}

/**
 * A sign-in for one call. Each kind hands its value out through a function, so that a credential
 * that is logged or serialised by mistake shows nothing.
 */
export type Credential =
  /** Google, Microsoft. The caller trades its lasting sign-in for a short one, once a pass, and keeps it for that pass only. */
  | { readonly kind: "bearer"; accessToken(signal: AbortSignal): Promise<{ readonly ok: true; readonly token: string } | { readonly ok: false; readonly reason: ProviderRefusal; readonly retryAfterMs: number | null }> }
  /** CalDAV. Revealed only where the Authorization line is built, and only for a host it may travel to. */
  | { readonly kind: "basic"; readonly user: string; password(): string }
  /** A subscription: the address is the secret. */
  | { readonly kind: "address"; url(): string };

export interface Connection {
  readonly provider: ProviderWord;
  readonly credential: Credential;
  /** CalDAV: the address the person typed. `null` for the other three. */
  readonly start: string | null;
}

/** One calendar: the provider's id of it, or for CalDAV its collection's address. A subscription has one calendar; its id is not read. */
export interface CalendarRef {
  readonly id: string;
}

export interface CalendarInfo {
  readonly id: string;
  readonly name: string | null;
  readonly color: string | null;
  readonly writable: boolean;
  /** Whether changes can be asked by token. Where not, `readChanges` answers the whole set each time. */
  readonly byToken: boolean;
  /** The zone the calendar is meant to be read in, where the provider names one. */
  readonly zone: string | null;
}

/** Where a calendar's reading stands. Opaque to every caller, and at most `TOKEN_MAX_CHARS` long. */
export interface ChangeToken {
  readonly provider: ProviderWord;
  readonly value: string;
}

export interface PageRequest {
  /** Records wanted, at most `MAX_PAGE_LIMIT`. A subscription is one text and answers in one page whatever is asked. */
  readonly limit: number;
  /** The `more` cursor of the page before, or `null` for the first. */
  readonly cursor: string | null;
  /** Microsoft only: the days asked for. A wider window is a new reading from no token. */
  readonly window: { readonly start: Instant; readonly end: Instant } | null;
}

export type ChangeItem =
  /**
   * A stored object, new or changed. `id` is the provider's id of it: Google's and Microsoft's event
   * id, CalDAV's member address, a subscription's UID. A series and its changed days are several
   * items (`event.rules`, `event.recurrenceId`); where they are one stored object they share `id`,
   * `version` and `text`. `text` is that object whole, as the calendar format writes it, for CalDAV
   * and a subscription; `null` for Google and Microsoft, which store no calendar text.
   */
  | { readonly kind: "upsert"; readonly id: string; readonly version: string; readonly event: CalEvent; readonly text: string | null }
  /** The stored object of this id is no longer there. */
  | { readonly kind: "gone"; readonly id: string }
  /** One day of a series was cancelled, and the provider says so by a record of its own. */
  | { readonly kind: "cancelled_occurrence"; readonly uid: string; readonly originalStart: EventTime };

/** Why one record was left out of a page: the calendar reader's own word, or `unreadable` for a record that is no event. */
export type LeftReason = CalendarRefusal | "unreadable";

export interface ChangePage {
  /**
   * `delta`: what changed since the token. `whole`: everything the calendar holds, in one or more
   * pages; what is in none of them once the cursor says `end` is gone. A subscription is always
   * `whole`; so is a CalDAV calendar that keeps no token.
   */
  readonly mode: "delta" | "whole";
  /** The calendar is as the token left it (a 304, an equal tag, an equal text): nothing to apply, and `items` is empty. */
  readonly unchanged: boolean;
  readonly items: readonly ChangeItem[];
  /** Records the reader left out, each with its word. A calendar read with something left out is one to show, never one to write back. */
  readonly left: readonly { readonly id: string; readonly reason: LeftReason }[];
  readonly cursor: { readonly kind: "more"; readonly value: string } | { readonly kind: "end"; readonly token: ChangeToken | null };
  /**
   * Microsoft only: the days of the window it was asked for, as identities. An expanded day is
   * never an item and never stored; the caller compares these with what its own expansion gives.
   */
  readonly expanded: { readonly window: { readonly start: Instant; readonly end: Instant }; readonly seen: readonly { readonly uid: string; readonly originalStart: EventTime }[] } | null;
  /** The least time before the next ask, where the answer names one (a subscription's own wish, inside the floor and the ceiling); `null` otherwise. */
  readonly refreshMs: number | null;
}

export type Answer<T> =
  | { readonly ok: true; readonly value: T }
  /** `retryAfterMs`: how long the provider asked to be left alone, at most a day. `read`: the calendar reader's word, when the refusal is `unreadable` or `too_large` because of the text. */
  | { readonly ok: false; readonly reason: ProviderRefusal; readonly retryAfterMs: number | null; readonly read?: ReadRefusal };

export interface CalendarReader {
  readonly provider: ProviderWord;
  /** Does the sign-in open? `principal` is where the provider says the person's own resources begin (CalDAV), `addresses` the calendar addresses it lists for them. */
  checkSignIn(c: Connection, signal: AbortSignal): Promise<Answer<{ readonly principal: string | null; readonly addresses: readonly string[] }>>;
  listCalendars(c: Connection, signal: AbortSignal): Promise<Answer<readonly CalendarInfo[]>>;
  /** One page of what changed since `since`, or from the beginning when it is `null`. */
  readChanges(c: Connection, cal: CalendarRef, since: ChangeToken | null, page: PageRequest, signal: AbortSignal): Promise<Answer<ChangePage>>;
}

// ── writing ──────────────────────────────────────────────────────────────────

/**
 * The name a write is made under: the queue row's own id as 32 lower-case hex. Every id a writer
 * makes for a new object (Google's event id, a CalDAV member's name and its UID, Graph's
 * `transactionId`) is made from it and from nothing a person or a letter wrote, so every attempt of
 * one write names the same object, and two writes never name one.
 */
export interface WriteKey {
  readonly hex: string;
}

/** One invitee as a person wrote it: a mail address, the name shown, and whether the presence is optional. */
export interface EventInvitee {
  readonly email: string;
  readonly name: string | null;
  readonly optional: boolean;
}

/** An event as a person wrote it. An end always, never a length; a whole day ends at the next day's start. */
export interface EventDraft {
  readonly start: EventTime;
  readonly end: EventTime;
  readonly summary: string;
  readonly description: string | null;
  readonly location: string | null;
  /** The call's link, https only. */
  readonly url: string | null;
  readonly busy: boolean;
  readonly private: boolean;
  readonly rule: RRule | null;
  /** The account's own address where the event has invitees: the writer never takes it from what a person typed. */
  readonly organizer: string | null;
  readonly attendees: readonly EventInvitee[];
  /** Reminders, each in minutes before the start. */
  readonly alarms: readonly number[];
}

/** A change to a stored object: a field present is written, a field absent stays as the provider holds it. */
export type EventChange = Partial<EventDraft>;

/** The stored object a write is made on, as a reading handed it out. */
export interface WriteTarget {
  /** `upsert.id` as a reading handed it. */
  readonly id: string;
  /** `upsert.version` as stored; never empty. A writer that cannot send it as a precondition reads the object first. */
  readonly version: string;
  /** CalDAV: the stored object as the server sent it. `null` for the others. */
  readonly text: string | null;
  /** One day of the series `id` names, by its original start; `null` for the object whole. */
  readonly occurrence: EventTime | null;
}

/**
 * What a write came to. `items` are what a reading would hand for the object after the write: an
 * `upsert`, a `gone`, or a `cancelled_occurrence`, so the store and the provider meet through the
 * reading's own mapper. A writer answers; it does not throw.
 */
export type WriteAnswer =
  /**
   * `written`: the write's own success: the provider took this very request (its 2xx), and `items`
   * are the object as that request left it (at CalDAV: the answer's tag absent, or the read-back's
   * own). Absent where the write was found done (a refused precondition and a compare, an object
   * already gone or already so): the writes waiting behind it are then never re-based onto `items`,
   * which may be someone else's newer copy.
   */
  | { readonly ok: true; readonly items: readonly ChangeItem[]; readonly written?: true }
  | { readonly ok: false; readonly reason: ProviderRefusal | WriteRefusal; readonly retryAfterMs: number | null };

/** An invitee's own answer, as the calendar format words it. */
export type WriteReply = "ACCEPTED" | "TENTATIVE" | "DECLINED";

/**
 * The series the days of a series become from one of its days on (the second half of a press on a
 * day and the days after it): its own name (`key`, as `create`'s), its start, its end, its repeat,
 * and the fields the person named for it. Every other line is the series' own.
 */
export interface SeriesContinuation {
  readonly key: WriteKey;
  readonly start: EventTime;
  readonly end: EventTime;
  readonly rule: RRule;
  readonly change: EventChange;
}

/**
 * The writing half of a provider. No method sends a change without a precondition: a change and a
 * removal go against the target's version, a new object under a name that is new. No method takes
 * a setting that could stop invitees from hearing of a change: a provider that sends invitations
 * always sends them.
 */
export interface CalendarWriter {
  readonly provider: ProviderWord;
  create(c: Connection, cal: CalendarRef, req: { readonly key: WriteKey; readonly event: EventDraft }, signal: AbortSignal): Promise<WriteAnswer>;
  change(c: Connection, cal: CalendarRef, target: WriteTarget, change: EventChange, signal: AbortSignal): Promise<WriteAnswer>;
  remove(c: Connection, cal: CalendarRef, target: WriteTarget, signal: AbortSignal): Promise<WriteAnswer>;
  /** The account's own answer as an invitee (`as`: its address on the event). */
  answer(c: Connection, cal: CalendarRef, target: WriteTarget, req: { readonly as: string; readonly reply: WriteReply }, signal: AbortSignal): Promise<WriteAnswer>;
  /**
   * The series `target.id` names ends before its day `target.occurrence` (that day and the days after
   * it go to a series of their own, or are let go): its repeat ends there, and the changed days it
   * holds from that day on go with the days they named. Against the target's version, as a change.
   * `then`: the series those days become, as the press's second half will ask it (`continueSeries`),
   * or `null` where they are let go. Nothing is sent of a press that cannot be finished: the writer
   * makes that series from the very copy it ends before it sends anything, and where it would refuse
   * it, refuses the end with that word. `mayBeDone`: may a series found ended exactly where this end
   * ends it be taken as this end's own (an earlier attempt of it landed)? Only where the queue says so
   * (not on a write's first attempt, nor where another write may have made that end); else such a
   * series is another copy than the one the write was made on (`version_stale`). `late`: the end is
   * too old to send: the member is only looked at, nothing is sent; found ended exactly so, on another
   * version than the target's and `mayBeDone`, it is answered as done; otherwise `version_stale`.
   */
  endSeries(
    c: Connection, cal: CalendarRef, target: WriteTarget,
    req: { readonly then: SeriesContinuation | null; readonly mayBeDone: boolean; readonly late?: boolean },
    signal: AbortSignal,
  ): Promise<WriteAnswer>;
  /**
   * A new object of the days of the series `from.id` names from its day `from.occurrence` on, made
   * from that series' own component as `from` holds it: every line the series carries, and its
   * excluded days from that day on, are carried; only what a new series must differ in is written
   * anew (its own name from `key`, its start and end, its repeat, and the fields `change` names).
   * Its invitees are asked again, its organizer's own line kept as it is. Under a name that is new,
   * as `create`; a writer that cannot make it so refuses it with its word. Made only where that
   * series no longer has those days (it ends before that day): where it goes on from it, they
   * stand there, and it is refused for its copy (`version_stale`), nothing sent.
   */
  continueSeries(
    c: Connection, cal: CalendarRef, req: SeriesContinuation & { readonly from: WriteTarget }, signal: AbortSignal,
  ): Promise<WriteAnswer>;
  /**
   * A provider's own move of an event between two calendars of one connection; `null` where it has
   * none and a move is a create and a removal. Named apart from a mailbox's moves on purpose.
   */
  readonly moveEvent: ((c: Connection, from: CalendarRef, to: CalendarRef, target: WriteTarget, signal: AbortSignal) => Promise<WriteAnswer>) | null;
}
