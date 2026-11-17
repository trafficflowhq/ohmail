import { describe, expect, it } from "vitest";
import { intlZones, wall, zoned, type EventTime } from "@ohmail/cal-core";
import { searchEvents, slips, wordsOf } from "../../../src/calendar/spans/index.js";

const zones = intlZones();
const ZONE = "Europe/Zurich";
const at = (y: number, mo: number, d: number, h = 0): EventTime => zoned(wall(y, mo, d, h, 0), ZONE);
const ev = (
  id: string,
  title: string,
  start: EventTime,
  more: { place?: string; people?: string[]; notes?: string } = {},
) => ({
  id,
  start,
  end: start,
  text: [title, more.place ?? "", ...(more.people ?? []), more.notes ?? ""],
});
const items = [
  ev("tc", "Tech check", at(2026, 11, 20, 10), { place: "Studio Zwei" }),
  ev("tc-old", "Tech check", at(2026, 10, 2, 10)),
  ev("tc-older", "Tech check", at(2026, 9, 1, 10)),
  ev("poster", "Poster review", at(2026, 11, 18, 14), { people: ["Jonas Keller"] }),
  ev("cafe", "Café with Zoë", at(2026, 11, 24, 8), { notes: "bring the Größenliste" }),
];
const find = (q: string) =>
  searchEvents({
    query: q,
    items,
    keyOf: (x) => x.id,
    textOf: (x) => x.text,
    today: "2026-11-16",
    zone: ZONE,
    zones,
  });

describe("search over what the device holds", () => {
  it("words are folded: case and accents", () => {
    expect(wordsOf("Café with ZOË, Größe")).toEqual(["cafe", "with", "zoe", "grosse"]);
  });
  it("counts one swap of neighbours as one slip", () => {
    expect(slips("tehc", "tech", 1)).toBe(1);
    expect(slips("chek", "check", 1)).toBe(1);
    expect(slips("abcd", "wxyz", 1)).toBe(2);
  });
  it("a typo is forgiven in a word of four letters or more, and said as what it was read as", () => {
    const r = find("tehc check");
    expect(r.hits.map((h) => h.key)).toEqual(["tc", "tc-old", "tc-older"]);
    expect(r.readAs).toBe("tech check");
  });
  it("a word of three letters is a prefix or nothing", () => {
    expect(find("pos").hits.map((h) => h.key)).toEqual(["poster"]);
    expect(find("pso").hits).toEqual([]);
  });
  it("upcoming first, then what has been, newest first", () => {
    expect(find("tech").hits.map((h) => h.key)).toEqual(["tc", "tc-old", "tc-older"]);
    expect(find("tech").readAs).toBe("");
  });
  it("every word must be found: place, people and notes count", () => {
    expect(find("studio tech").hits.map((h) => h.key)).toEqual(["tc"]);
    expect(find("jonas").hits.map((h) => h.key)).toEqual(["poster"]);
    expect(find("grossenliste").hits.map((h) => h.key)).toEqual(["cafe"]);
    expect(find("marzipan").hits).toEqual([]);
  });
  it("an empty field finds nothing and says nothing", () => {
    expect(find("  ")).toEqual({ any: false, hits: [], readAs: "", unplaced: 0 });
  });
  it("counts a match in a time zone this device does not know, never dropping it unsaid", () => {
    const outlook = {
      ...ev("ol", "Supplier call", at(2026, 11, 18, 9)),
      start: zoned(wall(2026, 11, 18, 9, 0), "Customized Time Zone"),
      end: zoned(wall(2026, 11, 18, 10, 0), "Customized Time Zone"),
    };
    const r = searchEvents({
      query: "supplier",
      items: [...items, outlook],
      keyOf: (x) => x.id,
      textOf: (x) => x.text,
      today: "2026-11-16",
      zone: ZONE,
      zones,
    });
    expect(r.hits).toEqual([]);
    expect(r.unplaced).toBe(1);
    expect(find("tech").unplaced).toBe(0);
  });
  it("each hit carries its day in the reader's zone", () => {
    expect(find("poster").hits[0]!.day).toBe("2026-11-18");
  });
});
