import { describe, expect, it, vi } from "vitest";
import {
  INVITATION_ATTENDEES_MAX, INVITATION_LINES_MAX, INVITATION_PART_MAX_BYTES, isPlainAddress, readLetterInvitation,
} from "../src/invitation-mail.js";
import type { CalendarPartText } from "../src/ics.js";

/**
 * THE IDENTITY A LETTER'S CALENDAR PART GIVES ITS EVENT, read at ingest: which event, which
 * occurrence and revision, what the letter asks, who organizes and who is invited. The input is a
 * stranger's text read on a server, so every bound is a count and a value past one keeps no row.
 */

const ME = "mila@lichtgrat.example";

/** A calendar text: `head` at VCALENDAR level, `event` inside the one VEVENT, CRLF line ends. */
function ics(head: readonly string[], event: readonly string[], tail: readonly string[] = []): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", ...head, "BEGIN:VEVENT", ...event, "END:VEVENT", ...tail, "END:VCALENDAR"]
    .map((l) => `${l}\r\n`).join("");
}

const part = (text: string, contentType = "text/calendar; method=REQUEST", id = "1"): CalendarPartText => ({ id, contentType, text });
const read = (text: string, contentType?: string) => readLetterInvitation([part(text, contentType)]);

const REQUEST_EVENT = [
  "UID:kickoff-17@studio.example",
  "SEQUENCE:2",
  "DTSTAMP:20261110T090000Z",
  "DTSTART;TZID=Europe/Zurich:20261201T110000",
  "DTEND;TZID=Europe/Zurich:20261201T120000",
  "SUMMARY:Kickoff",
  "ORGANIZER;CN=Tobias:mailto:tobias@studio.example",
  "ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:Mila@Lichtgrat.example",
  "ATTENDEE;PARTSTAT=ACCEPTED:mailto:tobias@studio.example",
];

describe("the four methods that keep a row", () => {
  it("a REQUEST: its identity, start, organizer and every plain invitee as spelled", () => {
    expect(read(ics(["METHOD:REQUEST"], REQUEST_EVENT))).toEqual({
      method: "REQUEST", uid: "kickoff-17@studio.example", recurrenceId: "", sequence: 2,
      startRaw: "20261201T110000", startsAt: new Date("2026-12-01T10:00:00Z"),
      organizer: "tobias@studio.example",
      attendees: ["Mila@Lichtgrat.example", "tobias@studio.example"],
      stampedAt: new Date("2026-11-10T09:00:00Z"),
      reply: null,
    });
  });

  it("a REPLY: the one attendee, the answer it gives and its stamp", () => {
    const got = read(ics(["METHOD:REPLY"], [
      "UID:kickoff-17@studio.example", "SEQUENCE:2", "DTSTAMP:20261111T080000Z",
      "ORGANIZER:mailto:tobias@studio.example", `ATTENDEE;PARTSTAT=TENTATIVE:mailto:${ME}`,
    ]), "text/calendar; method=REPLY");
    expect(got).toMatchObject({
      method: "REPLY", sequence: 2, startRaw: null, startsAt: null, attendees: [ME],
      reply: { answer: "tentative", at: new Date("2026-11-11T08:00:00Z") },
    });
  });

  it("a REPLY's stamp keeps its seconds, so two answers given within one minute keep their order", () => {
    const at = (stamp: string) => read(ics(["METHOD:REPLY"], [
      "UID:a@b.example", `DTSTAMP:${stamp}`, `ATTENDEE;PARTSTAT=DECLINED:mailto:${ME}`,
    ]))?.reply?.at;
    expect(at("20261111T080015Z")).toEqual(new Date("2026-11-11T08:00:15Z"));
    expect(at("20261111T080059Z")!.getTime()).toBeGreaterThan(at("20261111T080015Z")!.getTime());
    // A stamp that is no UTC date-time is none: the letter's own date stands in for it.
    expect(at("20261111T080015")).toBeNull();
    expect(at("20261111")).toBeNull();
  });

  it("every method keeps its stamp, to the second: it orders one revision's letters", () => {
    const stamped = (method: string, stamp: string) => read(ics([`METHOD:${method}`], [
      "UID:a@b.example", "SEQUENCE:1", `DTSTAMP:${stamp}`, "ORGANIZER:mailto:o@b.example", `ATTENDEE:mailto:${ME}`,
    ]))?.stampedAt;
    expect(stamped("REQUEST", "20261113T080005Z")).toEqual(new Date("2026-11-13T08:00:05Z"));
    expect(stamped("CANCEL", "20261111T080000Z")).toEqual(new Date("2026-11-11T08:00:00Z"));
    expect(stamped("COUNTER", "20261111T080000")).toBeNull();
    expect(read(ics(["METHOD:CANCEL"], ["UID:a@b.example"]))?.stampedAt).toBeNull();
  });

  it("a REPLY whose answer is not one of the three carries none", () => {
    const got = read(ics(["METHOD:REPLY"], ["UID:a@b.example", `ATTENDEE;PARTSTAT=DELEGATED:mailto:${ME}`]));
    expect(got).toMatchObject({ method: "REPLY", reply: null, attendees: [ME] });
  });

  it("a CANCEL and a COUNTER, with or without a start", () => {
    expect(read(ics(["METHOD:CANCEL"], ["UID:a@b.example", "SEQUENCE:3", "ORGANIZER:mailto:o@b.example"])))
      .toMatchObject({ method: "CANCEL", sequence: 3, startRaw: null, startsAt: null, organizer: "o@b.example", attendees: [] });
    expect(read(ics(["METHOD:COUNTER"], ["UID:a@b.example", "DTSTART:20261201T100000Z"])))
      .toMatchObject({ method: "COUNTER", sequence: 0, startRaw: "20261201T100000Z", startsAt: new Date("2026-12-01T10:00:00Z") });
  });

  it("a REQUEST whose event is cancelled is kept as a CANCEL", () => {
    expect(read(ics(["METHOD:REQUEST"], [...REQUEST_EVENT, "STATUS:CANCELLED"]))?.method).toBe("CANCEL");
  });

  it("a whole day and a floating time keep their written start; a zone nobody knows keeps no instant", () => {
    expect(read(ics(["METHOD:REQUEST"], ["UID:a@b.example", "DTSTART;VALUE=DATE:20261224"])))
      .toMatchObject({ startRaw: "20261224", startsAt: new Date("2026-12-24T00:00:00Z") });
    expect(read(ics(["METHOD:REQUEST"], ["UID:a@b.example", "DTSTART:20261224T090000"])))
      .toMatchObject({ startRaw: "20261224T090000", startsAt: null });
    expect(read(ics(["METHOD:REQUEST"], ["UID:a@b.example", "DTSTART;TZID=Middle Earth:20261224T090000"])))
      .toMatchObject({ startRaw: "20261224T090000", startsAt: null });
    // A start that does not read is no start; the invitation still has its row.
    expect(read(ics(["METHOD:REQUEST"], ["UID:a@b.example", "DTSTART:20261332T090000"])))
      .toMatchObject({ startRaw: null, startsAt: null });
  });
});

describe("no row", () => {
  it("for a published event, an unlisted method, a calendar without METHOD, and an event without UID", () => {
    for (const method of ["PUBLISH", "ADD", "REFRESH", "DECLINECOUNTER", "FROBNICATE"]) {
      expect(read(ics([`METHOD:${method}`], REQUEST_EVENT)), method).toBeUndefined();
    }
    expect(read(ics([], REQUEST_EVENT))).toBeUndefined();
    expect(read(ics(["METHOD:REQUEST"], REQUEST_EVENT.filter((l) => !l.startsWith("UID"))))).toBeUndefined();
    expect(read(ics(["METHOD:REQUEST"], ["UID:   "]))).toBeUndefined();
  });

  it("the Content-Type's method never decides: the calendar's own METHOD line does", () => {
    expect(read(ics(["METHOD:PUBLISH"], REQUEST_EVENT), "text/calendar; method=REQUEST")).toBeUndefined();
    expect(read(ics(["METHOD:REQUEST"], REQUEST_EVENT), "text/calendar; method=PUBLISH")?.method).toBe("REQUEST");
  });

  it("two METHOD lines that disagree", () => {
    expect(read(ics(["METHOD:REQUEST", "METHOD:CANCEL"], REQUEST_EVENT))).toBeUndefined();
    expect(read(ics(["METHOD:REQUEST", "METHOD:request"], REQUEST_EVENT))?.method).toBe("REQUEST");
  });

  it("a SEQUENCE that does not read; an absent one is 0", () => {
    const withSequence = (s: string) => read(ics(["METHOD:REQUEST"], ["UID:a@b.example", `SEQUENCE:${s}`]));
    expect(withSequence("abc")).toBeUndefined();
    expect(withSequence("-1")).toBeUndefined();
    expect(withSequence("2147483648")).toBeUndefined();
    expect(withSequence("2147483647")?.sequence).toBe(2147483647);
    expect(read(ics(["METHOD:REQUEST"], ["UID:a@b.example"]))?.sequence).toBe(0);
  });

  it("an occurrence no key can say, or a range of them", () => {
    const withOccurrence = (l: string) => read(ics(["METHOD:REQUEST"], ["UID:a@b.example", l]));
    expect(withOccurrence("RECURRENCE-ID:20261301T100000Z")).toBeUndefined();
    expect(withOccurrence("RECURRENCE-ID;RANGE=THISANDFUTURE:20261201T100000Z")).toBeUndefined();
    expect(withOccurrence("RECURRENCE-ID:20261201T100000Z")?.recurrenceId).toBe(String(Date.UTC(2026, 11, 1, 10, 0)));
    expect(withOccurrence("RECURRENCE-ID;TZID=Middle Earth:20261201T100000")?.recurrenceId).toBe("Middle Earth|20261201T1000|false");
  });

  it("a control character in the UID or the occurrence, written or escaped", () => {
    for (const uid of ["a\u0000b@c.example", "a\\nb@c.example", "a\u0085b@c.example", "a b@c.example", "a\u007fb@c.example"]) {
      expect(read(ics(["METHOD:REQUEST"], [`UID:${uid}`])), JSON.stringify(uid)).toBeUndefined();
    }
    expect(read(ics(["METHOD:REQUEST"], ["UID:a@b.example", "RECURRENCE-ID;TZID=Zone\u0007:20261201T100000"]))).toBeUndefined();
    // A bare CR inside a line is no line break here: it stays in the value, so the row goes.
    expect(read(ics(["METHOD:REQUEST"], ["UID:a@b.example\rX-INJECTED:1"]))).toBeUndefined();
  });
});

describe("the organizer and the invitees are plain addresses or none", () => {
  const organizer = (v: string) => read(ics(["METHOD:REQUEST"], ["UID:a@b.example", `ORGANIZER:${v}`]))?.organizer;

  it("keeps one plain address, as written, cut at the query", () => {
    expect(organizer("mailto:Tobias.Meier@studio.example")).toBe("Tobias.Meier@studio.example");
    expect(organizer("MAILTO:o@b.example")).toBe("o@b.example");
    expect(organizer("mailto:o@b.example?bcc=everyone@b.example")).toBe("o@b.example");
    expect(organizer("mailto:o+tag@sub.b.example")).toBe("o+tag@sub.b.example");
  });

  it("refuses everything else", () => {
    for (const v of [
      "o@b.example", "http://b.example", "mailto:", "mailto:o", "mailto:o@localhost", "mailto:o@b.123", "mailto:o@127.0.0.1",
      "mailto:o@[127.0.0.1]", 'mailto:"o o"@b.example', "mailto:o%x@b.example", "mailto:o!x@b.example", "mailto:o,x@b.example",
      "mailto:o x@b.example", "mailto:o@b.example.", "mailto:.o@b.example", "mailto:o.@b.example", "mailto:o..x@b.example",
      "mailto:o@-b.example", "mailto:o@b-.example", "mailto:o@@b.example", "mailto:o@b..example", "mailto:о@b.example",
      `mailto:${"o".repeat(250)}@b.example`,
    ]) {
      expect(organizer(v), v).toBeNull();
    }
  });

  it("a name or a sender beside the address is never read", () => {
    const got = read(ics(["METHOD:REQUEST"], [
      "UID:a@b.example", 'ORGANIZER;CN="x@evil.example";SENT-BY="mailto:x@evil.example":mailto:o@b.example',
      'ATTENDEE;CN="evil@evil.example";EMAIL=evil@evil.example:mailto:a@b.example',
    ]));
    expect(got).toMatchObject({ organizer: "o@b.example", attendees: ["a@b.example"] });
  });

  it("an invitee in an alarm is no invitee", () => {
    const got = read(ics(["METHOD:REQUEST"], [
      "UID:a@b.example", "BEGIN:VALARM", "ACTION:EMAIL", `ATTENDEE:mailto:${ME}`, "END:VALARM", "ATTENDEE:mailto:a@b.example",
    ]));
    expect(got?.attendees).toEqual(["a@b.example"]);
  });

  it(`compares the first ${INVITATION_ATTENDEES_MAX} ATTENDEE lines and no more`, () => {
    const others = (n: number) => Array.from({ length: n }, (_, i) => `ATTENDEE:mailto:guest${i}@b.example`);
    const last = read(ics(["METHOD:REQUEST"], ["UID:a@b.example", ...others(INVITATION_ATTENDEES_MAX - 1), `ATTENDEE:mailto:${ME}`]));
    expect(last?.attendees.at(-1)).toBe(ME);
    const past = read(ics(["METHOD:REQUEST"], ["UID:a@b.example", ...others(INVITATION_ATTENDEES_MAX), `ATTENDEE:mailto:${ME}`]));
    expect(past?.attendees).toHaveLength(INVITATION_ATTENDEES_MAX);
    expect(past?.attendees).not.toContain(ME);
  });

  it("on a REPLY only the first ATTENDEE line counts", () => {
    const got = read(ics(["METHOD:REPLY"], ["UID:a@b.example", "ATTENDEE;PARTSTAT=ACCEPTED:mailto:o x@b.example", `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${ME}`]));
    expect(got).toMatchObject({ attendees: [], reply: { answer: "accepted" } });
  });

  it("the walk's grammar: ASCII only, with the symbols RFC 5322 lets a local part carry but two", () => {
    expect(isPlainAddress("a.b+c-d_e'f=g{h}~i@x-y.example")).toBe(true);
    expect(isPlainAddress("a@x.example")).toBe(true);
    expect(isPlainAddress("Kelvin@x.example")).toBe(false);
    expect(isPlainAddress("a@x.exаmple")).toBe(false);
  });
});

describe("which part, and how much of it", () => {
  const google = ics(["METHOD:REQUEST"], REQUEST_EVENT);

  it("Google's two parts are one invitation, the iTIP part's", () => {
    const got = readLetterInvitation([
      part(google.replace("SEQUENCE:2", "SEQUENCE:2"), "application/ics", "2"),
      part(google, "text/calendar; method=REQUEST", "1"),
    ]);
    expect(got?.uid).toBe("kickoff-17@studio.example");
  });

  it("parts naming one event: the higher SEQUENCE wins; parts naming two: the first in rank order", () => {
    const newer = google.replace("SEQUENCE:2", "SEQUENCE:5");
    expect(readLetterInvitation([part(google, "text/calendar; method=REQUEST"), part(newer, "application/ics", "2")])?.sequence).toBe(5);
    const other = google.replace("kickoff-17", "other-9");
    expect(readLetterInvitation([part(other, "application/ics", "2"), part(google, "text/calendar; method=REQUEST")])?.uid)
      .toBe("kickoff-17@studio.example");
  });

  it("reads three parts at most, and none over the byte bound", () => {
    const empty = ics(["METHOD:PUBLISH"], ["UID:x@b.example"]);
    expect(readLetterInvitation([part(empty, "text/calendar", "1"), part(empty, "text/calendar", "2"), part(empty, "text/calendar", "3"), part(google, "text/calendar", "4")]))
      .toBeUndefined();
    const padded = google.replace("SUMMARY:Kickoff", `SUMMARY:${"x".repeat(INVITATION_PART_MAX_BYTES)}`);
    expect(read(padded)).toBeUndefined();
  });

  it(`reads a part of ${INVITATION_LINES_MAX} lines, and none longer`, () => {
    const filler = (n: number) => Array.from({ length: n }, () => "X-FILLER:1");
    const fixed = ics(["METHOD:REQUEST"], ["UID:a@b.example"]).split("\r\n").length - 1;
    expect(read(ics(["METHOD:REQUEST"], ["UID:a@b.example", ...filler(INVITATION_LINES_MAX - fixed)]))?.uid).toBe("a@b.example");
    expect(read(ics(["METHOD:REQUEST"], ["UID:a@b.example", ...filler(INVITATION_LINES_MAX - fixed + 1)]))).toBeUndefined();
  });

  it("reads only the first event of a part, and never a timezone's lines as the event's", () => {
    const got = read(ics(["METHOD:REQUEST", "BEGIN:VTIMEZONE", "TZID:X", "BEGIN:STANDARD", "DTSTART:16010101T030000", "END:STANDARD", "END:VTIMEZONE"],
      ["UID:first@b.example", "DTSTART:20261201T100000Z"],
      ["BEGIN:VEVENT", "UID:second@b.example", "END:VEVENT"]));
    expect(got).toMatchObject({ uid: "first@b.example", startRaw: "20261201T100000Z" });
  });

  it("a calendar that names files, links and zone files yields its row and nothing of them", () => {
    // The network is armed: the read never asks it for what a calendar names.
    const doors = [vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("fetched"); })];
    try {
      const got = read(ics(["METHOD:REQUEST", "X-WR-TIMEZONE:Europe/Zurich"], [
        ...REQUEST_EVENT, "ATTACH:https://evil.example/a.bin", "ATTACH;FMTTYPE=text/plain:file:///etc/passwd",
        "URL:https://evil.example/", "CONFERENCE;VALUE=URI:https://evil.example/c", "IMAGE;VALUE=URI:https://evil.example/i.png",
        "TZURL:https://evil.example/tz", "ATTENDEE;DIR=\"https://evil.example/d\";SENT-BY=\"mailto:s@evil.example\":mailto:x@evil.example",
      ]));
      expect(got?.uid).toBe("kickoff-17@studio.example");
      expect(JSON.stringify({ ...got, attendees: got?.attendees.filter((a) => a !== "x@evil.example") })).not.toContain("evil.example");
      for (const door of doors) expect(door).not.toHaveBeenCalled();
    } finally {
      for (const door of doors) door.mockRestore();
    }
  });

  it("never throws, whatever the text", () => {
    const hostile = [
      "", "\u0000", "BEGIN:VCALENDAR", "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:a@b.example",
      "END:VEVENT\r\nEND:VEVENT\r\nEND:VCALENDAR", `${"BEGIN:VALARM\r\n".repeat(5000)}`, ":".repeat(10000), '"'.repeat(10000),
      ics(["METHOD:REQUEST"], ["UID;X=\"unterminated:a@b.example"]), "﻿" + google, String.fromCharCode(0xd800),
    ];
    for (const text of hostile) expect(() => read(text)).not.toThrow();
    expect(read("﻿" + google)?.uid).toBe("kickoff-17@studio.example");
  });
});
