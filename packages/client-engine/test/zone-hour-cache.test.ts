import { describe, expect, it, vi } from "vitest";
import { formattedFields, zonedDayNumber, zonedFields } from "../src/zone.js";

/**
 * THE HOUR CACHE ANSWERS WHAT THE PLATFORM ANSWERS. `zonedFields` reads a zone's offset once per UTC
 * hour and computes the rest; every minute of every 2026 transition day, in zones whose transitions
 * fall on the hour, on the half hour (Lord Howe moves by 30 minutes) and at :45 (Chatham), must read
 * exactly as `formatToParts` reads it, and a zone with no transition (Kolkata, UTC) too.
 */

const ZONES = ["Europe/Zurich", "America/New_York", "Australia/Lord_Howe", "Pacific/Chatham", "Asia/Kolkata", "UTC"];
const DAY = 86_400_000;
const MIN = 60_000;

function offsetOf(ms: number, zone: string): number {
  const f = formattedFields(new Date(ms), zone);
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - Math.floor(ms / 1000) * 1000;
}

/** The UTC days of 2026 on which `zone`'s offset changes (plus the first of the year as a control). */
function transitionDays(zone: string): number[] {
  const start = Date.UTC(2026, 0, 1);
  const days = [start];
  for (let d = start; d < Date.UTC(2027, 0, 1); d += DAY) {
    if (offsetOf(d, zone) !== offsetOf(d + DAY, zone)) days.push(d);
  }
  return days;
}

describe("zonedFields' hour cache", () => {
  for (const zone of ZONES) {
    it(`${zone}: every minute of its 2026 transition days reads as formatToParts does`, () => {
      const days = transitionDays(zone);
      if (zone === "Asia/Kolkata" || zone === "UTC") expect(days).toHaveLength(1);
      else expect(days.length).toBeGreaterThanOrEqual(3);
      let checked = 0;
      for (const d of days) {
        for (let t = d - DAY; t < d + 2 * DAY; t += MIN) {
          // An odd second inside the minute, so the arithmetic is asked about seconds too.
          const at = new Date(t + 17_250);
          expect(zonedFields(at, zone), `${zone} @ ${at.toISOString()}`).toEqual(formattedFields(at, zone));
          checked += 1;
        }
      }
      expect(checked).toBeGreaterThan(4000);
    });
  }

  it("asks formatToParts at most twice per hour bucket on a warm run", () => {
    const zone = "Europe/Zurich";
    const base = Date.UTC(2026, 5, 10, 8, 0, 0);
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    try {
      for (let i = 0; i < 10_000; i++) zonedDayNumber(new Date(base + (i % 3600) * 1000), zone);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
      spy.mockClear();
      for (let i = 0; i < 10_000; i++) zonedDayNumber(new Date(base + (i % 3600) * 1000), zone);
      expect(spy.mock.calls.length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("an unknown zone and an invalid instant still throw", () => {
    expect(() => zonedFields(new Date(), "Not/A_Zone")).toThrow(RangeError);
    expect(() => zonedFields(new Date(Number.NaN), "Europe/Zurich")).toThrow(RangeError);
  });
});

/**
 * A PLATFORM THAT MISREADS THE NOON HOUR. Hermes on Android answered `formatToParts`' hour part "00"
 * for every minute of the local 12 o'clock hour, and the hour cache spread that one reading over the
 * whole hour: 12:05 read 00:05. The fake below reads the hour that way; the device's zone takes its
 * offset from `Date#getTimezoneOffset`, any other zone from its `longOffset` name.
 */
const RealDTF = Intl.DateTimeFormat;
const Z = "Europe/Zurich";
const CLOCKS = ["00:00", "00:30", "11:59", "12:00", "12:05", "12:59", "13:00", "23:59"];
// Two Fridays: one in CET (UTC+1), one in CEST (UTC+2).
const DAYS = [{ y: 2026, m: 10, d: 30, utcOffset: 1 }, { y: 2026, m: 7, d: 10, utcOffset: 2 }];

function realOffsetMs(ms: number, zone: string): number {
  const parts = new RealDTF("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const whole = Math.floor(ms / 1000) * 1000;
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - whole;
}

function installNoonMisreading(device: string, longOffset: boolean): () => void {
  class NoonMisreading extends RealDTF {
    readonly zoneAsked: string | undefined;
    constructor(locale?: string | string[], opts: Intl.DateTimeFormatOptions = {}) {
      if (opts.timeZoneName === "longOffset" && !longOffset) throw new RangeError("timeZoneName");
      super(locale, opts);
      this.zoneAsked = opts.timeZone;
    }
    override formatToParts(date?: Date | number): Intl.DateTimeFormatPart[] {
      return super.formatToParts(date).map((p) => (p.type === "hour" && p.value === "12" ? { ...p, value: "00" } : p));
    }
    override resolvedOptions(): Intl.ResolvedDateTimeFormatOptions {
      const o = super.resolvedOptions();
      return this.zoneAsked === undefined ? { ...o, timeZone: device } : o;
    }
  }
  Object.defineProperty(Intl, "DateTimeFormat", { value: NoonMisreading, configurable: true, writable: true });
  const own = vi.spyOn(Date.prototype, "getTimezoneOffset").mockImplementation(function (this: Date) {
    return -realOffsetMs(this.getTime(), device) / 60_000;
  });
  return () => {
    Object.defineProperty(Intl, "DateTimeFormat", { value: RealDTF, configurable: true, writable: true });
    own.mockRestore();
  };
}

describe("a platform that reads the noon hour as 00", () => {
  const platforms: [string, (() => () => void) | null][] = [
    ["the device's own zone, no longOffset", () => installNoonMisreading(Z, false)],
    ["another zone, read by its longOffset", () => installNoonMisreading("America/New_York", true)],
    ["the real Intl", null],
  ];
  for (const [name, install] of platforms) {
    it(`${name}: every clock of a Zurich day reads as the wall clock`, async () => {
      vi.resetModules();
      const restore = install ? install() : () => {};
      try {
        const { clock, fullDateTime, messageStamp, weekdayClock } = await import("../src/stamp.js");
        for (const { y, m, d, utcOffset } of DAYS) {
          const now = new Date(Date.UTC(y, m - 1, d, 23 - utcOffset, 59, 30));
          for (const hhmm of CLOCKS) {
            const [h, min] = hhmm.split(":").map(Number);
            const at = new Date(Date.UTC(y, m - 1, d, h - utcOffset, min));
            const iso = at.toISOString();
            expect(clock(at, Z), `${iso}`).toBe(hhmm);
            for (const locale of ["en", "de"]) {
              const name = (o: Intl.DateTimeFormatOptions) => new RealDTF(locale, { ...o, timeZone: Z }).format(at);
              const weekday = name({ weekday: "short" });
              expect(messageStamp({ date: iso, sortAt: iso }, now, Z, locale), `${iso} ${locale}`).toBe(hhmm);
              expect(weekdayClock(at, Z, locale), `${iso} ${locale}`).toBe(`${weekday} ${hhmm}`);
              expect(fullDateTime(at, Z, locale), `${iso} ${locale}`)
                .toBe(`${weekday} ${d} ${name({ month: "short" })} ${y}, ${hhmm}`);
            }
          }
        }
      } finally {
        restore();
      }
    });
  }
});
