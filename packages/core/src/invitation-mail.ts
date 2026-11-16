/**
 * AN INVITATION, READ AS MAIL: the identity a letter's calendar part gives its event, kept at ingest
 * (`message_invitations`, mail 0204). Reading and writing an invitation as mail is core's, beside
 * `ics.ts`, so a phone that organizes on its own reads it without the calendar's package.
 *
 * Its own walk over `ics.ts`'s line machinery, not the card's parse: the card keeps eight invitees,
 * refuses an event without a start (a CANCEL or a REPLY may have none) and drops the reply's stamp.
 * Pure and bounded by count, never by the clock: the input is a stranger's text, read on a server.
 * It never throws, and it reads nothing but the text (no URL, attachment or zone file it names).
 */
import type { InvitationAnswer, InvitationMethod } from "@ohmail/wire";
import {
  calendarPartRank, canonicalRecurrenceId, parseContentLine, parseIcsDate, unescapeText, unfoldIcs,
  type CalendarPartText, type ContentLine,
} from "./ics.js";

/** What one letter's calendar part says about its event — in memory only, never stored as such. */
export interface LetterInvitation {
  method: InvitationMethod;
  /** UID as written, unescaped. */
  uid: string;
  /** The occurrence's key as the card's reader writes it (`ics.ts`), `""` for the series. */
  recurrenceId: string;
  sequence: number;
  /** DTSTART as written, in one of its three digit shapes, or null. */
  startRaw: string | null;
  startsAt: Date | null;
  /** ORGANIZER's address, when it is one plain address. */
  organizer: string | null;
  /**
   * The ATTENDEE addresses, as spelled, that are plain addresses, in order, from the first
   * {@link INVITATION_ATTENDEES_MAX} ATTENDEE lines; on a REPLY the first line's alone. Never stored.
   */
  attendees: readonly string[];
  /**
   * DTSTAMP, to the second; null when the event names none in UTC. It orders one revision's
   * letters: a cancellation stands only over the invitations stamped before it.
   */
  stampedAt: Date | null;
  /** On a REPLY: the answer its attendee gives, and its DTSTAMP. Null on any other method. */
  reply: { answer: InvitationAnswer; at: Date | null } | null;
}

/**
 * What a letter's calendar parts yield at the parse, handed to the commit as values
 * (`NormalizedMessage.calendar`). One member per reader; each is absent when it found nothing.
 */
export interface LetterCalendar {
  invitation?: LetterInvitation;
}

/** An invitation as a plan carries it to the commit: what the letter said, and whether the person wrote it. */
export type PlannedInvitation = LetterInvitation & {
  /** The letter was read out of the mailbox's own Sent folder. */
  own: boolean;
};

/**
 * The parts read, as the card reads them (the client engine's `CALENDAR_TEXT_MAX_BYTES` and
 * `CALENDAR_TEXT_MAX_PARTS`): calendar parts of at most this many decoded bytes, the first three in
 * {@link calendarPartRank} order. A larger part is skipped, never cut.
 */
export const INVITATION_PART_MAX_BYTES = 256 * 1024;
export const INVITATION_PARTS_MAX = 3;
/** Unfolded lines of one part; past it the part says nothing. */
export const INVITATION_LINES_MAX = 20_000;
/** ATTENDEE lines compared; an invitee named past them is not found, so the mailbox is not invited. */
export const INVITATION_ATTENDEES_MAX = 2_000;
/** RFC 5321's 254: a longer address is no address. */
export const INVITATION_ADDRESS_MAX_CHARS = 254;
const SEQUENCE_MAX = 2 ** 31 - 1;

const ROW_METHODS: ReadonlySet<string> = new Set<InvitationMethod>(["REQUEST", "REPLY", "CANCEL", "COUNTER"]);
const ANSWERS: ReadonlyMap<string, InvitationAnswer> = new Map([["ACCEPTED", "accepted"], ["TENTATIVE", "tentative"], ["DECLINED", "declined"]]);
/** DTSTART as written: a date, a clock time, a clock time in UTC. */
const START_SHAPE = /^\d{8}(?:T\d{6}Z?)?$/;

const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isLetterOrDigit = (c: number): boolean => isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
/** The local part's symbols besides the dot: RFC 5322's atext, less `%` and `!`. */
const LOCAL_SYMBOLS = new Set([...".#$&'*+/=?^_`{|}~-"].map((s) => s.charCodeAt(0)));

/**
 * ONE PLAIN ADDRESS, by a walk over its characters: ASCII, at most 254 characters, one `@`; a local
 * part of letters, digits and RFC 5322's symbols but `%` and `!`, with no dot leading, trailing or
 * doubled; a domain of two labels or more of letters, digits and inner hyphens, the last not all
 * digits. Anything else (a quoted local part, an address literal, a bare host, a space, a comma, a
 * control character, a letter outside ASCII) is no address here.
 */
export function isPlainAddress(a: string): boolean {
  if (a.length === 0 || a.length > INVITATION_ADDRESS_MAX_CHARS) return false;
  const at = a.indexOf("@");
  if (at <= 0 || at !== a.lastIndexOf("@")) return false;
  let afterDot = true;
  for (let i = 0; i < at; i++) {
    const c = a.charCodeAt(i);
    if (c === 46) {
      if (afterDot) return false;
      afterDot = true;
    } else if (isLetterOrDigit(c) || LOCAL_SYMBOLS.has(c)) afterDot = false;
    else return false;
  }
  if (afterDot) return false;
  let labels = 0;
  let size = 0;
  let digitsOnly = true;
  let lastDigitsOnly = false;
  let endsInHyphen = false;
  for (let i = at + 1; i <= a.length; i++) {
    const c = i === a.length ? 46 : a.charCodeAt(i);
    if (c === 46) {
      if (size === 0 || size > 63 || endsInHyphen) return false;
      labels++;
      lastDigitsOnly = digitsOnly;
      size = 0;
      digitsOnly = true;
    } else if (c === 45) {
      if (size === 0) return false;
      size++;
      digitsOnly = false;
      endsInHyphen = true;
    } else if (isLetterOrDigit(c)) {
      size++;
      if (!isDigit(c)) digitsOnly = false;
      endsInHyphen = false;
    } else return false;
  }
  return labels >= 2 && !lastDigitsOnly;
}

/** A CAL-ADDRESS's `mailto:` address, cut at `?`, when it is one plain address; else null. */
function plainMailto(value: string): string | null {
  const v = value.trim();
  if (v.length <= 7 || v.slice(0, 7).toLowerCase() !== "mailto:") return null;
  const query = v.indexOf("?", 7);
  const address = query < 0 ? v.slice(7) : v.slice(7, query);
  return isPlainAddress(address) ? address : null;
}

/** A character a kept string never holds: a control (U+0000 to U+001F, U+007F to U+009F) or a Unicode line break. */
export function holdsControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

/** More than `max` line breaks, counted before the text is split. */
function linesOver(text: string, max: number): boolean {
  let breaks = 0;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) if (++breaks > max) return true;
  return false;
}

/** The first VEVENT's identity lines, as the walk collects them. */
interface EventLines {
  uidLine?: ContentLine;
  recurrenceId?: ContentLine;
  sequence?: ContentLine;
  start?: ContentLine;
  stamp?: ContentLine;
  organizer?: ContentLine;
  cancelled: boolean;
  attendeeLines: number;
  attendees: ContentLine[];
}

/**
 * The walk: the calendar's METHOD (the first line outside every event; a second that disagrees
 * means no answer), and the first VEVENT's own lines, a VALARM's and every other nested
 * component's skipped. Which event is first is decided as the card decides it.
 */
function walk(lines: readonly string[]): { method: string | null; event: EventLines | null } {
  let method: string | null = null;
  let methodDoubt = false;
  let inEvent = false;
  let eventDone = false;
  let nested = 0;
  let event: EventLines | null = null;
  for (const raw of lines) {
    if (raw === "") continue;
    const line = parseContentLine(raw);
    if (!line) continue;
    if (line.name === "BEGIN") {
      if (inEvent) nested++;
      else if (line.value.trim().toUpperCase() === "VEVENT" && !eventDone) {
        inEvent = true;
        event = { cancelled: false, attendeeLines: 0, attendees: [] };
      }
      continue;
    }
    if (line.name === "END") {
      if (inEvent && nested > 0) nested--;
      else if (inEvent && line.value.trim().toUpperCase() === "VEVENT") {
        inEvent = false;
        eventDone = true;
      }
      continue;
    }
    if (!inEvent) {
      if (line.name === "METHOD") {
        const m = line.value.trim().toUpperCase();
        if (method === null) method = m;
        else if (m !== method) methodDoubt = true;
      }
      continue;
    }
    if (nested > 0 || event === null) continue;
    switch (line.name) {
      case "UID": event.uidLine ??= line; break;
      case "RECURRENCE-ID": event.recurrenceId ??= line; break;
      case "SEQUENCE": event.sequence ??= line; break;
      case "DTSTART": event.start ??= line; break;
      case "DTSTAMP": event.stamp ??= line; break;
      case "ORGANIZER": event.organizer ??= line; break;
      case "STATUS": if (line.value.trim().toUpperCase() === "CANCELLED") event.cancelled = true; break;
      case "ATTENDEE":
        if (event.attendeeLines++ < INVITATION_ATTENDEES_MAX) event.attendees.push(line);
        break;
    }
  }
  return { method: methodDoubt ? null : method, event };
}

/** SEQUENCE: absent is 0; a value that is not 0 to 2^31-1 is undefined (no row). */
function sequenceOf(line: ContentLine | undefined): number | undefined {
  if (line === undefined) return 0;
  const v = line.value.trim();
  if (!/^\d{1,10}$/.test(v)) return undefined;
  const n = Number(v);
  return n <= SEQUENCE_MAX ? n : undefined;
}

/** The occurrence's key, `""` for none; undefined when it names one no key can say (no row). */
function occurrenceOf(line: ContentLine | undefined): string | undefined {
  if (line === undefined) return "";
  // A range is a span of occurrences, not one: no single answer belongs to it.
  if (line.params.has("RANGE")) return undefined;
  return canonicalRecurrenceId(line) ?? undefined;
}

function startOf(line: ContentLine | undefined): { startRaw: string | null; startsAt: Date | null } {
  if (line === undefined) return { startRaw: null, startsAt: null };
  const t = parseIcsDate(line.value, line.params.get("TZID") ?? null, line.params.get("VALUE") ?? null);
  if (t === null) return { startRaw: null, startsAt: null };
  const written = line.value.trim();
  return { startRaw: START_SHAPE.test(written) ? written : null, startsAt: instantOf(t.epochMs) };
}

/** DTSTAMP's seconds, which the card's date parse leaves out. */
const STAMP_SECONDS = /^\d{8}T\d{4}(\d{2})Z$/;

/**
 * A UTC stamp (DTSTAMP is UTC by the standard), to the second: it orders a person's answers, and
 * two of them may fall within one minute. Null for anything else.
 */
function stampOf(line: ContentLine | undefined): Date | null {
  if (line === undefined) return null;
  const t = parseIcsDate(line.value, null, null);
  if (t === null || !t.utc) return null;
  const seconds = STAMP_SECONDS.exec(line.value.trim())?.[1];
  return instantOf(t.epochMs, seconds === undefined ? 0 : Number(seconds) * 1000);
}

/** Milliseconds since 1970, and as many more, as a Date; null for none. */
function instantOf(ms: number | null, more = 0): Date | null {
  return ms === null ? null : new Date(ms + more);
}

/** One calendar text's invitation, or undefined. */
function readPart(text: string): LetterInvitation | undefined {
  const unfolded = unfoldIcs(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (linesOver(unfolded, INVITATION_LINES_MAX)) return undefined;
  const { method: written, event } = walk(unfolded.split(/\r?\n/));
  if (event === null || written === null || !ROW_METHODS.has(written)) return undefined;
  const uid = event.uidLine === undefined ? "" : unescapeText(event.uidLine.value).trim();
  const recurrenceId = occurrenceOf(event.recurrenceId);
  const sequence = sequenceOf(event.sequence);
  if (uid === "" || recurrenceId === undefined || sequence === undefined) return undefined;
  if (holdsControl(uid) || holdsControl(recurrenceId)) return undefined;
  const method = (written === "REQUEST" && event.cancelled ? "CANCEL" : written) as InvitationMethod;
  const first = event.attendees[0];
  const addresses = method === "REPLY"
    ? (first === undefined ? [] : [plainMailto(first.value)])
    : event.attendees.map((a) => plainMailto(a.value));
  const answer = method === "REPLY" && first !== undefined ? ANSWERS.get((first.params.get("PARTSTAT") ?? "").toUpperCase()) : undefined;
  const stampedAt = stampOf(event.stamp);
  return {
    method, uid, recurrenceId, sequence,
    ...startOf(event.start),
    organizer: event.organizer === undefined ? null : plainMailto(event.organizer.value),
    attendees: addresses.filter((a): a is string => a !== null),
    stampedAt,
    reply: answer === undefined ? null : { answer, at: stampedAt },
  };
}

/**
 * THE INVITATION A LETTER CARRIES: its calendar parts read as the card reads them (the first
 * {@link INVITATION_PARTS_MAX} under {@link INVITATION_PART_MAX_BYTES}, in {@link calendarPartRank}
 * order) and folded as the card folds them — the first part's event, and of the parts naming the
 * same event (UID and occurrence) the higher SEQUENCE, then the lower rank. Undefined when no part
 * keeps a row: no METHOD of the four, no UID, an occurrence or a SEQUENCE that cannot be read, a
 * control character in what would be kept. Never throws.
 */
export function readLetterInvitation(parts: readonly CalendarPartText[]): LetterInvitation | undefined {
  try {
    const read = parts
      .filter((p) => p.text.length > 0 && p.text.length <= INVITATION_PART_MAX_BYTES)
      .map((p) => ({ p, rank: calendarPartRank(p.contentType) }))
      .sort((a, b) => a.rank - b.rank)
      .slice(0, INVITATION_PARTS_MAX);
    let best: { invitation: LetterInvitation; rank: number } | undefined;
    for (const { p, rank } of read) {
      const invitation = readPart(p.text);
      if (invitation === undefined) continue;
      if (best === undefined) best = { invitation, rank };
      else if (invitation.uid === best.invitation.uid && invitation.recurrenceId === best.invitation.recurrenceId
        && (invitation.sequence > best.invitation.sequence || (invitation.sequence === best.invitation.sequence && rank < best.rank))) {
        best = { invitation, rank };
      }
    }
    return best?.invitation;
  } catch {
    return undefined;
  }
}
