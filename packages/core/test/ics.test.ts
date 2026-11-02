import { describe, it, expect } from "vitest";
import {
  parseIcsEvent,
  isCalendarMime,
  CALENDAR_FALLBACK_FILENAME,
  ICS_PARSE_MAX_CHARS,
} from "../src/ics.js";

/**
 * ═══ THE PARSER'S CORPUS — REAL SHAPES, NOT IDEALIZED ONES ═══════════════════════════════════
 *
 * Three producers dominate the live mailbox's calendar parts, and each writes a different
 * dialect of RFC 5545:
 *
 *   · Google Calendar — IANA TZIDs (`Europe/Zurich`), folded DESCRIPTION lines, the part nested
 *     nameless under `multipart/alternative` (part 1.3 in every sampled row).
 *   · Exchange/Outlook — WINDOWS zone names (`W. Europe Standard Time`), a VTIMEZONE block whose
 *     own DTSTART/RRULE lines are a trap for a parser that does not track component nesting,
 *     and `X-MS-OLDSTART`/`X-MS-OLDEND` on a COUNTER (MS-OXCICAL) carrying the original time.
 *   · Apple Mail replies — `iCal-Reply.ics`, METHOD:REPLY with the replying attendee's PARTSTAT.
 *
 * Every fixture below mirrors one of those dialects. The Exchange COUNTER one mirrors the shape
 * of the specimen this slice was cut for ("Neuer Zeitvorschlag: STUDIO KICKOFF") — the shape
 * that mail WOULD have had, had Exchange's IMAP front door not replaced it with an OWA link.
 */

/** Outlook counter-proposal: Windows TZID, VTIMEZONE trap lines, old→new times, German summary. */
const EXCHANGE_COUNTER = [
  "BEGIN:VCALENDAR",
  "METHOD:COUNTER",
  "PRODID:Microsoft Exchange Server 2010",
  "VERSION:2.0",
  "BEGIN:VTIMEZONE",
  "TZID:W. Europe Standard Time",
  "BEGIN:STANDARD",
  // The trap: a naive line scan reads THIS as the event's start (year 1601) and THIS RRULE
  // as the event's recurrence ("yearly"). The nesting walk is what keeps them out.
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
  "BEGIN:VEVENT",
  "ORGANIZER;CN=Mila Brunner:mailto:mila@lichtgrat.example",
  "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=Jonas Halter:mai",
  " lto:jonas.halter@lichtgrat.example",
  "SUMMARY;LANGUAGE=de-DE:STUDIO KICKOFF",
  "DTSTART;TZID=W. Europe Standard Time:20260819T140000",
  "DTEND;TZID=W. Europe Standard Time:20260819T150000",
  "UID:040000008200E00074C5B7101A82E00800000000F1",
  "X-MS-OLDSTART:20260819T070000Z",
  "X-MS-OLDEND:20260819T080000Z",
  "LOCATION:Sitzungszimmer 2. OG",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

/** Google invitation: IANA TZID, quoted param, recurrence, several attendees. */
const GOOGLE_REQUEST = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "VERSION:2.0",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  'DTSTART;TZID="Europe/Zurich":20260915T083000',
  'DTEND;TZID="Europe/Zurich":20260915T173000',
  "RRULE:FREQ=WEEKLY;BYDAY=TU",
  "ORGANIZER;CN=Petra Wyss:mailto:petra.wyss@atelier.example",
  "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=Mi",
  " la Brunner;X-NUM-GUESTS=0:mailto:mila@lichtgrat.example",
  "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=reto.frei@ateli",
  " er.example;X-NUM-GUESTS=0:mailto:reto.frei@atelier.example",
  "SUMMARY:Kurs mit Mila - M\\u00e4rchenstadt".replace("\\u00e4", "ä"),
  "LOCATION:Musterstrasse 17\\, M\\u00e4rchenstadt".replace("\\u00e4", "ä"),
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

describe("isCalendarMime", () => {
  it("matches text/calendar and application/ics, parameters and case ignored", () => {
    expect(isCalendarMime("text/calendar")).toBe(true);
    expect(isCalendarMime("text/calendar; charset=utf-8; method=REQUEST")).toBe(true);
    expect(isCalendarMime("TEXT/CALENDAR")).toBe(true);
    expect(isCalendarMime("application/ics")).toBe(true);
    expect(isCalendarMime("text/plain")).toBe(false);
    expect(isCalendarMime("application/pdf")).toBe(false);
    expect(isCalendarMime("")).toBe(false);
  });

  it("names the fallback file an invite", () => {
    expect(CALENDAR_FALLBACK_FILENAME).toBe("invite.ics");
  });
});

describe("parseIcsEvent — the Exchange COUNTER dialect (the specimen's shape)", () => {
  const ev = parseIcsEvent(EXCHANGE_COUNTER)!;

  it("parses", () => {
    expect(ev).not.toBeNull();
  });

  it("reads METHOD:COUNTER from the VCALENDAR level", () => {
    expect(ev.method).toBe("COUNTER");
  });

  it("maps the Windows zone name and resolves the proposed time to the right instant", () => {
    // 14:00 W. Europe (CEST in August, UTC+2) = 12:00Z.
    expect(ev.start.epochMs).toBe(utc(2026, 8, 19, 12, 0));
    expect(ev.end?.epochMs).toBe(utc(2026, 8, 19, 13, 0));
    expect(ev.start.allDay).toBe(false);
  });

  it("never mistakes the VTIMEZONE's own DTSTART or RRULE for the event's", () => {
    expect(ev.start.wall.year).toBe(2026);
    expect(ev.recurrence).toBeNull();
  });

  it("carries the original time from X-MS-OLDSTART/X-MS-OLDEND", () => {
    expect(ev.oldStart?.epochMs).toBe(utc(2026, 8, 19, 7, 0));
    expect(ev.oldEnd?.epochMs).toBe(utc(2026, 8, 19, 8, 0));
  });

  it("unfolds the folded ATTENDEE line and reads people as name + address, never a link", () => {
    expect(ev.summary).toBe("STUDIO KICKOFF");
    expect(ev.location).toBe("Sitzungszimmer 2. OG");
    expect(ev.organizer).toEqual({ name: "Mila Brunner", email: "mila@lichtgrat.example" });
    expect(ev.attendees).toEqual([
      { name: "Jonas Halter", email: "jonas.halter@lichtgrat.example" },
    ]);
    expect(ev.attendeeCount).toBe(1);
  });
});

describe("parseIcsEvent — the Google REQUEST dialect", () => {
  const ev = parseIcsEvent(GOOGLE_REQUEST)!;

  it("resolves a quoted IANA TZID (CEST, +02:00 in September)", () => {
    expect(ev.method).toBe("REQUEST");
    expect(ev.start.epochMs).toBe(utc(2026, 9, 15, 6, 30));
    expect(ev.end?.epochMs).toBe(utc(2026, 9, 15, 15, 30));
    expect(ev.start.tzid).toBe("Europe/Zurich");
  });

  it("unescapes text values (the comma in LOCATION)", () => {
    expect(ev.location).toBe("Musterstrasse 17, Märchenstadt");
  });

  it("reads the trivial weekly rule as structure", () => {
    expect(ev.recurrence).toEqual({ freq: "WEEKLY", interval: 1, byDay: ["TU"] });
  });

  it("collects the attendees and the organizer", () => {
    expect(ev.attendeeCount).toBe(2);
    expect(ev.attendees[0]).toEqual({ name: "Mila Brunner", email: "mila@lichtgrat.example" });
  });
});

describe("parseIcsEvent — time forms", () => {
  const wrap = (lines: string[]) =>
    ["BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", ...lines, "END:VEVENT", "END:VCALENDAR"].join("\r\n");

  it("UTC form (trailing Z) is exact", () => {
    const ev = parseIcsEvent(wrap(["SUMMARY:Sync", "DTSTART:20260713T123000Z", "DTEND:20260713T130000Z"]))!;
    expect(ev.start.epochMs).toBe(utc(2026, 7, 13, 12, 30));
    expect(ev.start.utc).toBe(true);
    expect(ev.start.tzid).toBeNull();
  });

  it("VALUE=DATE is an all-day event with an exclusive end", () => {
    const ev = parseIcsEvent(wrap(["SUMMARY:Holiday", "DTSTART;VALUE=DATE:20260915", "DTEND;VALUE=DATE:20260917"]))!;
    expect(ev.start.allDay).toBe(true);
    expect(ev.start.epochMs).toBe(utc(2026, 9, 15));
    expect(ev.end?.allDay).toBe(true);
    expect(ev.end?.epochMs).toBe(utc(2026, 9, 17));
  });

  it("a TZID this runtime does not know keeps the wall time and the label, epoch honestly null", () => {
    const ev = parseIcsEvent(wrap(["SUMMARY:X", "DTSTART;TZID=Middle Earth Standard Time:20260819T140000"]))!;
    expect(ev.start.epochMs).toBeNull();
    expect(ev.start.tzid).toBe("Middle Earth Standard Time");
    expect(ev.start.wall).toEqual({ year: 2026, month: 8, day: 19, hour: 14, minute: 0 });
  });

  it.each([
    "/freeassociation.sourceforge.net/Tzfile/Europe/Berlin",
    "/freeassociation.sourceforge.net/Europe/Berlin",
    "/mozilla.org/20050126_1/Europe/Berlin",
    "/softwarestudio.org/Olson_20011030_5/Europe/Berlin",
  ])("a libical or Lightning prefixed TZID resolves to its Olson zone (%s)", (tzid) => {
    const ev = parseIcsEvent(wrap(["SUMMARY:X", `DTSTART;TZID=${tzid}:20260819T140000`]))!;
    expect(ev.start.epochMs).toBe(utc(2026, 8, 19, 12, 0));
    expect(ev.start.tzid).toBe(tzid);
  });

  it("a prefixed TZID resolves even when the prefix takes it past the label length", () => {
    const tzid = "/freeassociation.sourceforge.net/Tzfile/America/Argentina/ComodRivadavia";
    expect(tzid.length).toBeGreaterThan(64);
    const ev = parseIcsEvent(wrap(["SUMMARY:X", `DTSTART;TZID=${tzid}:20260819T140000`]))!;
    expect(ev.start.epochMs).toBe(utc(2026, 8, 19, 17, 0));
  });

  it("a floating time (no TZID, no Z) carries the wall fields with no zone claim", () => {
    const ev = parseIcsEvent(wrap(["SUMMARY:X", "DTSTART:20260819T140000"]))!;
    expect(ev.start.epochMs).toBeNull();
    expect(ev.start.tzid).toBeNull();
    expect(ev.start.utc).toBe(false);
    expect(ev.start.wall.hour).toBe(14);
  });

  it("winter and summer resolve to different offsets for the same zone", () => {
    const winter = parseIcsEvent(wrap(["SUMMARY:X", "DTSTART;TZID=Europe/Zurich:20261209T140000"]))!;
    expect(winter.start.epochMs).toBe(utc(2026, 12, 9, 13, 0)); // CET, +01:00
  });

  it("DTEND absent + DURATION present derives the end", () => {
    const ev = parseIcsEvent(wrap(["SUMMARY:X", "DTSTART:20260713T120000Z", "DURATION:PT1H30M"]))!;
    expect(ev.end?.epochMs).toBe(utc(2026, 7, 13, 13, 30));
  });
});

describe("parseIcsEvent — method semantics", () => {
  const wrap = (method: string, lines: string[]) =>
    ["BEGIN:VCALENDAR", `METHOD:${method}`, "BEGIN:VEVENT", "DTSTART:20260713T120000Z", ...lines, "END:VEVENT", "END:VCALENDAR"].join("\r\n");

  it("CANCEL reads as cancelled", () => {
    const ev = parseIcsEvent(wrap("CANCEL", ["SUMMARY:Gone"]))!;
    expect(ev.method).toBe("CANCEL");
    expect(ev.cancelled).toBe(true);
  });

  it("STATUS:CANCELLED reads as cancelled whatever the method", () => {
    const ev = parseIcsEvent(wrap("REQUEST", ["SUMMARY:Gone", "STATUS:CANCELLED"]))!;
    expect(ev.cancelled).toBe(true);
  });

  it("REPLY carries the replying attendee's answer", () => {
    const ev = parseIcsEvent(
      wrap("REPLY", ["SUMMARY:Sync", "ATTENDEE;PARTSTAT=TENTATIVE;CN=Mila:mailto:mila@lichtgrat.example"]),
    )!;
    expect(ev.method).toBe("REPLY");
    expect(ev.replyStatus).toBe("TENTATIVE");
  });
});

describe("parseIcsEvent — refusals (the plain-row degradations)", () => {
  it("no VEVENT → null", () => {
    expect(parseIcsEvent("BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR")).toBeNull();
  });

  it("a VEVENT with no parseable DTSTART → null", () => {
    expect(
      parseIcsEvent("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:X\r\nDTSTART:whenever\r\nEND:VEVENT\r\nEND:VCALENDAR"),
    ).toBeNull();
    expect(
      parseIcsEvent("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:X\r\nEND:VEVENT\r\nEND:VCALENDAR"),
    ).toBeNull();
  });

  it("not ics at all → null, whatever it contains", () => {
    expect(parseIcsEvent("")).toBeNull();
    expect(parseIcsEvent("%PDF-1.4 …")).toBeNull();
    expect(parseIcsEvent("<html><script>alert(1)</script></html>")).toBeNull();
  });

  it("input over the parse ceiling → null, however valid", () => {
    const pad = `X-FILLER:${"a".repeat(ICS_PARSE_MAX_CHARS)}\r\n`;
    const big = `BEGIN:VCALENDAR\r\n${pad}BEGIN:VEVENT\r\nDTSTART:20260713T120000Z\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    expect(parseIcsEvent(big)).toBeNull();
  });

  it("an out-of-range date → null rather than a nonsense instant", () => {
    expect(
      parseIcsEvent("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20261341T120000Z\r\nEND:VEVENT\r\nEND:VCALENDAR"),
    ).toBeNull();
  });
});

describe("parseIcsEvent — hostile text stays text", () => {
  it("a SUMMARY carrying markup is returned verbatim as a string, nothing interpreted", () => {
    const ev = parseIcsEvent(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "DTSTART:20260713T120000Z",
        "SUMMARY:<script>alert('xss')</script>\\nLine2",
        "LOCATION:javascript:alert(1)",
        "ORGANIZER;CN=<img onerror=x>:mailto:EVIL@EXAMPLE.COM?subject=hi",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    )!;
    // The \n escape decodes to a newline; the markup stays inert text for the renderer to escape.
    expect(ev.summary).toBe("<script>alert('xss')</script>\nLine2");
    expect(ev.location).toBe("javascript:alert(1)");
    // mailto: is stripped to an address; anything after ? (header injection into a live link) too.
    expect(ev.organizer?.email).toBe("evil@example.com");
    expect(ev.organizer?.name).toBe("<img onerror=x>");
  });

  it("an ORGANIZER whose URI is not mailto: yields no email at all", () => {
    // `sip:` is a real CAL-ADDRESS scheme and its address part LOOKS like a mail address —
    // the case that catches an extractor which strips any scheme and keeps whatever has an @.
    const ev = parseIcsEvent(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "DTSTART:20260713T120000Z",
        "ORGANIZER;CN=Evil:sip:user@example.com",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    )!;
    expect(ev.organizer).toEqual({ name: "Evil", email: null });
  });
});

describe("parseIcsEvent — recurrence stays honest", () => {
  const wrap = (rrule: string) =>
    ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "DTSTART:20260713T120000Z", rrule, "END:VEVENT", "END:VCALENDAR"].join("\r\n");

  it("weekly with an interval survives", () => {
    expect(parseIcsEvent(wrap("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO"))!.recurrence).toEqual({
      freq: "WEEKLY",
      interval: 2,
      byDay: ["MO"],
    });
  });

  it("a rule with ordinal BYDAY (2nd Tuesday) is NOT trivially derivable → null", () => {
    expect(parseIcsEvent(wrap("RRULE:FREQ=MONTHLY;BYDAY=2TU"))!.recurrence).toBeNull();
  });

  it("a rule with BYMONTHDAY/BYSETPOS complexity → null", () => {
    expect(parseIcsEvent(wrap("RRULE:FREQ=MONTHLY;BYMONTHDAY=15"))!.recurrence).toBeNull();
    expect(parseIcsEvent(wrap("RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1"))!.recurrence).toBeNull();
  });
});
