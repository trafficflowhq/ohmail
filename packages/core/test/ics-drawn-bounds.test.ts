import { describe, it, expect, vi } from "vitest";
import { distinctCalendarEvents, formatIcsWhen, icsPeople, parseIcsEvent, type IcsEventPreview } from "../src/ics.js";
import { MAX_STORED_ADDRESS_CHARS } from "../src/stored-values.js";
import { INVITE_SHAPES } from "./fixtures/invite-shapes.js";

/**
 * WHAT A CARD DRAWS OF A SENDER'S TEXT IS BOUNDED WHERE EVERY CARD READS IT. A crafted invitation
 * fits a 250,000-character SUMMARY, LOCATION, CN or TZID inside the engine's 256 KiB calendar
 * budget, and the phone drew each whole in one Text above the body (a 65,536-character Text took
 * ~450 ms of its JS thread, and the cost grows faster than the length). parseIcsEvent cuts SUMMARY
 * and LOCATION at 1,000 UTF-16 code units, each CN at 200 and the label of a TZID that names no
 * zone at 64, the ellipsis included and never inside a surrogate pair; an address longer than
 * RFC 5321's 254 is none, as the store holds it. Real invites are 1-4 KB whole: nothing real is cut.
 */

const CRLF = "\r\n";
const ELLIPSIS = "…";
const PAIR = "\u{1F4C5}"; // two UTF-16 code units
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const START = "DTSTART:20261027T130000Z";

const calendar = (method: string, lines: string[]): string =>
  ["BEGIN:VCALENDAR", `METHOD:${method}`, "BEGIN:VEVENT", "UID:bounds@example.test", ...lines, "END:VEVENT", "END:VCALENDAR", ""].join(CRLF);
const event = (lines: string[], method = "REQUEST"): IcsEventPreview => {
  const ev = parseIcsEvent(calendar(method, lines));
  expect(ev, "the event was dropped").not.toBeNull();
  return ev!;
};

interface Field {
  name: string;
  cap: number;
  /** The event's lines, carrying `value` in this field. */
  lines: (value: string) => string[];
  read: (ev: IcsEventPreview) => string | null | undefined;
}

const FIELDS: Field[] = [
  { name: "SUMMARY", cap: 1000, lines: (v) => [START, `SUMMARY:${v}`], read: (ev) => ev.summary },
  { name: "LOCATION", cap: 1000, lines: (v) => [START, `LOCATION:${v}`], read: (ev) => ev.location },
  { name: "the organizer's CN", cap: 200, lines: (v) => [START, `ORGANIZER;CN=${v}:mailto:ada@example.test`], read: (ev) => ev.organizer?.name },
  { name: "an attendee's CN", cap: 200, lines: (v) => [START, `ATTENDEE;CN=${v};PARTSTAT=ACCEPTED:mailto:mila@example.test`], read: (ev) => ev.attendees[0]?.name },
  { name: "the label of a TZID that names no zone", cap: 64, lines: (v) => [`DTSTART;TZID=${v}:20261027T140000`], read: (ev) => ev.start.tzid },
];

for (const f of FIELDS) {
  describe(`${f.name}: at most ${f.cap} code units`, () => {
    it(`${f.cap - 1} and ${f.cap} are drawn whole`, () => {
      for (const n of [f.cap - 1, f.cap]) {
        const v = "x".repeat(n);
        expect(f.read(event(f.lines(v)))).toBe(v);
      }
    });

    it(`${f.cap + 1} are cut to ${f.cap}, the ellipsis included`, () => {
      const got = f.read(event(f.lines("x".repeat(f.cap + 1))));
      expect(got).toBe(`${"x".repeat(f.cap - 1)}${ELLIPSIS}`);
      expect(got!.length).toBe(f.cap);
    });

    it("a surrogate pair at the cut is never halved", () => {
      // The pair sits at code units cap-2 and cap-1, across the cut: it goes whole.
      const across = f.read(event(f.lines(`${"x".repeat(f.cap - 2)}${PAIR}yy`)));
      expect(across).toBe(`${"x".repeat(f.cap - 2)}${ELLIPSIS}`);
      expect(across).not.toMatch(LONE_SURROGATE);
      // Control: a pair that ends right at the cut stays.
      const before = f.read(event(f.lines(`${"x".repeat(f.cap - 3)}${PAIR}yy`)));
      expect(before).toBe(`${"x".repeat(f.cap - 3)}${PAIR}${ELLIPSIS}`);
      expect(before!.length).toBe(f.cap);
    });

    it("250,000 inside the parse ceiling: cut to the bound", () => {
      const got = f.read(event(f.lines("x".repeat(250_000))));
      expect(got!.length).toBe(f.cap);
      expect(got!.endsWith(ELLIPSIS)).toBe(true);
    });
  });
}

describe("what the card prints", () => {
  const opts = { locale: "en", zone: "Europe/Zurich", allDay: "All day" };

  it("a cut after a space draws no space before the ellipsis", () => {
    expect(event([START, `SUMMARY:${"x".repeat(998)} yy`]).summary).toBe(`${"x".repeat(998)}${ELLIPSIS}`);
  });

  it("the when-line, the replaced time and the end print the bounded label", () => {
    const zone = "x".repeat(250_000);
    const ev = event([`DTSTART;TZID=${zone}:20261027T140000`]);
    const when = formatIcsWhen(ev.start, ev.end, opts);
    expect(when).toContain(`(${"x".repeat(63)}${ELLIPSIS})`);
    expect(when.length).toBeLessThan(64 + 40);
    const counter = event([START, `DTEND;TZID=${zone}:20261027T150000`, `X-MS-OLDSTART;TZID=${zone}:20261027T100000`], "COUNTER");
    expect(counter.end?.tzid?.length).toBe(64);
    expect(counter.oldStart?.tzid?.length).toBe(64);
  });

  it("a TZID longer than the bound names no zone and is never looked up", () => {
    const made = vi.spyOn(Intl, "DateTimeFormat");
    try {
      const ev = event([`DTSTART;TZID=never-looked-up-${"z".repeat(60)}:20261027T140000`]);
      expect(ev.start.epochMs).toBeNull();
      const asked = made.mock.calls.map(([, o]) => o?.timeZone ?? "");
      expect(asked.filter((z) => z.length > 64), "a zone name past the bound was handed to Intl").toEqual([]);
    } finally {
      made.mockRestore();
    }
  });

  it("control: a zone that resolves keeps its name and its instant", () => {
    for (const zone of ["Europe/Zurich", "W. Europe Standard Time", "America/Argentina/Buenos_Aires", "Pacific Standard Time (Mexico)"]) {
      const ev = event([`DTSTART;TZID=${zone}:20261027T140000`]);
      expect(ev.start.tzid).toBe(zone);
      expect(ev.start.epochMs, zone).not.toBeNull();
    }
  });

  it("the people line, the replier's or the organizer's, is bounded by the name", () => {
    const reply = event([START, `ATTENDEE;CN=${"m".repeat(250_000)};PARTSTAT=ACCEPTED:mailto:mila@example.test`], "REPLY");
    expect(icsPeople(reply).who?.length).toBe(200);
    const request = event([START, `ORGANIZER;CN=${"a".repeat(250_000)}:mailto:ada@example.test`]);
    expect(icsPeople(request).who?.length).toBe(200);
  });
});

describe("an address, the people line's fallback", () => {
  const address = (n: number) => `${"a".repeat(n - "@example.test".length)}@example.test`;

  it("up to the store's 254 (RFC 5321) is the address; longer is none, never cut", () => {
    const kept = address(MAX_STORED_ADDRESS_CHARS);
    expect(event([START, `ORGANIZER:mailto:${kept}`]).organizer?.email).toBe(kept);
    const over = event([START, `ORGANIZER:mailto:${address(MAX_STORED_ADDRESS_CHARS + 1)}`]);
    expect(over.organizer?.email).toBeNull();
    expect(icsPeople(over).who).toBeNull();
    const huge = event([START, `ORGANIZER:mailto:${address(250_000)}`, "ATTENDEE:mailto:mila@example.test"]);
    expect(icsPeople(huge)).toEqual({ who: null, invited: 1 });
  });
});

describe("identity is compared whole, never by what is drawn", () => {
  const part = (id: string, zone: string) => ({
    id,
    contentType: "text/calendar; method=REQUEST",
    text: calendar("REQUEST", [START, "SUMMARY:Weekly", `RECURRENCE-ID;TZID=${zone}:20261027T140000`]),
  });

  it("two RECURRENCE-IDs in unknown zones that differ past the label's bound are two events", () => {
    const head = "x".repeat(70);
    expect(distinctCalendarEvents([part("p1", `${head}A`), part("p2", `${head}B`)])).toHaveLength(2);
    expect(distinctCalendarEvents([part("p1", `${head}A`), part("p2", `${head}A`)]), "control").toHaveLength(1);
  });
});

describe("control: nothing real is cut", () => {
  it("no fixture invitation draws an ellipsis", () => {
    for (const shape of INVITE_SHAPES) {
      for (const p of shape.parts) {
        const ev = parseIcsEvent(p.bytes);
        if (!ev) continue;
        const drawn = [ev.summary, ev.location, ev.organizer?.name, ev.organizer?.email, ...ev.attendees.flatMap((a) => [a.name, a.email]), ev.start.tzid, ev.end?.tzid];
        for (const s of drawn) expect(s ?? "", `${shape.name}: ${s}`).not.toContain(ELLIPSIS);
      }
    }
  });
});
