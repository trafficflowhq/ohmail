import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESURFACE_TIME,
  RESURFACE_HOURS,
  dayAt,
  dayNine,
  liveActions,
  nextWeekAt,
  nextWeekNine,
  pickFloor,
  resurfaceClock,
  resurfaceHorizons,
  resurfaceTimeLabel,
  tomorrowAt,
  tomorrowNine,
  type LiveWorldActions,
} from "../src/state/live";
import { Copy } from "../src/copy";

/**
 * ═══ THE PHONE'S RESURFACE TIME — PARITY WITH THE WEBAPP STRIP (mail 0110) ═════════════════
 * Three halves, all owed here: a time can be chosen, the chosen one becomes the default, and it
 * is SHOWN before anybody decides. A horizon carries the wall clock it BOOKED (`ResurfaceHorizon`)
 * — the same composition the webapp's `format.ts` uses, so the two platforms resolve a clock
 * change the same way; the zone is an argument in the cases that test one, never the machine's.
 * The SHEET's half is read off its source (the `action-parity.test.ts` idiom): this suite has no
 * renderer, and each needle is a control position. Red on: `hour: 9` restored in `horizonOn`;
 * `detail` taken off the chosen time again rather than the horizon's; the `chosen !== storedHhmm`
 * guard inverted.
 */

const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const sheet = src("../src/ui/MessageActions.tsx");

describe("the resurface clock", () => {
  it("resolves every unreadable answer to the product's 09:00 — and nothing else", () => {
    for (const bad of [null, undefined, "", "9:00", "25:00", "14:60", "14-30", "  14:30"]) {
      expect(resurfaceClock(bad), `resurfaceClock(${JSON.stringify(bad)})`)
        .toEqual({ hour: 9, minute: 0 });
    }
    expect(DEFAULT_RESURFACE_TIME).toBe("09:00");
    expect(resurfaceClock("14:30")).toEqual({ hour: 14, minute: 30 });
    // Midnight is a time, not a falsy value — the one hour a truthiness read would lose.
    expect(resurfaceClock("00:00")).toEqual({ hour: 0, minute: 0 });
    expect(resurfaceTimeLabel(7, 5)).toBe("07:05");
  });

  it("offers every half hour from 06:00 to 22:00 — 33 rows, in order, no duplicates", () => {
    expect(RESURFACE_HOURS).toHaveLength(33);
    expect(RESURFACE_HOURS[0]).toBe("06:00");
    expect(RESURFACE_HOURS[1]).toBe("06:30");
    expect(RESURFACE_HOURS[RESURFACE_HOURS.length - 1]).toBe("22:00");
    expect(new Set(RESURFACE_HOURS).size).toBe(RESURFACE_HOURS.length);
    // Every row is a value the clock accepts — a row the horizons could not mint would be a
    // control that silently does something else.
    for (const hhmm of RESURFACE_HOURS) {
      const { hour, minute } = resurfaceClock(hhmm);
      expect(resurfaceTimeLabel(hour, minute)).toBe(hhmm);
    }
  });
});

describe("the horizons land at the chosen time", () => {
  const from = new Date("2026-08-22T15:00:00");

  it("tomorrow, next week and a picked day all take the hour they are given", () => {
    for (const [at, hour, minute] of [["14:30", 14, 30], ["07:15", 7, 15], ["00:00", 0, 0]] as const) {
      expect([tomorrowAt(from, at).at.getHours(), tomorrowAt(from, at).at.getMinutes()]).toEqual([hour, minute]);
      expect([nextWeekAt(from, at).at.getHours(), nextWeekAt(from, at).at.getMinutes()]).toEqual([hour, minute]);
      expect([dayAt(from, 21, at).at.getHours(), dayAt(from, 21, at).at.getMinutes()]).toEqual([hour, minute]);
    }
  });

  it("…and the days are the days they always were", () => {
    expect(tomorrowAt(from, "14:30").at.getDate()).toBe(new Date("2026-08-23T00:00:00").getDate());
    // Never "later today": a Monday resolves to the NEXT one, whatever hour is asked for.
    expect(nextWeekAt(from, "14:30").at.getDay()).toBe(1);
    expect(nextWeekAt(from, "14:30").at.getTime()).toBeGreaterThan(from.getTime());
  });

  it("an unreadable stored value lands on 09:00 rather than throwing the horizon away", () => {
    expect(tomorrowAt(from, "25:00").at.getHours()).toBe(9);
    expect(nextWeekAt(from, null).at.getHours()).toBe(9);
  });

  it("the `*Nine` names are the product's hour, exactly — the phone's send-later still reads them", () => {
    expect(tomorrowNine(from).getTime()).toBe(tomorrowAt(from, null).at.getTime());
    expect(nextWeekNine(from).getTime()).toBe(nextWeekAt(from, null).at.getTime());
    expect(dayNine(from, 5).getTime()).toBe(dayAt(from, 5, null).at.getTime());
  });
});

describe("the horizon-less verbs take the account's time too", () => {
  /** The facade with nothing behind it — these cases read what it PUT ON THE WIRE, nothing else. */
  function actionsReading(resurfaceTime: () => string | null): {
    actions: LiveWorldActions; sent: Array<Record<string, unknown>>;
  } {
    const sent: Array<Record<string, unknown>> = [];
    const engine = {
      read: () => ({ get: () => undefined, list: () => [] }),
      verbRead: () => ({ get: () => undefined, list: () => [] }),
      mutate: (m: Record<string, unknown>) => { sent.push(m); return Promise.resolve({ ok: true }); },
    };
    const actions = liveActions({
      engine: engine as never,
      toast: () => undefined,
      now: () => new Date("2026-08-22T15:00:00"),
      resurfaceTime,
    });
    return { actions, sent };
  }

  it("setPile('resurface') books tomorrow at the account's hour, READ AT THE PRESS", () => {
    // A LET, not a constant: the getter exists because the consent read lands after the facade
    // is built, so this case moves the value under a facade that was already constructed —
    // capture it at construction and the second press below books 09:00.
    let stored: string | null = null;
    const { actions, sent } = actionsReading(() => stored);
    void actions.setPile("m1", "resurface");
    expect(new Date(sent[0]!.bubbleUpAt as string).getHours()).toBe(9);
    stored = "14:30";
    void actions.setPile("m2", "resurface");
    const second = new Date(sent[1]!.bubbleUpAt as string);
    expect([second.getHours(), second.getMinutes()]).toEqual([14, 30]);
  });
});

describe("a phone horizon across a clock change", () => {
  /* The zone is an ARGUMENT here, and the dates are fixed: a case that read the machine's zone
     would pass or fail by where the machine is standing. Europe/Zurich skips 02:30 on 2027-03-28
     and has it twice on 2026-10-25. */
  const Z = "Europe/Zurich";
  const wall = (d: Date): string =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: Z, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(d);

  it("books the next hour that exists, and says so, when the clocks skip the chosen one", () => {
    const h = tomorrowAt(new Date("2027-03-27T10:00:00Z"), "02:30", Z);
    expect(h.verdict).toBe("shifted_forward");
    expect(wall(h.at)).toBe("28/03/2027, 03:30");
    // The row's detail and the sentence under it both come off the instant, not off "02:30".
    expect(h.time).toBe("03:30");
    expect(Copy.resurfaceSkipNote(Copy.resurfaceTomorrow, h.time, "02:30"))
      .toBe("Tomorrow lands at 03:30 — the clocks skip 02:30 that night.");
  });

  it("takes the FIRST of the two when the chosen hour comes round twice", () => {
    const h = tomorrowAt(new Date("2026-10-24T10:00:00Z"), "02:30", Z);
    expect(h.verdict).toBe("first_of_two");
    expect(h.at.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    // Nothing differs from the request here, so the sheet says nothing extra.
    expect(h.time).toBe("02:30");
  });

  it("an ordinary night is exact — the positive control", () => {
    const h = tomorrowAt(new Date("2026-08-11T10:00:00Z"), "14:30", Z);
    expect([h.verdict, h.time]).toEqual(["exact", "14:30"]);
    expect(wall(h.at)).toBe("12/08/2026, 14:30");
  });

  it("the rule is the composition's, not the horizon's — a picked day resolves the same", () => {
    const day = dayAt(new Date("2027-03-27T10:00:00Z"), 1, "02:30", Z);
    expect([day.verdict, day.time]).toEqual(["shifted_forward", "03:30"]);
    const week = nextWeekAt(new Date("2026-10-19T10:00:00Z"), "02:30", Z);
    // The coming Monday (26 October) is the day after the repeated hour: an ordinary 02:30.
    expect([week.verdict, wall(week.at)]).toEqual(["exact", "26/10/2026, 02:30"]);
  });

  it("after midnight on a Sunday, Tomorrow is this morning, across the change", () => {
    // 00:28 CEST on Sunday 25 October 2026 (back at 03:00) and 00:28 CET on 28 March 2027.
    expect(tomorrowAt(new Date("2026-10-24T22:28:00Z"), "09:00", Z).at.toISOString()).toBe("2026-10-25T08:00:00.000Z");
    expect(tomorrowAt(new Date("2027-03-27T23:28:00Z"), "09:00", Z).at.toISOString()).toBe("2027-03-28T07:00:00.000Z");
    expect(tomorrowAt(new Date("2026-10-25T10:00:00Z"), "09:00", Z).at.toISOString()).toBe("2026-10-26T08:00:00.000Z");
  });

  it("on a Sunday in the day, Next week is Tomorrow's Monday, so it is not offered", () => {
    for (const iso of ["2026-10-25T04:01:00Z", "2026-10-25T10:00:00Z", "2026-10-25T21:30:00Z"]) {
      const h = resurfaceHorizons(new Date(iso), "09:00", Z);
      expect([h.tomorrow.at.toISOString(), h.nextWeek], iso).toEqual(["2026-10-26T08:00:00.000Z", null]);
    }
    const night = resurfaceHorizons(new Date("2026-10-24T22:28:00Z"), "09:00", Z);
    expect([night.tomorrow.at.toISOString(), night.nextWeek?.at.toISOString()])
      .toEqual(["2026-10-25T08:00:00.000Z", "2026-10-26T08:00:00.000Z"]);
  });

  it("Pick a date starts today while today's hour is still ahead", () => {
    expect(pickFloor(new Date("2026-10-24T22:28:00Z"), "09:00", Z)).toBe(0);
    expect(pickFloor(new Date("2026-08-11T10:00:00Z"), "18:00", Z)).toBe(0);
    expect(pickFloor(new Date("2026-08-11T10:00:00Z"), "09:00", Z)).toBe(1);
  });

  it("the phone and the webapp resolve the same night the same way", async () => {
    const { composeZonedWallClock } = await import("@ohmail/client-engine");
    const shared = composeZonedWallClock({ year: 2027, month: 3, day: 28, hour: 2, minute: 30 }, Z);
    const h = tomorrowAt(new Date("2027-03-27T10:00:00Z"), "02:30", Z);
    // ONE function, two platforms: the phone adds calendar days and nothing else.
    expect([h.at.toISOString(), h.verdict]).toEqual([shared.instant.toISOString(), shared.verdict]);
  });
});

describe("the sheet states the time before anybody decides", () => {
  it("its first row is the time itself, with the value on the right", () => {
    expect(sheet).toMatch(/label=\{Copy\.resurfaceTime\}\s+detail=\{resurfaceTime\}/);
    // …and it opens the half-hour list rather than acting.
    expect(sheet).toMatch(/label=\{Copy\.resurfaceTime\}[\s\S]{0,120}?setOpen\("time"\)/);
  });

  it("every dated row carries the time it BOOKS; Now carries none", () => {
    // The horizon's own `time`, never the digits in the row above it: on the night the clocks
    // skip the chosen hour those two differ, and the row that shows the chosen one is the defect.
    for (const [verb, horizon] of [["resurfaceTomorrow", "tomorrow"], ["resurfaceNextWeek", "nextWeek"]]) {
      expect(sheet, `${verb} shows no booked time`)
        .toMatch(new RegExp(`label=\\{Copy\\.${verb}\\}\\s+detail=\\{${horizon}\\.time\\}`));
    }
    // The 90-day rows too — the label is the day, the detail is the hour it lands at.
    expect(sheet).toMatch(/label=\{dayLabel\(day\.at, locale\)\}\s+detail=\{day\.time\}/);
    // "Now" is a state, not a date: a time beside it would be a control that lies.
    expect(sheet).toMatch(/label=\{Copy\.resurfaceNow\}(?![\s\S]{0,80}detail=)/);
  });

  it("the half-hour list marks the current value and writes it back", () => {
    expect(sheet).toMatch(/RESURFACE_HOURS\.map/);
    expect(sheet).toMatch(/on=\{hhmm === resurfaceTime\}/);
    expect(sheet).toMatch(/setPickedTime\(hhmm\)/);
  });

  it("a chosen horizon dispatches FIRST and remembers a CHANGED time after", () => {
    const pick = sheet.slice(sheet.indexOf("const pickResurface"));
    const body = pick.slice(0, pick.indexOf("\n  };"));
    expect(body.indexOf("a.resurfaceAt("), "the write was not after the dispatch")
      .toBeLessThan(body.indexOf("w.remember("));
    expect(body).toMatch(/if \(chosen !== storedHhmm\) void w\.remember\(chosen\)/);
    // A refused write leaves the booking standing — the message was the ask.
    expect(body).toMatch(/\.catch\(\(\) => undefined\)/);
  });

  it("the phone's word for the time is the webapp's own", () => {
    const en = JSON.parse(src("../../webapp/messages/en.json")) as { ohbox: Record<string, string> };
    expect(Copy.resurfaceTime).toBe(en.ohbox.resurfaceTime);
  });
});
