/**
 * Meeting invitations in the shapes calendar producers send them, synthetic throughout (fictional
 * names, example.test addresses). Each shape carries its raw message and the parts ingest stores for
 * it (`invite-shapes.test.ts` pins `normalizeMime(eml).attachments` to `parts`), so the web, desktop
 * and phone tests serve exactly what a real mailbox would list. Zero imports: every suite reads it.
 */

export interface InvitePart {
  /** The id a fake server lists the part under. */
  id: string;
  filename: string | null;
  /** The stored type: a calendar part keeps its `method=` (`mime.ts` `withCalendarMethod`). */
  contentType: string;
  inline: boolean;
  contentId: string | null;
  /** The decoded bytes, ASCII. */
  bytes: string;
}

export interface InviteShape {
  name: string;
  eml: string;
  /** The body as ingest stores it. */
  text: string;
  html: string | null;
  /** True when the message carries the Content-class calendar header. */
  calendarHeader: boolean;
  parts: InvitePart[];
}

const CRLF = "\r\n";
const b64 = (s: string): string => btoa(s).replace(/(.{76})/g, `$1${CRLF}`);

const VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:W. Europe Standard Time",
  "BEGIN:STANDARD",
  "DTSTART:16010101T030000",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:16010101T020000",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
];

export interface IcsSpec {
  uid?: string | null;
  sequence?: number;
  method?: string | null;
  summary: string;
  /** Wall time in Zurich, `YYYYMMDDTHHMMSS`. */
  start: string;
  end: string;
  location?: string;
  /** The Windows zone name Exchange writes, with its VTIMEZONE. */
  windowsZone?: boolean;
  alarm?: boolean;
}

/** One VCALENDAR with one VEVENT, the way the producers write it. */
export function ics(spec: IcsSpec): string {
  const zone = spec.windowsZone ? "W. Europe Standard Time" : "Europe/Zurich";
  return [
    "BEGIN:VCALENDAR",
    "PRODID:-//Example Calendar//Fixture//EN",
    "VERSION:2.0",
    ...(spec.method === null ? [] : [`METHOD:${spec.method ?? "REQUEST"}`]),
    ...(spec.windowsZone ? VTIMEZONE : []),
    "BEGIN:VEVENT",
    ...(spec.uid === null ? [] : [`UID:${spec.uid ?? "fixture@example.test"}`]),
    `SEQUENCE:${spec.sequence ?? 0}`,
    `SUMMARY:${spec.summary}`,
    `DTSTART;TZID=${zone}:${spec.start}`,
    `DTEND;TZID=${zone}:${spec.end}`,
    "ORGANIZER;CN=Ada Organizer:mailto:ada@example.test",
    "ATTENDEE;CN=Mila Reader;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:mila@example.test",
    "ATTENDEE;CN=Jon Planner;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:jon@example.test",
    `LOCATION:${spec.location ?? "Room Aare"}`,
    ...(spec.alarm
      ? ["BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:REMINDER", "TRIGGER;RELATED=START:-PT15M", "END:VALARM"]
      : []),
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join(CRLF);
}

const head = (id: string, subject: string, extra: string[] = []): string[] => [
  `Message-ID: <${id}@example.test>`,
  "From: Ada Organizer <ada@example.test>",
  "To: Mila Reader <mila@example.test>",
  `Subject: ${subject}`,
  "Date: Thu, 22 Oct 2026 10:00:00 +0200",
  "MIME-Version: 1.0",
  ...extra,
];

const CONTENT_CLASS = "Content-class: urn:content-classes:calendarmessage";

/** A long html invitation: the event card belongs above it, not under it. */
const longHtml = (lead: string): string =>
  `<html><body><p>${lead}</p>${Array.from({ length: 40 }, (_, i) => `<p>Agenda line ${i + 1}: details to read.</p>`).join("")}</body></html>`;

/* ── Google Calendar: the event twice, as the alternative and as invite.ics ─────────────────── */

const GOOGLE_ICS = ics({ uid: "7kq2fixture0google@example.test", summary: "Quarterly planning", start: "20261027T140000", end: "20261027T150000", alarm: true });
const GOOGLE_HTML = longHtml("Ada Organizer has invited you to Quarterly planning.");
export const GOOGLE: InviteShape = {
  name: "google",
  text: "Ada Organizer has invited you to Quarterly planning.",
  html: GOOGLE_HTML,
  calendarHeader: false,
  eml: [
    ...head("google-1", "Invitation: Quarterly planning @ Tue 27 Oct 2026 14:00 - 15:00 (CET)"),
    'Content-Type: multipart/mixed; boundary="MIX"', "",
    "--MIX", 'Content-Type: multipart/alternative; boundary="ALT"', "",
    "--ALT", 'Content-Type: text/plain; charset="UTF-8"', "", "Ada Organizer has invited you to Quarterly planning.", "",
    "--ALT", 'Content-Type: text/html; charset="UTF-8"', "", GOOGLE_HTML, "",
    "--ALT", 'Content-Type: text/calendar; charset="UTF-8"; method=REQUEST', "Content-Transfer-Encoding: 7bit", "", GOOGLE_ICS,
    "--ALT--", "",
    "--MIX", 'Content-Type: application/ics; name="invite.ics"', 'Content-Disposition: attachment; filename="invite.ics"',
    "Content-Transfer-Encoding: base64", "", b64(GOOGLE_ICS), "",
    "--MIX--", "",
  ].join(CRLF),
  parts: [
    { id: "google-alt", filename: null, contentType: "text/calendar; method=REQUEST", inline: false, contentId: null, bytes: GOOGLE_ICS },
    { id: "google-file", filename: "invite.ics", contentType: "application/ics", inline: false, contentId: null, bytes: GOOGLE_ICS },
  ],
};

/* ── Thunderbird: the same pair, the alternative first ───────────────────────────────────────── */

const THUNDERBIRD_ICS = ics({ uid: "a1b2c3d4-thunderbird-fixture", summary: "Reading group", start: "20261029T180000", end: "20261029T193000" });
export const THUNDERBIRD: InviteShape = {
  name: "thunderbird",
  text: "You have been invited to an event.",
  html: null,
  calendarHeader: false,
  eml: [
    ...head("thunderbird-1", "Invitation: Reading group"),
    'Content-Type: multipart/mixed; boundary="MIX"', "",
    "--MIX", 'Content-Type: multipart/alternative; boundary="ALT"', "",
    "--ALT", "Content-Type: text/plain; charset=UTF-8", "", "You have been invited to an event.", "",
    "--ALT", "Content-Type: text/calendar; method=REQUEST; charset=UTF-8", "", THUNDERBIRD_ICS,
    "--ALT--", "",
    "--MIX", 'Content-Type: application/ics; name="invite.ics"', 'Content-Disposition: attachment; filename="invite.ics"', "", THUNDERBIRD_ICS,
    "--MIX--", "",
  ].join(CRLF),
  parts: [
    { id: "thunderbird-alt", filename: null, contentType: "text/calendar; method=REQUEST", inline: false, contentId: null, bytes: THUNDERBIRD_ICS },
    { id: "thunderbird-file", filename: "invite.ics", contentType: "application/ics", inline: false, contentId: null, bytes: THUNDERBIRD_ICS },
  ],
};

/* ── Exchange with iCalendar delivery: one nameless alternative under a long html body ───────── */

const EXCHANGE_ICS = ics({
  uid: "040000008200E00074C5B7101A82E00800000000F0A1B2C3D4E5DC01000000000000000010000000FIXTURE",
  summary: "Budget review", start: "20261028T090000", end: "20261028T100000", windowsZone: true, alarm: true,
});
const EXCHANGE_HTML = longHtml("Microsoft Teams meeting. Join on your computer, mobile app or room device.");
export const EXCHANGE_ICAL: InviteShape = {
  name: "exchange-ical",
  text: "Microsoft Teams meeting. Join on your computer, mobile app or room device.",
  html: EXCHANGE_HTML,
  calendarHeader: true,
  eml: [
    ...head("exchange-1", "Budget review", [CONTENT_CLASS]),
    'Content-Type: multipart/alternative; boundary="ALT"', "",
    "--ALT", 'Content-Type: text/plain; charset="utf-8"', "", "Microsoft Teams meeting. Join on your computer, mobile app or room device.", "",
    "--ALT", 'Content-Type: text/html; charset="utf-8"', "", EXCHANGE_HTML, "",
    "--ALT", 'Content-Type: text/calendar; charset="utf-8"; method=REQUEST', "Content-Transfer-Encoding: base64", "", b64(EXCHANGE_ICS), "",
    "--ALT--", "",
  ].join(CRLF),
  parts: [
    { id: "exchange-alt", filename: null, contentType: "text/calendar; method=REQUEST", inline: false, contentId: null, bytes: EXCHANGE_ICS },
  ],
};

/* ── Outlook desktop: the alternative under multipart/related, beside the signature logo ─────── */

const OUTLOOK_ICS = ics({ uid: "outlook-related-fixture-0001", summary: "Supplier call", start: "20261030T110000", end: "20261030T113000", windowsZone: true });
const PNG_BYTES = "\x89PNG\r\n\x1a\nfixture-logo";
const OUTLOOK_HTML = `<html><body><p>Agenda for the supplier call.</p><img src="cid:image001.png@01DB2A00.FIXTURE0"></body></html>`;
export const OUTLOOK_RELATED: InviteShape = {
  name: "outlook-related",
  text: "Agenda for the supplier call.",
  html: OUTLOOK_HTML,
  calendarHeader: true,
  eml: [
    ...head("outlook-1", "Supplier call", [CONTENT_CLASS]),
    'Content-Type: multipart/related; boundary="REL"; type="multipart/alternative"', "",
    "--REL", 'Content-Type: multipart/alternative; boundary="ALT"', "",
    "--ALT", 'Content-Type: text/plain; charset="utf-8"', "", "Agenda for the supplier call.", "",
    "--ALT", 'Content-Type: text/html; charset="utf-8"', "", OUTLOOK_HTML, "",
    "--ALT", 'Content-Type: text/calendar; charset="utf-8"; method=REQUEST', "Content-Transfer-Encoding: base64", "", b64(OUTLOOK_ICS), "",
    "--ALT--", "",
    "--REL", 'Content-Type: image/png; name="image001.png"', 'Content-Disposition: inline; filename="image001.png"',
    "Content-ID: <image001.png@01DB2A00.FIXTURE0>", "Content-Transfer-Encoding: base64", "", b64(PNG_BYTES), "",
    "--REL--", "",
  ].join(CRLF),
  parts: [
    { id: "outlook-alt", filename: null, contentType: "text/calendar; method=REQUEST", inline: false, contentId: null, bytes: OUTLOOK_ICS },
    { id: "outlook-logo", filename: "image001.png", contentType: "image/png", inline: true, contentId: "image001.png@01DB2A00.FIXTURE0", bytes: PNG_BYTES },
  ],
};

/* ── A calendar part with a Content-ID under multipart/related: stored inline ─────────────────── */

const EMBEDDED_ICS = ics({ uid: "embedded-calendar-fixture", summary: "Site visit", start: "20261102T080000", end: "20261102T120000" });
export const EMBEDDED_CALENDAR: InviteShape = {
  name: "embedded-calendar",
  text: "",
  html: "<p>See the event below.</p>",
  calendarHeader: false,
  eml: [
    ...head("embedded-1", "Site visit"),
    'Content-Type: multipart/related; boundary="REL"', "",
    "--REL", 'Content-Type: text/html; charset="utf-8"', "", "<p>See the event below.</p>", "",
    "--REL", 'Content-Type: text/calendar; charset="utf-8"; method=REQUEST', "Content-ID: <cal-part-1@example.test>", "", EMBEDDED_ICS,
    "--REL--", "",
  ].join(CRLF),
  parts: [
    { id: "embedded-cal", filename: null, contentType: "text/calendar; method=REQUEST", inline: true, contentId: "cal-part-1@example.test", bytes: EMBEDDED_ICS },
  ],
};

/* ── Apple Calendar: one named, disposed text/calendar attachment ────────────────────────────── */

const APPLE_ICS = ics({ uid: "5F1C0E2A-APPLE-FIXTURE-0001", summary: "Dinner with the team", start: "20261031T193000", end: "20261031T220000" });
export const APPLE: InviteShape = {
  name: "apple",
  text: "Ada Organizer has invited you.",
  html: null,
  calendarHeader: false,
  eml: [
    ...head("apple-1", "Invitation: Dinner with the team"),
    'Content-Type: multipart/mixed; boundary="MIX"', "",
    "--MIX", "Content-Type: text/plain; charset=utf-8", "", "Ada Organizer has invited you.", "",
    "--MIX", 'Content-Type: text/calendar; charset=utf-8; method=REQUEST; name="iCal-20261022-100000.ics"',
    'Content-Disposition: attachment; filename="iCal-20261022-100000.ics"', "Content-Transfer-Encoding: base64", "", b64(APPLE_ICS), "",
    "--MIX--", "",
  ].join(CRLF),
  parts: [
    { id: "apple-file", filename: "iCal-20261022-100000.ics", contentType: "text/calendar; method=REQUEST", inline: false, contentId: null, bytes: APPLE_ICS },
  ],
};

/* ── A bare iTIP message: the whole message is the calendar ──────────────────────────────────── */

const SINGLE_ICS = ics({ uid: "single-part-itip-fixture", summary: "Stand-up", start: "20261103T091500", end: "20261103T093000" });
export const SINGLE_PART_ITIP: InviteShape = {
  name: "single-part-itip",
  text: "",
  html: null,
  calendarHeader: false,
  eml: [
    ...head("single-1", "Stand-up"),
    'Content-Type: text/calendar; charset="utf-8"; method=REQUEST', "", SINGLE_ICS,
  ].join(CRLF),
  parts: [
    { id: "single-cal", filename: null, contentType: "text/calendar; method=REQUEST", inline: false, contentId: null, bytes: SINGLE_ICS },
  ],
};

/* ── TNEF (winmail.dat): the event is sealed in Microsoft's format, no calendar part ─────────── */

const TNEF_BYTES = "\x78\x9f\x3e\x22fixture-tnef";
export const TNEF: InviteShape = {
  name: "tnef",
  text: "Meeting about the roadmap.",
  html: null,
  calendarHeader: true,
  eml: [
    ...head("tnef-1", "Roadmap", [CONTENT_CLASS]),
    'Content-Type: multipart/mixed; boundary="MIX"', "",
    "--MIX", 'Content-Type: text/plain; charset="utf-8"', "", "Meeting about the roadmap.", "",
    "--MIX", 'Content-Type: application/ms-tnef; name="winmail.dat"', 'Content-Disposition: attachment; filename="winmail.dat"',
    "Content-Transfer-Encoding: base64", "", b64(TNEF_BYTES), "",
    "--MIX--", "",
  ].join(CRLF),
  parts: [
    { id: "tnef-dat", filename: "winmail.dat", contentType: "application/ms-tnef", inline: false, contentId: null, bytes: TNEF_BYTES },
  ],
};

/* ── No invitation: a calendar file somebody attached by hand (no METHOD, no calendar header) ──── */

const PLAIN_FILE_ICS = ics({ uid: "plain-file-fixture@example.test", method: null, summary: "Office closed", start: "20261224T000000", end: "20261227T000000" });
export const PLAIN_ICS_FILE: InviteShape = {
  name: "plain-ics-file",
  text: "The holiday dates, for your calendar.",
  html: null,
  calendarHeader: false,
  eml: [
    ...head("plain-file-1", "Holiday dates"),
    'Content-Type: multipart/mixed; boundary="MIX"', "",
    "--MIX", "Content-Type: text/plain; charset=utf-8", "", "The holiday dates, for your calendar.", "",
    "--MIX", 'Content-Type: text/calendar; charset=utf-8; name="holidays.ics"', 'Content-Disposition: attachment; filename="holidays.ics"',
    "Content-Transfer-Encoding: base64", "", b64(PLAIN_FILE_ICS), "",
    "--MIX--", "",
  ].join(CRLF),
  parts: [
    { id: "plain-file", filename: "holidays.ics", contentType: "text/calendar", inline: false, contentId: null, bytes: PLAIN_FILE_ICS },
  ],
};

/* ── Two different events in one message: two cards ──────────────────────────────────────────── */

const FIRST_ICS = ics({ uid: "two-events-first@example.test", summary: "Workshop day one", start: "20261104T090000", end: "20261104T170000" });
const SECOND_ICS = ics({ uid: "two-events-second@example.test", summary: "Workshop day two", start: "20261105T090000", end: "20261105T170000" });
export const TWO_EVENTS: InviteShape = {
  name: "two-events",
  text: "Both workshop days are attached.",
  html: null,
  calendarHeader: false,
  eml: [
    ...head("two-1", "Workshop days"),
    'Content-Type: multipart/mixed; boundary="MIX"', "",
    "--MIX", "Content-Type: text/plain; charset=utf-8", "", "Both workshop days are attached.", "",
    "--MIX", 'Content-Type: text/calendar; charset=utf-8; name="invite.ics"', 'Content-Disposition: attachment; filename="invite.ics"', "", FIRST_ICS,
    "--MIX", 'Content-Type: text/calendar; charset=utf-8; name="invite.ics"', 'Content-Disposition: attachment; filename="invite.ics"', "", SECOND_ICS,
    "--MIX--", "",
  ].join(CRLF),
  parts: [
    { id: "two-first", filename: "invite.ics", contentType: "text/calendar", inline: false, contentId: null, bytes: FIRST_ICS },
    { id: "two-second", filename: "invite.ics", contentType: "text/calendar", inline: false, contentId: null, bytes: SECOND_ICS },
  ],
};

/* ── One event, the original and its update (same UID, SEQUENCE 0 then 1): one card, the update ── */

const ORIGINAL_ICS = ics({ uid: "update-sequence-fixture", sequence: 0, summary: "Design review", start: "20261106T140000", end: "20261106T150000" });
const UPDATED_ICS = ics({ uid: "update-sequence-fixture", sequence: 1, summary: "Design review", start: "20261106T160000", end: "20261106T170000" });
export const UPDATE_SEQUENCE: InviteShape = {
  name: "update-sequence",
  text: "The review moved to four.",
  html: null,
  calendarHeader: false,
  eml: [
    ...head("update-1", "Updated invitation: Design review"),
    'Content-Type: multipart/mixed; boundary="MIX"', "",
    "--MIX", "Content-Type: text/plain; charset=utf-8", "", "The review moved to four.", "",
    "--MIX", 'Content-Type: text/calendar; charset=utf-8; method=REQUEST; name="original.ics"', 'Content-Disposition: attachment; filename="original.ics"', "", ORIGINAL_ICS,
    "--MIX", 'Content-Type: text/calendar; charset=utf-8; method=REQUEST; name="updated.ics"', 'Content-Disposition: attachment; filename="updated.ics"', "", UPDATED_ICS,
    "--MIX--", "",
  ].join(CRLF),
  parts: [
    { id: "update-original", filename: "original.ics", contentType: "text/calendar; method=REQUEST", inline: false, contentId: null, bytes: ORIGINAL_ICS },
    { id: "update-updated", filename: "updated.ics", contentType: "text/calendar; method=REQUEST", inline: false, contentId: null, bytes: UPDATED_ICS },
  ],
};

/* ── Hostile: no DTEND and a DURATION past the range of a Date: one card, the start only ──────── */

/** One VEVENT with a DTSTART line as given, no DTEND, and the DURATION as given. */
export function icsWithDuration(dtstart: string, duration: string): string {
  return [
    "BEGIN:VCALENDAR", "PRODID:-//Example Calendar//Fixture//EN", "VERSION:2.0", "METHOD:REQUEST",
    "BEGIN:VEVENT", "UID:hostile-duration-fixture", "SEQUENCE:0", "SUMMARY:Endless meeting",
    dtstart, `DURATION:${duration}`,
    "ORGANIZER;CN=Ada Organizer:mailto:ada@example.test",
    "END:VEVENT", "END:VCALENDAR", "",
  ].join(CRLF);
}

const HOSTILE_ICS = icsWithDuration("DTSTART;TZID=Europe/Zurich:20261027T140000", "P999999999D");
export const HOSTILE_DURATION: InviteShape = {
  name: "hostile-duration",
  text: "You are invited.",
  html: null,
  calendarHeader: false,
  eml: [
    ...head("hostile-1", "Endless meeting"),
    'Content-Type: multipart/mixed; boundary="MIX"', "",
    "--MIX", "Content-Type: text/plain; charset=utf-8", "", "You are invited.", "",
    "--MIX", 'Content-Type: text/calendar; charset=utf-8; method=REQUEST; name="invite.ics"',
    'Content-Disposition: attachment; filename="invite.ics"', "", HOSTILE_ICS,
    "--MIX--", "",
  ].join(CRLF),
  parts: [
    { id: "hostile-file", filename: "invite.ics", contentType: "text/calendar; method=REQUEST", inline: false, contentId: null, bytes: HOSTILE_ICS },
  ],
};

/* ── Hostile: one sender-written value as long as the calendar budget lets it be ──────────────── */

/** RFC 5545 folding: at most 75 characters a line, each continuation opened by one space. */
function fold(line: string): string {
  const out = [line.slice(0, 75)];
  for (let i = 75; i < line.length; i += 74) out.push(` ${line.slice(i, i + 74)}`);
  return out.join(CRLF);
}

export interface OversizedSpec {
  uid: string;
  summary?: string;
  location?: string;
  /** The organizer's CN. */
  organizer?: string;
  /** DTSTART's TZID; DTEND stays UTC. */
  tzid?: string;
}

/** One VEVENT carrying the given values whole, folded the RFC way; the rest of it ordinary. */
export function icsOversized(spec: OversizedSpec): string {
  return [
    "BEGIN:VCALENDAR", "PRODID:-//Example Calendar//Fixture//EN", "VERSION:2.0", "METHOD:REQUEST",
    "BEGIN:VEVENT", `UID:${spec.uid}`, "SEQUENCE:0",
    fold(`SUMMARY:${spec.summary ?? "Sync"}`),
    spec.tzid === undefined ? "DTSTART:20261103T090000Z" : fold(`DTSTART;TZID=${spec.tzid}:20261103T100000`),
    "DTEND:20261103T100000Z",
    fold(`LOCATION:${spec.location ?? "Room Aare"}`),
    fold(`ORGANIZER;CN=${spec.organizer ?? "Ada Organizer"}:mailto:ada@example.test`),
    "ATTENDEE;CN=Mila Reader;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:mila@example.test",
    "END:VEVENT", "END:VCALENDAR", "",
  ].join(CRLF);
}

export const INVITE_SHAPES: readonly InviteShape[] = [
  GOOGLE, THUNDERBIRD, EXCHANGE_ICAL, OUTLOOK_RELATED, EMBEDDED_CALENDAR, APPLE, SINGLE_PART_ITIP, TNEF, TWO_EVENTS, UPDATE_SEQUENCE,
  HOSTILE_DURATION,
];

/** How many event cards each shape should show. */
export const CARDS_EXPECTED: Readonly<Record<string, number>> = {
  google: 1, thunderbird: 1, "exchange-ical": 1, "outlook-related": 1, "embedded-calendar": 1, apple: 1,
  "single-part-itip": 1, tnef: 0, "two-events": 2, "update-sequence": 1, "hostile-duration": 1,
};
