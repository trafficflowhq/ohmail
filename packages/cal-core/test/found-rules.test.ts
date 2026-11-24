/**
 * Events found in letters, by rules: the corpus of invented letters gives each level and each word
 * for what is not offered, and the two times a reading works from are never mixed.
 */
import { describe, expect, it } from "vitest";
import { readFound } from "@ohmail/cal-core/found/rules";
import { suggestionColumnsOf } from "@ohmail/cal-core/found/suggestion";
import { foundLetterText } from "@ohmail/cal-core/found/text";
import {
  NOT_OFFERED,
  type FoundContext,
  type FoundLetter,
  type FoundReading,
  type PlainDate,
  type ZonedTime,
} from "@ohmail/cal-core";
import { intlZones } from "@ohmail/cal-core/time/zones";
import { LETTERS, NOW, SENT, type Letter } from "./corpus/letters.js";
import { at } from "./support.js";

const zones = intlZones();
const ZURICH = "Europe/Zurich";

const letterOf = (l: Letter): FoundLetter =>
  ({
    subject: l.subject,
    body: l.body,
    sentAt: { kind: "instant", epochMs: at(l.sentAt ?? SENT) },
    language: l.language,
    place: "place" in l ? l.place : "ohbox",
  }) as FoundLetter;

const contextOf = (l: Letter): FoundContext => ({
  zone: l.zone ?? ZURICH,
  now: { kind: "instant", epochMs: at(l.now ?? NOW) },
  zones,
});

const read = (l: Letter): FoundReading => readFound(letterOf(l), contextOf(l));

/** A start or end as written: `2026-11-21` or `2026-11-21T19:30`. */
function written(t: PlainDate | ZonedTime | null): string | null {
  if (t === null) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  if (t.kind === "date") return `${t.year}-${p(t.month)}-${p(t.day)}`;
  const w = t.wall;
  return `${w.year}-${p(w.month)}-${p(w.day)}T${p(w.hour)}:${p(w.minute)}`;
}

const quoted = (r: FoundReading, spans: readonly { start: number; end: number }[]) =>
  spans.map((s) => r.text.slice(s.start, s.end));

const letter = (body: string, extra: Partial<Letter> = {}): Letter => ({
  name: "one sentence",
  subject: "",
  body,
  language: "en",
  expect: { key: null },
  ...extra,
});

describe("the corpus of invented letters", () => {
  for (const l of LETTERS) {
    it(l.name, () => {
      const r = read(l);
      const e = l.expect;
      expect(r.stoppedBy).toBeNull();
      expect(r.findings.map((f) => f.key)).toEqual(e.key === null ? [] : [e.key]);
      if (e.not !== undefined) expect(r.notOffered.map((n) => n.why)).toEqual(e.not);
      if (e.asks !== undefined) expect(quoted(r, r.askable)).toEqual(e.asks);
      const f = r.findings[0];
      if (f === undefined) return;
      expect(f.evidence).toBe("sentence");
      if (e.level !== undefined) expect(f.level).toBe(e.level);
      if (e.kind !== undefined) expect(f.kind).toBe(e.kind);
      if (e.end !== undefined) expect(written(f.event.end)).toBe(e.end);
      if (e.endGiven !== undefined) expect(f.event.endGiven).toBe(e.endGiven);
      if (e.words !== undefined) expect(quoted(r, f.words)).toEqual(e.words);
      expect(r.askable).toEqual([]);
    });
  }

  it("gives every word for what is not offered, and every level and kind words can tell", () => {
    const readings = LETTERS.map(read);
    const words = new Set(readings.flatMap((r) => r.notOffered.map((n) => n.why)));
    expect(NOT_OFFERED.filter((w) => !words.has(w))).toEqual([]);
    const findings = readings.flatMap((r) => r.findings);
    expect(new Set(findings.map((f) => f.level))).toEqual(new Set(["dated", "guess"]));
    expect(new Set(findings.map((f) => f.kind))).toEqual(
      new Set(["ticket", "delivery", "appointment", "proposal"]),
    );
    for (const l of LETTERS)
      for (const language of [l.language]) expect(["en", "de", null]).toContain(language);
    expect(new Set(LETTERS.filter((l) => l.expect.key !== null).map((l) => l.language))).toEqual(
      new Set(["en", "de", null]),
    );
  });

  it("never gives an exact level, a booking, an instant or a zoneless time", () => {
    for (const f of LETTERS.map(read).flatMap((r) => r.findings)) {
      expect(f.level).not.toBe("exact");
      expect(f.kind).not.toBe("booking");
      for (const t of [f.event.start, f.event.end]) {
        if (t === null) continue;
        expect(["date", "zoned"]).toContain(t.kind);
        if (t.kind === "zoned") expect(t.tzid).toBe(ZURICH);
      }
      if (f.event.start.kind === "date") expect(f.event.end).toBeNull();
    }
  });
});

describe("the two times a reading works from", () => {
  it("never reads a weekday that disagrees with its date as dated, not even with a time beside it", () => {
    const r = read(letter("Friday, 21 November 2026 at 19:30, in the main hall."));
    expect(r.findings).toEqual([]);
    expect(r.notOffered.map((n) => n.why)).toEqual(["weekday_disagrees"]);
  });

  it("works a relative day out from the letter's day, and judges it passed by the reading's", () => {
    const sent = "2026-11-10T09:00:00Z";
    const later = read(
      letter("Shall we meet tomorrow at 10:00?", { sentAt: sent, now: "2026-11-13T09:00:00Z" }),
    );
    expect(later.findings).toEqual([]);
    expect(later.notOffered.map((n) => n.why)).toEqual(["passed"]);
    const soon = read(
      letter("Shall we meet tomorrow at 10:00?", { sentAt: sent, now: "2026-11-10T10:00:00Z" }),
    );
    expect(soon.findings.map((f) => [f.key, f.level])).toEqual([["2026-11-11T10:00", "guess"]]);
  });

  it("takes the letter's day on the person's clock across a clock change", () => {
    // 22:30 UTC on 24 October is 00:30 on the 25th in Zurich, the night the clocks go back.
    const r = read(
      letter("Shall we meet tomorrow at 10:00?", {
        sentAt: "2026-10-24T22:30:00Z",
        now: "2026-10-24T23:30:00Z",
      }),
    );
    expect(r.anchor?.letterDay).toEqual({ kind: "date", year: 2026, month: 10, day: 25 });
    expect(r.findings.map((f) => f.key)).toEqual(["2026-10-26T10:00"]);
  });

  it("refuses a letter whose instants are not finite", () => {
    const r = read(letter("Party on Saturday, 21 November 2026 at 20:00.", { now: "2026-11-10T09:00:00Z" }));
    expect(r.findings).toHaveLength(1);
    const broken = readFound(letterOf(letter("Party")), {
      ...contextOf(letter("")),
      now: { kind: "instant", epochMs: NaN },
    });
    expect(broken.notOffered.map((n) => n.why)).toEqual(["letter_date"]);
    expect(broken.spent).toBe(0);
  });
});

describe("the text a letter is read in", () => {
  it("leaves out a reply's subject, quoted lines, and everything from the first quote head", () => {
    const text = foundLetterText({
      subject: "AW: Treffen",
      body: "Gerne.\r\n> alte Zeile\nBis bald\n-----Original Message-----\nFrom: someone",
      sentAt: { kind: "instant", epochMs: 0 },
      language: "de",
      place: "ohbox",
    });
    expect(text).toBe("\nGerne.\nBis bald");
  });

  it("ends at a reply head a mail program wrapped, and drops the line that began it", () => {
    const text = (body: string) =>
      foundLetterText({
        subject: "",
        body,
        sentAt: { kind: "instant", epochMs: 0 },
        language: null,
        place: "ohbox",
      });
    expect(
      text("Fine.\nOn Tue, Nov 10, 2026 at 3:05 PM Lea Brunner <lea@brunner-familie.example>\nwrote:\n> x"),
    ).toBe("\nFine.");
    expect(text("Gut.\nAm 09.11.2026 um 18:00 schrieb Lea Brunner:\nalt")).toBe("\nGut.");
    expect(
      text("Gut.\nAm Di., 10. Nov. 2026 um 15:05 Uhr schrieb Lea\n<lea@brunner-familie.example>:\nalt"),
    ).toBe("\nGut.");
    expect(text("Fine.\nVon: Lea Brunner\nalt")).toBe("\nFine.");
  });

  it("keeps a rule of dashes and an event's own From line, which are no quote heads", () => {
    const text = (body: string) =>
      foundLetterText({
        subject: "",
        body,
        sentAt: { kind: "instant", epochMs: 0 },
        language: null,
        place: "ohbox",
      });
    expect(text("a\n----------\nb")).toBe("\na\n----------\nb");
    expect(text("When: Sunday\nFrom: 10:00\nWhere: hall")).toBe("\nWhen: Sunday\nFrom: 10:00\nWhere: hall");
    expect(text("a\nFrom: 10 Downing Lane\nSent: Tuesday\nb")).toBe("\na");
    expect(text("a\n---------- Forwarded message ----------\nb")).toBe("\na");
  });

  it("refuses News and an unknown place before a character is read", () => {
    for (const place of ["news", "trash", undefined]) {
      const r = readFound(
        { ...letterOf(letter("Sunday at 10:00")), place } as FoundLetter,
        contextOf(letter("")),
      );
      expect(r.spent).toBe(0);
      expect(r.text).toBe("");
      expect(r.notOffered.map((n) => n.why)).toEqual([place === "news" ? "in_news" : "place"]);
    }
  });

  it("reads the receipts place as it reads the Ohbox", () => {
    const r = readFound(
      { ...letterOf(letter("Party on Saturday, 21 November 2026 at 20:00.")), place: "receipts" },
      contextOf(letter("")),
    );
    expect(r.findings.map((f) => f.key)).toEqual(["2026-11-21T20:00"]);
  });

  it("takes the person's default length when it is a sound one", () => {
    const l = letter("Party on Saturday, 21 November 2026 at 20:00.");
    const long = readFound(letterOf(l), { ...contextOf(l), defaultLengthMinutes: 120 });
    expect(written(long.findings[0]!.event.end)).toBe("2026-11-21T22:00");
    const odd = readFound(letterOf(l), { ...contextOf(l), defaultLengthMinutes: -5 });
    expect(written(odd.findings[0]!.event.end)).toBe("2026-11-21T21:00");
  });
});

describe("a finding as a stored suggestion", () => {
  it("fills the columns from the finding, the subject and the letter's words", () => {
    const l: Letter = {
      ...LETTERS.find((x) => x.name === "en/ticket")!,
      subject: "Re: Fwd: Your tickets for Winter Night",
    };
    const r = read({ ...l, subject: "Your tickets for Winter Night" });
    const columns = suggestionColumnsOf(r.findings[0]!, r, l.subject);
    expect(columns).toEqual({
      evidence: "sentence",
      proposed: {
        v: 1,
        level: "dated",
        kind: "ticket",
        title: "Your tickets for Winter Night",
        start: r.findings[0]!.event.start,
        end: r.findings[0]!.event.end,
        endGiven: false,
        free: false,
      },
      sourceWords: "Saturday, 21 November 2026 … 19:30",
      findingKey: "2026-11-21T19:30",
    });
  });

  it("never cuts a pair of UTF-16 units in two, and mends a half that stands alone", () => {
    const r = read(letter("Party on Saturday, 21 November 2026 at 20:00."));
    const f = r.findings[0]!;
    const whole = (s: string) => {
      for (let i = 0; i < s.length; i += 1) {
        const c = s.charCodeAt(i);
        const pair = c >= 0xd800 && c <= 0xdbff && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00;
        if (pair) i += 1;
        else if (c >= 0xd800 && c <= 0xdfff) return false;
      }
      return true;
    };
    const cutTitle = suggestionColumnsOf(f, r, `${"x".repeat(199)}\u{1F389} party`).proposed.title;
    expect(cutTitle).toBe("x".repeat(199));
    const lone = suggestionColumnsOf(f, r, "Party \ud83c here").proposed.title;
    expect(lone).toBe("Party \ufffd here");
    const text = `${"y".repeat(239)}\u{1F389}`;
    const words = suggestionColumnsOf(
      { ...f, words: [{ start: 0, end: text.length }] },
      { ...r, text },
      "Party",
    );
    expect(words.sourceWords).toBe("y".repeat(239));
    for (const s of [cutTitle, lone, words.sourceWords!]) expect(whole(s)).toBe(true);
  });

  it("cuts a long title and long words at their ceilings, and keeps no words when there are none", () => {
    const r = read(letter("Party on Saturday, 21 November 2026 at 20:00."));
    const f = r.findings[0]!;
    const long = suggestionColumnsOf(
      {
        ...f,
        words: [
          { start: 0, end: r.text.length },
          { start: 0, end: r.text.length },
          { start: 0, end: r.text.length },
          { start: 0, end: r.text.length },
          { start: 0, end: r.text.length },
        ],
      },
      r,
      "x".repeat(500),
    );
    expect(long.proposed.title).toHaveLength(200);
    expect(long.sourceWords).toHaveLength(240);
    expect(suggestionColumnsOf({ ...f, words: [] }, r, "Party").sourceWords).toBeNull();
  });
});
