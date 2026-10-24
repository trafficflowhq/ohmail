/**
 * EVERY MAIL TIME RENDERS IN THE READER'S ZONE.
 *
 * The product used to show two zones at once: `AboutSection` and `MailboxSection` render
 * account dates through `toLocaleDateString`, which is local, while every
 * MAIL stamp — the row time, the hover title, the resurface label — was formatted with
 * `timeZone: "UTC"`. A reader in Zurich saw their account created "5 August" and the message that
 * arrived at 16:32 stamped "14:32", two hours behind the clock on the same screen.
 *
 * These are the guards for the seam that fixes it: `activeFormatZone()` beside
 * `activeFormatLocale()`, one resolution of the platform zone, injectable here.
 *
 * They are written against a CET/CEST reader on purpose. Zurich is +01:00 in winter and +02:00 in
 * summer, so a hand-rolled offset — the obvious wrong implementation — passes half of this file and
 * fails the other half.
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { messageDisplayTime } from "@ohmail/client-engine";
import {
  clockOf,
  dayNine,
  dayValue,
  displayTime,
  fullDateTime,
  nextFridayNine,
  nextWeekNine,
  resurfaceLabel,
  tomorrowNine,
} from "../app/shell/format";
import { activeFormatZone, setActiveFormatZone } from "../app/shell/locale";

const ZURICH = "Europe/Zurich";

/** A message with just enough shape for the stamp functions. */
const msg = (date: string | null) => ({ id: "m1", date, from: { address: "a@b.c" } }) as never;

beforeEach(() => setActiveFormatZone(ZURICH));
afterEach(() => setActiveFormatZone(null));

describe("the zone seam", () => {
  it("resolves the platform zone when nobody has injected one", () => {
    setActiveFormatZone(null);
    expect(activeFormatZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("takes an injected zone, and gives it back after a clear", () => {
    expect(activeFormatZone()).toBe(ZURICH);
    setActiveFormatZone("Pacific/Auckland");
    expect(activeFormatZone()).toBe("Pacific/Auckland");
  });
});

describe("the clock a reader sees", () => {
  /* THE OWNER'S REPORT, as an assertion. 14:32 UTC on 11 August is 16:32 in Zurich (CEST, +2). */
  it("clockOf renders the reader's wall clock, not UTC", () => {
    expect(clockOf("2026-08-11T14:32:00Z")).toBe("16:32");
  });

  it("and it survives the DST edge — the same offset is not applied all year", () => {
    /* January is CET (+1). The same 14:32 UTC is 15:32, not 16:32. */
    expect(clockOf("2026-01-11T14:32:00Z")).toBe("15:32");
  });

  it("midnight in the reader's zone reads 00:xx, never 24:xx", () => {
    /* 2026-08-10T22:10Z is 00:10 on the 11th in Zurich — the hour cycle must be h23. */
    expect(clockOf("2026-08-10T22:10:00Z")).toBe("00:10");
  });

  it("the hover title carries the reader's date AND clock", () => {
    /* 22:10 UTC on 4 August is 00:10 on WEDNESDAY the 5th in Zurich — the day moves too. */
    expect(fullDateTime(msg("2026-08-04T22:10:00.000Z"))).toBe("Wed 5 Aug 2026, 00:10");
  });
});

describe("the row stamp bands on the reader's midnights", () => {
  /**
   * The band is "today / this week / dated", and "today" has to mean the reader's today. At
   * 2026-08-11T22:10Z it is already the 12th in Zurich, so a message from 2026-08-11T23:30Z — one
   * hour and twenty minutes LATER — is on the reader's calendar day and stamps a clock; a message
   * from 2026-08-11T09:00Z is on the previous reader day and stamps a weekday. Banded on UTC
   * midnights both would read as "today".
   */
  const now = new Date("2026-08-11T22:10:00Z"); // 00:10 on the 12th, Zurich

  it("a message after the reader's midnight is today", () => {
    expect(displayTime(msg("2026-08-11T23:30:00Z"), now)).toBe("01:30");
  });

  it("a message before the reader's midnight is yesterday, and names its day", () => {
    expect(displayTime(msg("2026-08-11T09:00:00Z"), now)).toBe("Tue 11:00");
  });

  it("the engine bands on whichever zone it is told, and the two disagree", () => {
    /* One instant, one `now`, two readers. The clock differs — 23:30 there, 01:30 here — and so
       does the DAY it is counted against, which is the half a wall-clock-only fix would miss. */
    expect(messageDisplayTime(msg("2026-08-11T23:30:00Z"), now, ZURICH)).toBe("01:30");
    expect(messageDisplayTime(msg("2026-08-11T23:30:00Z"), now, "UTC")).toBe("23:30");

    /* 2026-08-10T23:30Z is Monday in UTC and already Tuesday the 11th in Zurich, and `now` is a
       reader day later in both — so both take the weekday band and name DIFFERENT weekdays. */
    expect(messageDisplayTime(msg("2026-08-10T23:30:00Z"), now, "UTC")).toBe("Mon 23:30");
    expect(messageDisplayTime(msg("2026-08-10T23:30:00Z"), now, ZURICH)).toBe("Tue 01:30");
  });

  it("the dated band reads the reader's calendar date", () => {
    /* 2026-07-31T23:30Z is 01:30 on 1 AUGUST in Zurich. A UTC render says "31 Jul". */
    expect(displayTime(msg("2026-07-31T23:30:00Z"), now)).toBe("1 Aug");
  });
});

describe("the resurface presets mint 09:00 in the reader's zone", () => {
  /**
   * `bubbleUpAt` stays a UTC instant — the worker compares instants and nothing about storage
   * moves. What changes is WHICH instant "09:00" is: 07:00Z in summer, 08:00Z in winter. Minting
   * 09:00Z and rendering it locally would put "Tomorrow 09:00" on screen as 11:00.
   */
  it("tomorrow, in CEST (summer, +02:00)", () => {
    const from = new Date("2026-08-11T14:32:00Z");
    const iso = tomorrowNine(from);
    expect(iso).toBe("2026-08-12T07:00:00.000Z");
    expect(resurfaceLabel(iso, from)).toBe("Wed 09:00");
  });

  it("tomorrow, in CET (winter, +01:00) — the same code, a different offset", () => {
    const from = new Date("2026-01-11T14:32:00Z");
    const iso = tomorrowNine(from);
    expect(iso).toBe("2026-01-12T08:00:00.000Z");
    expect(resurfaceLabel(iso, from)).toBe("Mon 09:00");
  });

  it("next week is the coming Monday, 09:00 local", () => {
    /* 2026-08-11 is a Tuesday; the coming Monday is the 17th. */
    const from = new Date("2026-08-11T14:32:00Z");
    const iso = nextWeekNine(from);
    expect(iso).toBe("2026-08-17T07:00:00.000Z");
    expect(resurfaceLabel(iso, from)).toBe("Mon 09:00");
  });

  it("next Friday is the coming Friday, 09:00 local", () => {
    const from = new Date("2026-08-11T14:32:00Z");
    const iso = nextFridayNine(from);
    expect(iso).toBe("2026-08-14T07:00:00.000Z");
    expect(resurfaceLabel(iso, from)).toBe("Fri 09:00");
  });

  it("a resurface past this week names its date", () => {
    /* Friday 25 Sep, 17:35 in Zurich. 25 Dec is a Friday too, and "Fri 10:00" read as this
       morning — overdue by seven hours. 10:00 CET is 09:00Z. */
    const friday = new Date("2026-09-25T15:35:00Z");
    expect(resurfaceLabel("2026-12-25T09:00:00.000Z", friday)).toBe("25 Dec, 10:00");
    expect(resurfaceLabel("2026-09-25T16:00:00.000Z", friday)).toBe("18:00");
    expect(resurfaceLabel("2027-01-08T08:00:00.000Z", friday)).toBe("8 Jan 2027, 09:00");
  });

  it("a picked calendar day lands at 09:00 local on THAT day", () => {
    expect(dayNine("2026-12-25")).toBe("2026-12-25T08:00:00.000Z");
    expect(dayNine("2026-06-25")).toBe("2026-06-25T07:00:00.000Z");
  });

  /**
   * THE DST TRANSITION ITSELF, which is where hand-rolled offset arithmetic dies. Zurich springs
   * forward at 02:00 on 29 March 2026 and falls back at 03:00 on 25 October. A preset computed by
   * adding a fixed offset to a UTC midnight is wrong by an hour on one side of each of these.
   */
  it("crosses the spring-forward boundary", () => {
    /* Saturday 28 March, still CET. Tomorrow is the 29th, whose 09:00 is already CEST. */
    expect(tomorrowNine(new Date("2026-03-28T12:00:00Z"))).toBe("2026-03-29T07:00:00.000Z");
  });

  it("crosses the fall-back boundary", () => {
    /* Saturday 24 October, still CEST. Tomorrow is the 25th, whose 09:00 is already CET. */
    expect(tomorrowNine(new Date("2026-10-24T12:00:00Z"))).toBe("2026-10-25T08:00:00.000Z");
  });

  it("the date picker's floor is the reader's calendar day, not the instant's UTC one", () => {
    /* Auckland is +12/+13: 09:00 local is the PREVIOUS day in UTC, so slicing the ISO string
       would floor the picker a day early and let the reader choose a horizon in the past. */
    setActiveFormatZone("Pacific/Auckland");
    const tomorrow = tomorrowNine(new Date("2026-08-11T20:32:00Z")); // 08:32 on the 12th there
    expect(tomorrow).toBe("2026-08-12T21:00:00.000Z"); // 09:00 on the 13th, NZST (+12)
    expect(dayValue(tomorrow)).toBe("2026-08-13");
  });
});

describe("UTC is still available, and is what the seam answers when it is asked for", () => {
  it("an injected UTC reader sees exactly what the product used to show everyone", () => {
    setActiveFormatZone("UTC");
    expect(clockOf("2026-08-11T14:32:00Z")).toBe("14:32");
    expect(fullDateTime(msg("2026-08-05T14:32:00.000Z"))).toBe("Wed 5 Aug 2026, 14:32");
    expect(tomorrowNine(new Date("2026-08-11T14:32:00Z"))).toBe("2026-08-12T09:00:00.000Z");
  });

  it("an undated message still has no stamp to render", () => {
    expect(displayTime(msg(null), new Date("2026-08-11T22:10:00Z"))).toBe("");
    expect(fullDateTime(msg(null))).toBe("");
    expect(fullDateTime(msg("not-a-date"))).toBe("");
  });
});

describe("the zone is REQUIRED where the stamp is minted", () => {
  /**
   * THE COMPILE-TIME HALF, and it is the guard that matters most.
   *
   * A defaulted zone re-silences this bug for every call site that forgets — the stamp renders,
   * in UTC, and nothing anywhere says so. `messageDisplayTime` therefore takes the zone as a
   * required parameter, and `apps/webapp` typechecks its tests (see `tsconfig.json`), so this
   * `@ts-expect-error` fails the build the moment the parameter grows a default: an expected
   * error that does not occur is itself an error.
   */
  it("a call site without a zone does not compile", () => {
    // @ts-expect-error — the zone is required; a defaulted one would silently render UTC.
    expect(() => messageDisplayTime(msg("2026-08-11T23:30:00Z"), new Date())).not.toThrow();
  });
});
