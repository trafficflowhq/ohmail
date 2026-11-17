/**
 * Letters that carry an invitation, for the ingest's and the pass's tests: each built from its
 * fields (never a whole `raw`), so the change scan and the targeted re-read serve the same bytes.
 * The calendar texts are the shapes the providers write (Google, Exchange, Apple), one of each
 * method, an occurrence, a whole day, and two that keep no row. The calendar package's own corpus
 * goes through the same doors in `test/invitation-corpus-doors.test.ts`.
 */

import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@trafficflow/db";
import type { Logger } from "@trafficflow/core/mail";

/** The mailbox the letters are delivered to (the fake adapter's own `To`). */
export const ME = "mila@lichtgrat.example";

const crlf = (lines: readonly string[]): string => lines.map((l) => `${l}\r\n`).join("");
const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64").replace(/.{1,76}/g, (l) => `${l}\r\n`);

/** One delivered letter, as the fake adapter's `deliver` takes it. */
export interface InvitationLetter {
  from: string;
  subject: string;
  messageId: string;
  headers: string[];
  contentType: string;
  body: string;
  folder?: string;
  ownAuthored?: boolean;
  seen?: boolean;
}

/**
 * A letter whose calendar part is `ics`: a text body and the calendar part as the alternative, the
 * part's type naming the calendar's own METHOD as Google and Outlook write it.
 */
export function invitationLetter(
  id: string, ics: string, opts: { from?: string; folder?: string; ownAuthored?: boolean; date?: Date } = {},
): InvitationLetter {
  const method = /^METHOD:([A-Za-z-]+)\r?$/m.exec(ics)?.[1]?.toUpperCase();
  return {
    from: opts.from ?? "tobias@studio.example",
    subject: `Invitation ${id}`,
    messageId: id,
    headers: [`Date: ${(opts.date ?? new Date(Date.UTC(2026, 10, 10, 8, 0, 0))).toUTCString()}`, "MIME-Version: 1.0"],
    contentType: 'multipart/alternative; boundary="ALT"',
    body: [
      "--ALT", "Content-Type: text/plain; charset=utf-8", "", "You are invited.", "",
      "--ALT", `Content-Type: text/calendar; charset=UTF-8${method ? `; method=${method}` : ""}`, "Content-Transfer-Encoding: base64", "",
      b64(ics), "--ALT--", "",
    ].join("\r\n"),
    ...(opts.folder !== undefined ? { folder: opts.folder } : {}),
    ...(opts.ownAuthored ? { ownAuthored: true, seen: true } : {}),
  };
}

/** A calendar text with one event. */
export function calendarText(method: string | null, event: readonly string[]): string {
  return crlf(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", ...(method ? [`METHOD:${method}`] : []), "BEGIN:VEVENT", ...event, "END:VEVENT", "END:VCALENDAR"]);
}

const ZURICH = [
  "BEGIN:VTIMEZONE", "TZID:Europe/Zurich", "BEGIN:STANDARD", "DTSTART:19701025T030000", "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD", "END:VTIMEZONE",
];

/** One text of each shape a provider writes, by name. */
export const INVITATION_TEXTS: ReadonlyArray<{ name: string; text: string }> = [
  { name: "google/request", text: crlf(["BEGIN:VCALENDAR", "PRODID:-//Google Inc//Google Calendar 70.9054//EN", "VERSION:2.0", "METHOD:REQUEST", ...ZURICH,
    "BEGIN:VEVENT", "DTSTART;TZID=Europe/Zurich:20261201T110000", "DTEND;TZID=Europe/Zurich:20261201T120000", "DTSTAMP:20261110T080000Z",
    "ORGANIZER;CN=Tobias:mailto:tobias@studio.example", `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=${ME}:mailto:${ME}`,
    "ATTENDEE;PARTSTAT=ACCEPTED;CN=Tobias:mailto:tobias@studio.example", "UID:google-1@google.com", "SEQUENCE:0", "SUMMARY:Studio kickoff",
    "BEGIN:VALARM", "ACTION:EMAIL", "ATTENDEE:mailto:alarm@studio.example", "TRIGGER:-P0DT0H30M0S", "END:VALARM", "END:VEVENT", "END:VCALENDAR"]) },
  { name: "exchange/request", text: crlf(["BEGIN:VCALENDAR", "METHOD:REQUEST", "PRODID:Microsoft Exchange Server 2010", "VERSION:2.0",
    "BEGIN:VTIMEZONE", "TZID:W. Europe Standard Time", "BEGIN:STANDARD", "DTSTART:16010101T030000", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100",
    "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10", "END:STANDARD", "END:VTIMEZONE", "BEGIN:VEVENT",
    "ORGANIZER;CN=Anna Weber:mailto:anna.weber@contoso.example", `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Mila:mailto:${ME.toUpperCase()}`,
    "UID:040000008200E00074C5B7101A82E00800000000B0D0E1F2@contoso.example", "SUMMARY;LANGUAGE=de-CH:Budget", "DTSTART;TZID=W. Europe Standard Time:20261203T140000",
    "DTEND;TZID=W. Europe Standard Time:20261203T150000", "SEQUENCE:1", "DTSTAMP:20261110T090000Z", "STATUS:CONFIRMED", "END:VEVENT", "END:VCALENDAR"]) },
  { name: "apple/reply", text: crlf(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Apple Inc.//macOS 15.1//EN", "METHOD:REPLY", "BEGIN:VEVENT",
    "UID:google-1@google.com", "DTSTAMP:20261111T100000Z", "SEQUENCE:0", "ORGANIZER:mailto:tobias@studio.example",
    "ATTENDEE;PARTSTAT=ACCEPTED;CN=Lena:mailto:lena@other.example", "DTSTART;TZID=Europe/Zurich:20261201T110000", "END:VEVENT", "END:VCALENDAR"]) },
  { name: "google/cancel", text: crlf(["BEGIN:VCALENDAR", "PRODID:-//Google Inc//Google Calendar 70.9054//EN", "VERSION:2.0", "METHOD:CANCEL", "BEGIN:VEVENT",
    "DTSTART:20261205T090000Z", "DTSTAMP:20261112T080000Z", "ORGANIZER:mailto:tobias@studio.example", `ATTENDEE:mailto:${ME}`,
    "UID:google-2@google.com", "SEQUENCE:3", "STATUS:CANCELLED", "SUMMARY:Cancelled: Glaze firing", "END:VEVENT", "END:VCALENDAR"]) },
  { name: "exchange/counter", text: crlf(["BEGIN:VCALENDAR", "METHOD:COUNTER", "PRODID:Microsoft Exchange Server 2010", "VERSION:2.0", "BEGIN:VEVENT",
    "ORGANIZER:mailto:anna.weber@contoso.example", `ATTENDEE;PARTSTAT=TENTATIVE:mailto:${ME}`, "UID:040000008200E00074C5B7101A82E00800000000C1C2C3C4@contoso.example",
    "DTSTART:20261204T130000Z", "DTEND:20261204T140000Z", "X-MS-OLDSTART:20261203T130000Z", "SEQUENCE:1", "DTSTAMP:20261111T120000Z", "END:VEVENT", "END:VCALENDAR"]) },
  { name: "google/occurrence", text: crlf(["BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", ...ZURICH, "BEGIN:VEVENT",
    "UID:google-3@google.com", "RECURRENCE-ID;TZID=Europe/Zurich:20261208T180000", "DTSTART;TZID=Europe/Zurich:20261208T190000",
    "SEQUENCE:1", "DTSTAMP:20261110T080000Z", "ORGANIZER:mailto:tobias@studio.example", `ATTENDEE:mailto:${ME}`, "END:VEVENT", "END:VCALENDAR"]) },
  { name: "icloud/whole-day", text: crlf(["BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:icloud-1@icloud.example",
    "DTSTART;VALUE=DATE:20261224", "DTEND;VALUE=DATE:20261225", "DTSTAMP:20261110T080000Z", "ORGANIZER:mailto:nora@icloud.example",
    `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ME}`, "END:VEVENT", "END:VCALENDAR"]) },
  { name: "feed/publish", text: crlf(["BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:PUBLISH", "BEGIN:VEVENT", "UID:feed-1@tickets.example",
    "DTSTART:20261231T200000Z", "SUMMARY:Concert", "END:VEVENT", "END:VCALENDAR"]) },
  { name: "file/no-method", text: crlf(["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:file-1@booking.example",
    "DTSTART:20270105T070000Z", "SUMMARY:Train", "END:VEVENT", "END:VCALENDAR"]) },
];

/** Each provider shape as a letter of its own. */
export function shapeLetters(): Array<{ name: string; text: string; letter: InvitationLetter }> {
  return INVITATION_TEXTS.map(({ name, text }, i) => ({ name, text, letter: invitationLetter(`shape-${i}@studio.example`, text) }));
}

/** An invitation to the event `uid` at `sequence`, naming this mailbox among its invitees. */
export const request = (uid: string, sequence = 0, extra: readonly string[] = []): string => calendarText("REQUEST", [
  `UID:${uid}`, `SEQUENCE:${sequence}`, "DTSTAMP:20261110T080000Z", "DTSTART:20261201T100000Z",
  "ORGANIZER;CN=Tobias:mailto:tobias@studio.example", `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ME}`, ...extra,
]);

/** This mailbox's answer to it. */
export const reply = (uid: string, partstat: string, stamp: string, sequence = 0): string => calendarText("REPLY", [
  `UID:${uid}`, `SEQUENCE:${sequence}`, `DTSTAMP:${stamp}`, "ORGANIZER:mailto:tobias@studio.example",
  `ATTENDEE;PARTSTAT=${partstat}:mailto:${ME}`,
]);

/** The run is on the device's store (the `sqlite` project). */
export const SQLITE_STORE = process.env.OHMAIL_TEST_DIALECT === "sqlite";

/** A logger that keeps every line it is given, its fields as given. */
export function recorder(): Logger & { lines: Array<{ event: string; fields: Record<string, unknown> }> } {
  const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const push = (event: string, fields: Record<string, unknown> = {}): void => { lines.push({ event, fields }); };
  const log = { level: "debug" as const, lines, child: () => log, debug: push, info: push, warn: push, error: push };
  return log as unknown as Logger & { lines: typeof lines };
}

/**
 * THE STORE REFUSES the invitation rows of one UID (and, when named, one method), as a server or a
 * device refuses a statement: Postgres raises `errcode` (class 22 a value, 40 the store's own),
 * SQLite a constraint. Named for this run; returns the call that lifts it.
 */
export async function refuseInvitationRows(
  db: Tx, uid: string, errcode: string, method?: string,
): Promise<() => Promise<void>> {
  const name = `refuse_invitation_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const when = `NEW.uid = '${uid}'${method === undefined ? "" : ` AND NEW.method = '${method}'`}`;
  if (SQLITE_STORE) {
    const lite = db as unknown as { run(q: SQL): Promise<unknown> };
    await lite.run(sql.raw(`CREATE TRIGGER ${name} BEFORE INSERT ON message_invitations WHEN ${when}
      BEGIN SELECT RAISE(ABORT, 'the store refused this row'); END`));
    return async () => { await lite.run(sql.raw(`DROP TRIGGER ${name}`)); };
  }
  await db.execute(sql.raw(`create function ${name}() returns trigger language plpgsql as $$
    begin if ${when} then raise exception 'the store refused this row' using errcode = '${errcode}'; end if;
    return new; end $$`));
  await db.execute(sql.raw(`create trigger ${name} before insert on message_invitations for each row execute function ${name}()`));
  return async () => {
    await db.execute(sql.raw(`drop trigger ${name} on message_invitations`));
    await db.execute(sql.raw(`drop function ${name}()`));
  };
}
