/**
 * THE REPLY AN ANSWER SENDS, written as mail: the calendar part of the letter a press on an
 * invitation sends to its organizer (iTIP METHOD:REPLY, RFC 5546 section 3.2.3). Written from the
 * stored row alone (`message_invitations`), never from calendar bytes, and core's, so a phone that
 * organizes on its own can answer.
 *
 * Every line is a constant, a value of the row or the press: the UID, the occurrence, the
 * revision, the start, the organizer and the one invitee. No title, place, name or zone the
 * sender wrote is repeated, and a value that would need one refuses the whole reply (null).
 */
import type { InvitationAnswer } from "@ohmail/wire";
import { holdsControl, isPlainAddress } from "./invitation-mail.js";

/** What the writer reads: the stored row and the press, nothing else. */
export interface InvitationReplyInput {
  uid: string;
  /** The occurrence's key as stored, `""` for the series. */
  recurrenceId: string;
  sequence: number;
  startRaw: string | null;
  startsAt: Date | null;
  organizer: string;
  invitedAddress: string;
  answer: InvitationAnswer;
  /** DTSTAMP: the answer's own instant, so a replay of the press writes the same letter. */
  stamp: Date;
}

/** The PRODID line's value. */
export const INVITATION_REPLY_PRODID = "-//ohmail//ohmail//EN";

const PARTSTAT: ReadonlyMap<string, string> = new Map([["accepted", "ACCEPTED"], ["tentative", "TENTATIVE"], ["declined", "DECLINED"]]);
const SEQUENCE_MAX = 2 ** 31 - 1;
/** RFC 5545 section 3.1: past 75 octets a line folds, its continuation led by one space. */
const LINE_OCTETS = 75;
const DAY_MS = 86_400_000;
/** The stored occurrence keys this writer can say (`ics.ts` `canonicalRecurrenceId`): an instant, a floating clock time. */
const INSTANT_KEY = /^-?\d{1,16}$/;
const FLOATING_KEY = /^\|(\d{8}T\d{4})\|false$/;
const DAY_START = /^\d{8}$/;
const UTC_START = /^\d{8}T\d{6}Z$/;
const CLOCK_START = /^\d{8}T\d{6}$/;

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** An instant as iCalendar writes one in UTC (`YYYYMMDDTHHMMSSZ`); null outside years 1 to 9999. */
function utcText(ms: number): string | null {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  if (!Number.isFinite(year) || year < 1 || year > 9999) return null;
  return `${pad(year, 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
    + `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** No surrogate stands alone: such a string has no UTF-8 form, and would leave as another text. */
function wholeCharacters(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

/** RFC 5545 section 3.3.11: a TEXT value with its backslash, semicolon and comma escaped. */
const escapedText = (v: string): string => v.replace(/[\\;,]/g, (c) => `\\${c}`);

/**
 * RECURRENCE-ID from the stored key: none for the series; an instant in UTC, or its day for a
 * whole-day event; a floating clock time as written. Null for a key holding a zone's name (the
 * sender's text) and for any shape the reader does not write.
 */
function occurrenceLines(key: string, wholeDay: boolean): string[] | null {
  if (key === "") return [];
  if (INSTANT_KEY.test(key)) {
    const ms = Number(key);
    const at = utcText(ms);
    if (at === null) return null;
    if (!wholeDay) return [`RECURRENCE-ID:${at}`];
    return ms % DAY_MS === 0 ? [`RECURRENCE-ID;VALUE=DATE:${at.slice(0, 8)}`] : null;
  }
  const floating = FLOATING_KEY.exec(key);
  return floating !== null && !wholeDay ? [`RECURRENCE-ID:${floating[1]}00`] : null;
}

/**
 * DTSTART, which a REPLY may carry: the day of a whole-day event, the start's instant in UTC (as
 * written when it was written in UTC), or a floating clock time beside a floating occurrence. A
 * clock time with no instant is left out: it may name a zone this platform does not know.
 */
function startLines(i: InvitationReplyInput, floating: boolean): string[] {
  const raw = i.startRaw;
  if (raw !== null && DAY_START.test(raw)) return [`DTSTART;VALUE=DATE:${raw}`];
  if (raw !== null && UTC_START.test(raw)) return [`DTSTART:${raw}`];
  if (i.startsAt !== null) {
    const at = utcText(i.startsAt.getTime());
    return at === null ? [] : [`DTSTART:${at}`];
  }
  return raw !== null && floating && CLOCK_START.test(raw) ? [`DTSTART:${raw}`] : [];
}

/** One content line folded at 75 octets, never inside a character, ended with CRLF. */
function folded(line: string): string {
  let out = "";
  let used = 0;
  for (const ch of line) {
    const cp = ch.codePointAt(0)!;
    const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (used + size > LINE_OCTETS) {
      out += "\r\n ";
      used = 1;
    }
    out += ch;
    used += size;
  }
  return `${out}\r\n`;
}

/**
 * THE ANSWER AS A CALENDAR PART: one VEVENT with the row's UID, occurrence and SEQUENCE, the
 * press's stamp as DTSTAMP, the start where it can be told exactly, the organizer, and one ATTENDEE
 * with its PARTSTAT. CRLF line ends, folded at 75 octets. Null when the reply cannot be written
 * from the row exactly: a control character or half a character in the UID, an address that is
 * not one plain address, an occurrence key naming a zone, a value outside its range.
 */
export function invitationReplyText(i: InvitationReplyInput): string | null {
  const partstat = PARTSTAT.get(i.answer);
  if (partstat === undefined) return null;
  if (i.uid === "" || holdsControl(i.uid) || !wholeCharacters(i.uid)) return null;
  if (!isPlainAddress(i.organizer) || !isPlainAddress(i.invitedAddress)) return null;
  if (!Number.isInteger(i.sequence) || i.sequence < 0 || i.sequence > SEQUENCE_MAX) return null;
  const stamp = i.stamp instanceof Date ? utcText(i.stamp.getTime()) : null;
  if (stamp === null) return null;
  const occurrence = occurrenceLines(i.recurrenceId, i.startRaw !== null && DAY_START.test(i.startRaw));
  if (occurrence === null) return null;
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:${INVITATION_REPLY_PRODID}`, "METHOD:REPLY", "BEGIN:VEVENT",
    `UID:${escapedText(i.uid)}`, ...occurrence, `SEQUENCE:${i.sequence}`, `DTSTAMP:${stamp}`,
    ...startLines(i, FLOATING_KEY.test(i.recurrenceId)),
    `ORGANIZER:mailto:${i.organizer}`, `ATTENDEE;PARTSTAT=${partstat}:mailto:${i.invitedAddress}`,
    "END:VEVENT", "END:VCALENDAR",
  ].map(folded).join("");
}
