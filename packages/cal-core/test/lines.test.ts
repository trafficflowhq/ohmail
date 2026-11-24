/** Content lines: unfolding and folding, parameters with quotes and carets, and the values a property holds. */
import { describe, expect, it } from "vitest";
import { parseComponents, writeComponent } from "../src/ical/component.js";
import { countParts, decodeParamValue, fold, formatContentLine, makeParam, paramOf, parseContentLine, scanContentLine, unfold } from "../src/ical/lines.js";
import {
  escapeText, formatDuration, formatInstant, formatUtcOffset, mailAddressOf, parseDate, parseDateTime, parseDuration, parsePeriod, parseUtcOffset,
  splitTextList, timeOf, timeProperty, unescapeText,
} from "../src/ical/values.js";
import { DEFAULT_LIMITS, MAX_NAME_CHARS, MAX_PARAMS_PER_LINE, MAX_PARAM_VALUE_CHARS } from "../src/limits.js";
import { apple_event, exchange_request, thunderbird_event } from "./corpus/providers.js";
import { at, text, textOf } from "./support.js";

const octets = (s: string): number => new TextEncoder().encode(s).length;

describe("unfolding", () => {
  it("takes CRLF, a bare LF and a bare CR as line ends, and a space or a tab as a fold", () => {
    expect(unfold("A:1\r\nB:2\nC:3\rD:4")).toEqual(["A:1", "B:2", "C:3", "D:4"]);
    expect(unfold("SUMMARY:Kiln\r\n  schedule\r\n\tand more\r\n")).toEqual(["SUMMARY:Kiln scheduleand more"]);
    expect(unfold("\uFEFFBEGIN:VCALENDAR\r\n\r\n\r\nEND:VCALENDAR\r\n")).toEqual(["BEGIN:VCALENDAR", "END:VCALENDAR"]);
  });

  it("joins a name with a comma that Exchange folded with a tab inside its quotes", () => {
    const lines = unfold(text(exchange_request));
    expect(lines).toContain('ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN="Arnold, Ben":mailto:ben.arnold@lichtgrat.example');
  });
});

describe("folding", () => {
  it("cuts at 75 octets and never inside a character", () => {
    const line = `SUMMARY:${"é".repeat(40)}${"🏺".repeat(20)}${"x".repeat(80)}`;
    const physical = fold(line).split("\r\n");
    expect(physical.length).toBeGreaterThan(1);
    for (const p of physical) expect(octets(p)).toBeLessThanOrEqual(75);
    expect(physical.slice(1).every((p) => p.startsWith(" "))).toBe(true);
    expect(unfold(`${fold(line)}\r\n`)).toEqual([line]);
    // The first line is full: 8 octets of name, then 33 two-octet letters make 74, and the 34th does not fit.
    expect(octets(physical[0]!)).toBe(74);
  });

  it("leaves a short line alone", () => {
    expect(fold("UID:1")).toBe("UID:1");
    expect(fold("x".repeat(75))).toBe("x".repeat(75));
    expect(fold("x".repeat(76))).toBe(`${"x".repeat(75)}\r\n x`);
  });
});

describe("one content line", () => {
  it("keeps a colon, a semicolon and a comma inside a quoted parameter", () => {
    const p = parseContentLine('ATTENDEE;CN="Wyss; Petra: lead, studio";ROLE=CHAIR:mailto:petra.wyss@lichtgrat.example')!;
    expect(p.name).toBe("ATTENDEE");
    expect(paramOf(p, "cn")).toBe("Wyss; Petra: lead, studio");
    expect(paramOf(p, "ROLE")).toBe("CHAIR");
    expect(p.value).toBe("mailto:petra.wyss@lichtgrat.example");
  });

  it("reads several values of one parameter, and RFC 6868's carets", () => {
    const p = parseContentLine(`ATTENDEE;DELEGATED-TO="mailto:a@atelier.example","mailto:b@atelier.example";CN=Mila ^'the potter^' Brunner^nStudio ^^1 ^x:mailto:m@atelier.example`)!;
    expect(p.params[0]!.values).toEqual(["mailto:a@atelier.example", "mailto:b@atelier.example"]);
    expect(paramOf(p, "CN")).toBe('Mila "the potter" Brunner\nStudio ^1 ^x');
    expect(decodeParamValue("no carets")).toBe("no carets");
  });

  it("writes a line back exactly as it was read, whatever its quoting", () => {
    for (const line of [
      'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-APPLE-RADIUS=70.58;X-TITLE="Winter market\\nHafenhalle, Uferweg 3":geo:47.000000,8.000000',
      'ORGANIZER;CN="Giulia Ferrari":mailto:giulia.ferrari@lichtgrat.example',
      "dtstart;tzid=Europe/Zurich:20261128T100000",
      "ATTENDEE;RSVP:mailto:m@atelier.example",
      "LOCATION:",
      "DESCRIPTION:a: b; c, d",
    ]) {
      expect(formatContentLine(parseContentLine(line)!)).toBe(line);
    }
  });

  it("says a line with no colon outside quotes is not a content line", () => {
    expect(parseContentLine("just some words")).toBeNull();
    expect(parseContentLine('X;A="unterminated:value')).toBeNull();
    expect(parseContentLine(":value without a name")).toBeNull();
  });

  it("takes apart no line with more parameters than its ceiling", () => {
    expect(parseContentLine(`X${";P=1".repeat(MAX_PARAMS_PER_LINE)}:v`)?.params.length).toBe(MAX_PARAMS_PER_LINE);
    expect(parseContentLine(`X${";P=1".repeat(MAX_PARAMS_PER_LINE + 1)}:v`)).toBeNull();
    expect(scanContentLine("X;A=1;B=2:v", 1)).toBe("too_many_parameters");
    expect(scanContentLine("X;A=1;B=2:v", 2)).toMatchObject({ name: "X", value: "v" });
  });

  it("counts the parts of a text on the text, as its lines taken apart would give them", () => {
    // A line is a part; so is each of its parameters, and each further value a parameter lists.
    expect(countParts("A:1\r\nB;X=1;Y=2,3:v\r\n", 256, 100)).toBe(1 + 4);
    expect(countParts('B;X="1;2,3":v;w,x\r\n', 256, 100)).toBe(2);
    expect(countParts("no colon; here, at all\r\n", 256, 100)).toBe(1);
    // A fold is no line end, wherever it falls; an empty line is no line; a byte-order mark is not text.
    expect(countParts("B;X=1;\r\n Y=2,\r\n\t3:v\r\n\r\n", 256, 100)).toBe(4);
    expect(countParts("﻿A:1\nB:2\rC:3", 256, 100)).toBe(3);
    expect(countParts("", 256, 100)).toBe(0);
    // A line counts for no more than its own ceiling lets it hold: past that it is refused whole and nothing is made of it.
    expect(countParts("X;;;;;;;;:v\r\n", 3, 100)).toBe(1 + 3);
    // The count goes no further than one past where it is told to stop.
    expect(countParts("A;B=1:1\r\n".repeat(50), 256, 10)).toBe(11);

    // Three thousand texts of the characters that matter, each held against its own lines: unfolded, and each line's
    // parameters counted plainly and checked against the scan that takes a line apart.
    const alphabet = ["A", "=", ";", ";", ",", ":", '"', "\r", "\n", "\r\n", " ", "\t"];
    let seed = 20261114;
    const next = (below: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % below;
    };
    const listedOf = (line: string): number => {
      let [quoted, listed] = [false, 0];
      for (const c of line) {
        if (c === '"') quoted = !quoted;
        else if (!quoted && (c === ";" || c === ",")) listed++;
        else if (!quoted && c === ":") return listed;
      }
      return 0;
    };
    for (let n = 0; n < 3000; n++) {
      const source = Array.from({ length: next(40) }, () => alphabet[next(alphabet.length)]!).join("");
      const lines = unfold(source);
      for (const line of lines) {
        const listed = listedOf(line);
        expect(scanContentLine(line, listed), JSON.stringify(line)).not.toBe("too_many_parameters");
        if (listed > 0) expect(scanContentLine(line, listed - 1), JSON.stringify(line)).toBe("too_many_parameters");
      }
      for (const ceiling of [0, 2, 256]) {
        const parts = lines.reduce((sum, line) => sum + 1 + Math.min(listedOf(line), ceiling), 0);
        expect(countParts(source, ceiling, 1000), JSON.stringify(source)).toBe(parts);
        expect(countParts(source, ceiling, 3), JSON.stringify(source)).toBe(Math.min(parts, 4));
      }
    }
  });

  /*
   * A NAME AND A PARAMETER'S TEXT EACH HAVE A CEILING. A head or a parameter name longer than a name
   * may be is no name, and its line no content line: it is kept as it stands, as a line with no colon
   * is. A parameter whose text is longer than a parameter's may be is kept as it was written and read
   * as nothing. Neither is refused: a feed that breaks its descriptions over raw lines still reads.
   */
  it("takes a line whose head or whose parameter's name is longer than a name may be for no content line", () => {
    const [full, over] = ["N".repeat(MAX_NAME_CHARS), "N".repeat(MAX_NAME_CHARS + 1)];
    expect(parseContentLine(`${full}:v`)).toMatchObject({ name: full, value: "v" });
    expect(parseContentLine(`${over}:v`)).toBeNull();
    expect(parseContentLine(`X;${full}=1:v`)?.params[0]).toMatchObject({ name: full, values: ["1"] });
    expect(parseContentLine(`X;${over}=1:v`)).toBeNull();
    expect(parseContentLine(`X;A=1;${full}:v`)?.params[1]).toMatchObject({ name: full, bare: true });
    expect(parseContentLine(`X;A=1;${over}:v`)).toBeNull();
    // A line of prose with its colon far in, as a description cut by a raw line break leaves it: kept, written back, and no property.
    const prose = `${"Bring your own cup and a towel for the wheel, we start in the back room as soon as the kiln has cooled down ".repeat(2)}Note: no glazing`;
    const odd = `BEGIN:VCALENDAR\r\nX-WR-CALDESC:The atelier\r\n${prose}\r\nBEGIN:VEVENT\r\nUID:1\r\n${prose}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    const parsed = parseComponents(odd, DEFAULT_LIMITS);
    expect(parsed.ok && [parsed.components[0]!.properties.map((p) => p.name), parsed.components[0]!.components[0]!.properties.map((p) => p.name), parsed.dropped]).toEqual([["X-WR-CALDESC", ""], ["UID", ""], []]);
    expect(parsed.ok && unfold(textOf(writeComponent(parsed.components[0]!)))).toEqual(unfold(odd));
  });

  it("keeps a parameter whose text is longer than a parameter's may be as it was written, and reads nothing from it", () => {
    const full = "a".repeat(MAX_PARAM_VALUE_CHARS);
    const held = parseContentLine(`ATTENDEE;CN=${full};ROLE=CHAIR:mailto:m@atelier.example`)!;
    expect([paramOf(held, "CN"), paramOf(held, "ROLE")]).toEqual([full, "CHAIR"]);
    const line = `ATTENDEE;CN=${full}a;ROLE=CHAIR:mailto:m@atelier.example`;
    const over = parseContentLine(line)!;
    expect([paramOf(over, "CN"), over.params[0]!.values, paramOf(over, "ROLE"), over.value]).toEqual([null, [], "CHAIR", "mailto:m@atelier.example"]);
    expect(formatContentLine(over)).toBe(line);
    // Its values are counted as parts all the same, and a line past its ceiling of parameters is still refused.
    expect(scanContentLine(`X;A=${"1,".repeat(MAX_PARAM_VALUE_CHARS)}1:v`, MAX_PARAMS_PER_LINE)).toBe("too_many_parameters");
  });

  it("quotes and escapes a new parameter only where it must", () => {
    expect(makeParam("CN", ["Mila Brunner"]).raw).toBe("Mila Brunner");
    expect(makeParam("CN", ["Arnold, Ben"]).raw).toBe('"Arnold, Ben"');
    expect(makeParam("CN", ['Mila "the potter"\nBrunner ^']).raw).toBe("Mila ^'the potter^'^nBrunner ^^");
    const written = formatContentLine({ name: "ATTENDEE", params: [makeParam("CN", ['A "b", c'])], value: "mailto:a@atelier.example" });
    expect(paramOf(parseContentLine(written)!, "CN")).toBe('A "b", c');
  });
});

describe("the tree", () => {
  it("keeps a property written after a sub-component where it was", () => {
    const odd = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:1\r\nBEGIN:VALARM\r\nACTION:NONE\r\nEND:VALARM\r\nSUMMARY:after the alarm\r\nEND:VEVENT\r\nX-AFTER:the event\r\nEND:VCALENDAR\r\n";
    const parsed = parseComponents(odd, DEFAULT_LIMITS);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.components[0]!.components[0]!.properties.map((p) => [p.name, p.afterComponents])).toEqual([["UID", undefined], ["SUMMARY", 1]]);
    expect(textOf(writeComponent(parsed.components[0]!))).toBe(odd);
  });

  it("keeps a line that is not a content line, and a name in the case it was written", () => {
    const odd = "begin:vcalendar\r\nVersion:2.0\r\nthis line has no colon\r\nend:VCALENDAR\r\n";
    const parsed = parseComponents(odd, DEFAULT_LIMITS);
    expect(parsed.ok && parsed.components[0]!.properties.map((p) => p.name)).toEqual(["Version", ""]);
    expect(parsed.ok && textOf(writeComponent(parsed.components[0]!))).toBe("BEGIN:vcalendar\r\nVersion:2.0\r\nthis line has no colon\r\nEND:vcalendar\r\n");
  });

  it("refuses by word what is not a calendar or does not close", () => {
    const refusal = (t: string) => {
      const r = parseComponents(t, DEFAULT_LIMITS);
      return r.ok ? "read" : r.reason;
    };
    expect(refusal("")).toBe("not_a_calendar");
    expect(refusal("<!doctype html><title>Sign in</title>")).toBe("not_a_calendar");
    expect(refusal("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VCALENDAR\r\n")).toBe("unbalanced");
    expect(refusal("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe("unbalanced");
    expect(refusal("END:VCALENDAR\r\n")).toBe("unbalanced");
  });
});

describe("values", () => {
  it("unescapes text as the standard says and keeps an escape it does not know", () => {
    const description = unfold(text(thunderbird_event)).find((l) => l.startsWith("DESCRIPTION:"))!.slice("DESCRIPTION:".length);
    expect(unescapeText(description)).toBe("Cone 6; the blue set first.\nThen C:\\glazes\\notes.txt, if time allows.");
    expect(unescapeText("line\\Nbreak \\x stays \\")).toBe("line\nbreak \\x stays \\");
    expect(escapeText("a;b,c\\d\ne")).toBe("a\\;b\\,c\\\\d\\ne");
    expect(unescapeText(escapeText("a;b,c\\d\ne\\n"))).toBe("a;b,c\\d\ne\\n");
    expect(splitTextList("Studio,Kiln\\, small,Tests")).toEqual(["Studio", "Kiln, small", "Tests"]);
  });

  /*
   * NOTHING IS BUILT ONE CHARACTER AT A TIME. Text is unescaped, a list cut, a parameter's carets and
   * quotes read and a line folded by whole slices of what was written, joined once. Each is held here
   * against the plain reading, one character after the other, on thousands of texts of the characters
   * that matter. (What the slices are for is measured in a process of its own, in calendar.test.ts.)
   */
  it("unescapes, cuts, decodes and folds as a reading one character at a time does", () => {
    const plainUnescape = (value: string): string => {
      let out = "";
      for (let i = 0; i < value.length; i++) {
        const [c, next] = [value[i]!, value[i + 1]];
        if (c !== "\\" || next === undefined) out += c;
        else if (next === "n" || next === "N") [out, i] = [`${out}\n`, i + 1];
        else if (next === "\\" || next === "," || next === ";") [out, i] = [out + next, i + 1];
        else out += c;
      }
      return out;
    };
    const plainList = (value: string): string[] => {
      const parts: string[] = [];
      let current = "";
      for (let i = 0; i < value.length; i++) {
        const c = value[i]!;
        if (c === "\\" && i + 1 < value.length) [current, i] = [current + c + value[i + 1]!, i + 1];
        else if (c === ",") [parts[parts.length], current] = [plainUnescape(current), ""];
        else current += c;
      }
      return [...parts, plainUnescape(current)];
    };
    const plainDecode = (raw: string): string => {
      let out = "";
      for (let i = 0; i < raw.length; i++) {
        const [c, next] = [raw[i]!, raw[i + 1]];
        if (c === "^" && (next === "^" || next === "n" || next === "'")) [out, i] = [out + (next === "^" ? "^" : next === "n" ? "\n" : '"'), i + 1];
        else out += c;
      }
      return out;
    };
    const plainValues = (raw: string): string[] => {
      const values: string[] = [];
      let [current, quoted] = ["", false];
      for (const c of raw) {
        if (c === '"') quoted = !quoted;
        else if (c === "," && !quoted) [values[values.length], current] = [plainDecode(current), ""];
        else current += c;
      }
      return [...values, plainDecode(current)];
    };
    const plainFold = (line: string): string => {
      let [out, room] = ["", 75];
      for (const ch of line) {
        const point = ch.codePointAt(0)!;
        const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
        if (size > room) [out, room] = [`${out}\r\n `, 74];
        [out, room] = [out + ch, room - size];
      }
      return out;
    };
    let seed = 20261114;
    const next = (below: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      // The high bits: the low ones of such a sequence repeat after a few steps.
      return Math.floor((seed / 2 ** 32) * below);
    };
    const made = (alphabet: readonly string[], most: number): string => Array.from({ length: next(most) }, () => alphabet[next(alphabet.length)]!).join("");
    const text = ["a", "\\", "\\", "n", "N", ",", ";", "é", "🏺", " "];
    const param = ["a", "^", "^", "n", "'", '"', ",", "é", "x"];
    const wide = ["a", "a", "a", "é", "語", "🏺", "\ud83c", " "];
    for (let n = 0; n < 4000; n++) {
      const [t, p, w] = [made(text, 24), made(param, 24), made(wide, 240)];
      expect(unescapeText(t), JSON.stringify(t)).toBe(plainUnescape(t));
      expect(splitTextList(t), JSON.stringify(t)).toEqual(plainList(t));
      expect(decodeParamValue(p), JSON.stringify(p)).toBe(plainDecode(p));
      // Without an equals sign in it the text is one parameter's, whatever else it holds; a colon ends the line's head.
      const scanned = scanContentLine(`X;P=${p}:v`, 1000);
      if (scanned !== null && scanned !== "too_many_parameters") expect(scanned.params[0]!.values, JSON.stringify(p)).toEqual(plainValues(p));
      expect(fold(w), JSON.stringify(w)).toBe(plainFold(w));
    }
    // A text with nothing to unescape, and a line with nothing to fold, are the strings they were.
    expect([unescapeText("plain"), decodeParamValue("plain"), fold("UID:1")]).toEqual(["plain", "plain", "UID:1"]);
  });

  it("reads the four kinds of time and refuses a date that does not exist", () => {
    const line = (l: string) => timeOf(parseContentLine(l)!);
    expect(line("DTSTART;VALUE=DATE:20261121")).toEqual({ kind: "date", year: 2026, month: 11, day: 21 });
    expect(line("DTSTART:20261121")).toEqual({ kind: "date", year: 2026, month: 11, day: 21 });
    expect(line("DTSTART:20261125T150000Z")).toEqual({ kind: "instant", epochMs: at("2026-11-25T15:00:00Z") });
    expect(line("DTSTART;TZID=Europe/Zurich:20261128T100030")).toEqual({ kind: "zoned", tzid: "Europe/Zurich", wall: { year: 2026, month: 11, day: 28, hour: 10, minute: 0, second: 30 } });
    expect(line('DTSTART;TZID="W. Europe Standard Time":20261126T1400')).toMatchObject({ kind: "zoned", tzid: "W. Europe Standard Time", wall: { hour: 14, second: 0 } });
    expect(line("DTSTART:20261205T100000")).toMatchObject({ kind: "floating" });
    expect(line("DTSTART:20260230T100000")).toBeNull();
    expect(line("DTSTART;VALUE=DATE:20260229")).toBeNull();
    expect(line("DTSTART:20261205T250000")).toBeNull();
    expect(line("DTSTART:next tuesday")).toBeNull();
    expect(parseDate("20240229")).not.toBeNull();
    expect(parseDateTime("20161231T235960Z")).toMatchObject({ wall: { second: 59 }, utc: true });
  });

  it("writes each kind of time in its own form", () => {
    const written = (l: string) => formatContentLine(timeProperty("DTSTART", timeOf(parseContentLine(l)!)!));
    for (const l of ["DTSTART;VALUE=DATE:20261121", "DTSTART:20261125T150000Z", "DTSTART;TZID=Europe/Zurich:20261128T100030", "DTSTART:20261205T100000"]) expect(written(l)).toBe(l);
    expect(formatInstant(at("1969-12-31T23:59:59Z"))).toBe("19691231T235959Z");
  });

  it("reads durations, periods, offsets and addresses", () => {
    expect(parseDuration("-P0DT0H10M0S")).toEqual({ negative: true, weeks: 0, days: 0, hours: 0, minutes: 10, seconds: 0 });
    expect(parseDuration("+P1W")).toMatchObject({ negative: false, weeks: 1 });
    expect(parseDuration("P")).toBeNull();
    expect(parseDuration("PT")).toBeNull();
    expect(parseDuration("+P1M")).toBeNull();
    expect(formatDuration(parseDuration("P1000DT2H30M")!)).toBe("P1000DT2H30M");
    expect(formatDuration(parseDuration("-P1DT2H30M")!)).toBe("-P1DT2H30M");
    expect(formatDuration(parseDuration("-P2W")!)).toBe("-P2W");
    expect(formatDuration(parseDuration("-PT15M")!)).toBe("-PT15M");
    expect(formatDuration(parseDuration("PT0S")!)).toBe("PT0S");
    expect(parsePeriod("20260110T100000Z/20260110T113000Z")).toMatchObject({ end: { utc: true }, duration: null });
    expect(parsePeriod("20260112T100000Z/PT45M")).toMatchObject({ end: null, duration: { minutes: 45 } });
    expect(parsePeriod("20260112T100000Z")).toBeNull();
    expect(parseUtcOffset("+0100")).toBe(3600);
    expect(parseUtcOffset("-0500")).toBe(-18000);
    expect(parseUtcOffset("+003408")).toBe(2048);
    expect(parseUtcOffset("0100")).toBeNull();
    expect(formatUtcOffset(2048)).toBe("+003408");
    expect(formatUtcOffset(-12600)).toBe("-0330");
    expect(mailAddressOf("MAILTO:Mila.Brunner@Atelier.example?subject=x")).toBe("mila.brunner@atelier.example");
    expect(mailAddressOf("javascript:alert(1)")).toBeNull();
    expect(mailAddressOf("mailto:nobody")).toBeNull();
  });

  it("finds Apple's quoted title with its comma whole", () => {
    const line = unfold(text(apple_event)).find((l) => l.startsWith("X-APPLE-STRUCTURED-LOCATION"))!;
    expect(paramOf(parseContentLine(line)!, "X-TITLE")).toBe("Winter market\\nHafenhalle, Uferweg 3");
  });
});
