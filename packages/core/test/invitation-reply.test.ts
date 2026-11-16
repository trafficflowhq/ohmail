import { describe, expect, it } from "vitest";
import { invitationReplyText, INVITATION_REPLY_PRODID, type InvitationReplyInput } from "../src/invitation-reply.js";

/**
 * THE REPLY A PRESS SENDS, as the calendar part of a letter: written from the stored row alone, so
 * every line is a constant, a value of the row, or the press. These cases read the text the writer
 * gives as an organizer's calendar would read it: line by line, unfolded at CRLF and one space.
 */

const ROW: InvitationReplyInput = {
  uid: "kickoff-17@studio.example",
  recurrenceId: "",
  sequence: 2,
  startRaw: "20261201T110000",
  startsAt: new Date("2026-12-01T10:00:00Z"),
  organizer: "tobias@studio.example",
  invitedAddress: "Mila@Lichtgrat.example",
  answer: "accepted",
  stamp: new Date("2026-11-15T09:30:12.345Z"),
};

const write = (over: Partial<InvitationReplyInput> = {}): string | null => invitationReplyText({ ...ROW, ...over });

/** The written text's logical lines: CRLF ends, continuations joined. */
function linesOf(text: string | null): string[] {
  if (text === null) throw new Error("the writer refused");
  expect(text.endsWith("\r\n")).toBe(true);
  expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  return text.slice(0, -2).replace(/\r\n /g, "").split("\r\n");
}

/** The lines of the one event, between BEGIN:VEVENT and END:VEVENT. */
const eventOf = (text: string | null): string[] => {
  const all = linesOf(text);
  return all.slice(all.indexOf("BEGIN:VEVENT") + 1, all.indexOf("END:VEVENT"));
};

describe("what the reply says", () => {
  it("one REPLY with the row's identity, the press's stamp and one invitee", () => {
    expect(linesOf(write())).toEqual([
      "BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:${INVITATION_REPLY_PRODID}`, "METHOD:REPLY", "BEGIN:VEVENT",
      "UID:kickoff-17@studio.example", "SEQUENCE:2", "DTSTAMP:20261115T093012Z", "DTSTART:20261201T100000Z",
      "ORGANIZER:mailto:tobias@studio.example", "ATTENDEE;PARTSTAT=ACCEPTED:mailto:Mila@Lichtgrat.example",
      "END:VEVENT", "END:VCALENDAR",
    ]);
  });

  it("each answer is its own participation status", () => {
    const attendee = (answer: InvitationReplyInput["answer"]) => eventOf(write({ answer })).find((l) => l.startsWith("ATTENDEE"));
    expect(attendee("accepted")).toBe("ATTENDEE;PARTSTAT=ACCEPTED:mailto:Mila@Lichtgrat.example");
    expect(attendee("tentative")).toBe("ATTENDEE;PARTSTAT=TENTATIVE:mailto:Mila@Lichtgrat.example");
    expect(attendee("declined")).toBe("ATTENDEE;PARTSTAT=DECLINED:mailto:Mila@Lichtgrat.example");
  });

  it("the same row and press write the same letter; another stamp writes another", () => {
    expect(write()).toBe(write());
    expect(write({ stamp: new Date("2026-11-15T09:30:13Z") })).not.toBe(write());
    expect(write({ stamp: new Date("2026-11-15T09:30:12.999Z") })).toBe(write());
  });

  it("a sequence of 0 is written, as the invitation's revision", () => {
    expect(eventOf(write({ sequence: 0 }))).toContain("SEQUENCE:0");
  });
});

describe("the start: a day, an instant in UTC, or a floating clock time", () => {
  const startOf = (over: Partial<InvitationReplyInput>) => eventOf(write(over)).filter((l) => l.startsWith("DTSTART"));

  it("a whole-day event writes its day", () => {
    expect(startOf({ startRaw: "20261201", startsAt: new Date("2026-12-01T00:00:00Z") })).toEqual(["DTSTART;VALUE=DATE:20261201"]);
  });

  it("an instant is written in UTC; a start written in UTC keeps its seconds", () => {
    expect(startOf({})).toEqual(["DTSTART:20261201T100000Z"]);
    expect(startOf({ startRaw: "20261201T100045Z", startsAt: new Date("2026-12-01T10:00:00Z") })).toEqual(["DTSTART:20261201T100045Z"]);
    expect(startOf({ startRaw: null })).toEqual(["DTSTART:20261201T100000Z"]);
  });

  it("a floating time is written as written, for a floating occurrence", () => {
    expect(startOf({ startsAt: null, recurrenceId: "|20261201T1100|false" })).toEqual(["DTSTART:20261201T110000"]);
  });

  it("a clock time with no instant and no floating occurrence is left out, never told as floating", () => {
    // A zone this platform does not know keeps no instant; a REPLY may leave DTSTART out (RFC 5546).
    expect(startOf({ startsAt: null })).toEqual([]);
    expect(startOf({ startsAt: null, startRaw: null })).toEqual([]);
  });
});

describe("the occurrence, from the stored key", () => {
  const idOf = (over: Partial<InvitationReplyInput>) => eventOf(write(over)).filter((l) => l.startsWith("RECURRENCE-ID"));

  it("the series names none", () => {
    expect(idOf({ recurrenceId: "" })).toEqual([]);
  });

  it("an instant is written in UTC", () => {
    expect(idOf({ recurrenceId: String(Date.parse("2026-12-08T10:00:00Z")) })).toEqual(["RECURRENCE-ID:20261208T100000Z"]);
  });

  it("an occurrence of a whole-day event is written as its day", () => {
    const day = { startRaw: "20261201", startsAt: new Date("2026-12-01T00:00:00Z") };
    expect(idOf({ ...day, recurrenceId: String(Date.parse("2026-12-08T00:00:00Z")) })).toEqual(["RECURRENCE-ID;VALUE=DATE:20261208"]);
    // A whole-day event's key that is not a day's start names no day of it.
    expect(write({ ...day, recurrenceId: String(Date.parse("2026-12-08T10:00:00Z")) })).toBeNull();
  });

  it("a floating clock time is written as written", () => {
    expect(idOf({ startsAt: null, recurrenceId: "|20261208T1100|false" })).toEqual(["RECURRENCE-ID:20261208T110000"]);
  });

  it("refuses a key holding a zone's name, a whole-day floating key and any other shape", () => {
    // The zone's name is the sender's text and is never repeated.
    expect(write({ recurrenceId: "Mars/Olympus|20261208T1100|false" })).toBeNull();
    expect(write({ recurrenceId: "|20261208T1100|true" })).toBeNull();
    expect(write({ recurrenceId: "20261208T100000Z" })).toBeNull();
    expect(write({ recurrenceId: "1;RANGE=THISANDFUTURE" })).toBeNull();
    expect(write({ recurrenceId: String(Number.MAX_SAFE_INTEGER) })).toBeNull();
  });
});

describe("what a stranger wrote", () => {
  it("the UID's backslash, semicolon and comma are escaped, so it reads back as the same text", () => {
    expect(eventOf(write({ uid: "a\\b;c,d" }))[0]).toBe("UID:a\\\\b\\;c\\,d");
  });

  it("refuses a UID holding a control character, a line break or half a character", () => {
    for (const uid of ["a\rb", "a\nb", "a\u0000b", "a\u007fb", "a\u0085b", "a b", "a b", "a\tb", "\ud800x", "x\udc00", ""]) {
      expect(write({ uid }), JSON.stringify(uid)).toBeNull();
    }
  });

  it("refuses an organizer or an invitee that is not one plain address", () => {
    for (const bad of ["tobias@studio.example\r\nBcc: x@y.example", "two@@studio.example", "a b@studio.example",
      "tobias@studio.example,eve@x.example", "\"q\"@studio.example", "tobias@localhost", "tobiás@studio.example", ""]) {
      expect(write({ organizer: bad }), bad).toBeNull();
      expect(write({ invitedAddress: bad }), bad).toBeNull();
    }
  });

  it("refuses a revision, a stamp or an answer outside their values", () => {
    expect(write({ sequence: -1 })).toBeNull();
    expect(write({ sequence: 2 ** 31 })).toBeNull();
    expect(write({ sequence: 1.5 })).toBeNull();
    expect(write({ stamp: new Date(Number.NaN) })).toBeNull();
    expect(write({ answer: "maybe" as InvitationReplyInput["answer"] })).toBeNull();
  });
});

describe("line folding", () => {
  const octets = (s: string): number => new TextEncoder().encode(s).length;

  it("folds a line past 75 octets, and unfolds to the same line", () => {
    const uid = `${"x".repeat(180)}@studio.example`;
    const text = write({ uid })!;
    for (const physical of text.slice(0, -2).split("\r\n")) expect(octets(physical)).toBeLessThanOrEqual(75);
    expect(eventOf(text)[0]).toBe(`UID:${uid}`);
  });

  it("never folds inside a character", () => {
    const uid = `${"é".repeat(60)}${"😀".repeat(20)}@studio.example`;
    const text = write({ uid })!;
    for (const physical of text.slice(0, -2).split("\r\n")) {
      expect(octets(physical)).toBeLessThanOrEqual(75);
      expect(physical).not.toMatch(/[\ud800-\udbff]$|^ ?[\udc00-\udfff]/);
    }
    expect(eventOf(text)[0]).toBe(`UID:${uid}`);
  });
});
