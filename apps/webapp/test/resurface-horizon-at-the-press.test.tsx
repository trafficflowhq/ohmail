/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { setActiveFormatZone } from "../app/shell/locale";
import { useDayClock } from "@ohmail/app-logic/session/day-clock";
import { bookedIn, mountResurface, openResurface, zoneIs, type ResurfaceWorld } from "./_reader-2-resurface.js";

/**
 * ═══ "TOMORROW" IS TOMORROW AT THE PRESS, NEVER AT THE MOUNT ════════════════════════════════
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────
 *
 * The shell captured `now` once, at mount (`useMemo(() => new Date(), [demo])`), and handed it
 * to the resurface chooser. An app left open overnight therefore booked "Tomorrow" from
 * YESTERDAY: the instant was in the past the moment it was written, and the message resurfaced
 * at once instead of the next morning. Every relative label under that open app was a day out
 * with it.
 *
 * ── WHAT IS PINNED HERE ─────────────────────────────────────────────────────────────────────
 *
 *  1. The strip mounted at 23:59 and pressed at 00:01 books the NEW tomorrow — read off the
 *     dispatched instant in the reader's own zone, never off the ISO string's digits.
 *  2. "Next week" moves with it.
 *  3. A press inside the same day is unchanged — the positive control.
 *  4. `useDayClock` re-reads only when the calendar day turns: a same-day tick leaves the value
 *     alone (so the shell does not re-render every minute), a midnight tick moves it, and a
 *     fixed instant (the fixture world) never moves and arms no timer at all.
 *
 * ── HOW TO WATCH IT FAIL ────────────────────────────────────────────────────────────────────
 *
 *  · In the reader's chooser (`packages/app/src/reader/actions/ResurfaceMenu.tsx`), mint the horizon at
 *    RENDER again — `dated(() => resurfaceHorizonsIn(new Date(), at, zone).tomorrow)` → `dated(() => tomorrow)`
 *    — and cases 1 and 2 go red on the booked day. (Cases 1 to 4 run over the new reader's chooser.)
 *  · In `day-clock.ts`, make the watch always re-read (drop the day comparison) and case 4's
 *    same-day arm goes red; make it never re-read and the midnight arm goes red.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A zone whose midnight is not UTC's, so "the day turned" is a question about the reader. */
const ZONE = "Europe/Zurich";
/** 23:59 local on 12 September 2026 (CEST, UTC+2). */
const LATE = new Date("2026-09-12T21:59:00.000Z");
/** 00:01 local on 13 September — the same open app, two minutes later. */
const PAST_MIDNIGHT = new Date("2026-09-12T22:01:00.000Z");
/** 05:01 local on the 13th — the strip left open through the night ("Tomorrow" is the 14th). */
const NEXT_MORNING = new Date("2026-09-13T03:01:00.000Z");
/** 22:00 local on the 12th: a minute's tick from here cannot cross midnight. */
const EVENING = new Date("2026-09-12T20:00:00.000Z");
/**
 * 04:59 local on SUNDAY 13 September, and 00:01 on the Monday. "Next week" is the discriminating
 * pair: from the Sunday the coming Monday is the 14th, from the Monday it is the 21st — a control
 * chosen from a subject that HAS the property under test, which the Saturday pair does not (both
 * sides of that midnight answer the 14th). In the small hours, because from 05:00 on a Sunday
 * "Next week" is Tomorrow's Monday and is not offered.
 */
const SUNDAY_SMALL_HOURS = new Date("2026-09-13T02:59:00.000Z");
const MONDAY_EARLY = new Date("2026-09-13T22:01:00.000Z");

/** The calendar day an instant reads as WHERE THE READER IS. */
function readerDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(iso));
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

/**
 * The new reader's chooser, its letter open, the clock under the test's control: the platform's `Date` is faked
 * (nothing else), so a press reads the instant the case sets, and the reader reads its zone off the platform.
 */
let world: ResurfaceWorld = { log: [] };
let undoZone: () => void = () => {};
async function mountBar(): Promise<void> {
  world = mountResurface();
}

async function openStrip(): Promise<void> {
  await act(async () => { openResurface(); });
}

async function press(name: RegExp): Promise<void> {
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name })); });
}

/** The instant the strip dispatched, off the one `resurface:` action it raised. */
function booked(): string {
  const line = bookedIn(world.log);
  expect(line, "the strip dispatched no dated resurface").toBeTruthy();
  return line!;
}

/** The clock the reader reads at the press. */
function clockIs(at: Date): void {
  vi.setSystemTime(at);
}

beforeEach(() => {
  setActiveFormatZone(ZONE);
  world = { log: [] };
});

afterEach(async () => {
  await unmount();
  setActiveFormatZone(null);
  vi.useRealTimers();
});

describe("the horizon is minted from the clock at the press", () => {
  beforeEach(() => {
    undoZone = zoneIs(ZONE);
    vi.useFakeTimers({ toFake: ["Date"] });
    clockIs(LATE);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    undoZone();
  });

  it("mounted at 23:59 and pressed at 05:01, Tomorrow is the NEW tomorrow", async () => {
    await mountBar();
    await openStrip();
    // The day turns while the strip stands open — nothing re-mounts, nothing re-renders. Past
    // the small hours, because until 05:00 "Tomorrow" is the coming morning, the 13th.
    clockIs(NEXT_MORNING);
    await press(/^Tomorrow/);
    expect(readerDay(booked()), "the booking came from the day the app was opened on")
      .toBe("2026-09-14");
  });

  it("Next week moves with it", async () => {
    clockIs(SUNDAY_SMALL_HOURS);
    await mountBar();
    await openStrip();
    clockIs(MONDAY_EARLY);
    await press(/^Next week/);
    // Pressed on the Monday, "next week" is the Monday after — never the one this press is on.
    expect(readerDay(booked()), "the horizon came from the Sunday the strip opened on")
      .toBe("2026-09-21");
  });

  it("…and from the Sunday it would have been the 14th (the pair's other side)", async () => {
    clockIs(SUNDAY_SMALL_HOURS);
    await mountBar();
    await openStrip();
    await press(/^Next week/);
    expect(readerDay(booked())).toBe("2026-09-14");
  });

  it("a press inside the same day is unchanged (the positive control)", async () => {
    await mountBar();
    await openStrip();
    await press(/^Tomorrow/);
    expect(readerDay(booked())).toBe("2026-09-13");
  });
});

describe("useDayClock re-reads at the day boundary and not on the minute", () => {
  function Probe({ fixed }: { fixed: Date | null }): React.ReactElement {
    const now = useDayClock(fixed, ZONE);
    return h("i", { "data-now": now.toISOString() }) as React.ReactElement;
  }

  const shown = (): string => host!.querySelector("i")!.getAttribute("data-now")!;

  async function mountProbe(fixed: Date | null): Promise<void> {
    await unmount();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(h(Probe, { fixed })); });
  }

  it("a tick inside the same day leaves the value alone", async () => {
    // 22:00 local: advancing the timers advances the clock with them, and a minute from here
    // cannot cross midnight — so the watch fires and must decide to do nothing.
    vi.useFakeTimers({ now: EVENING });
    await mountProbe(null);
    const before = shown();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(shown(), "the shell re-rendered for a minute that changed nothing").toBe(before);
  });

  it("a tick past midnight moves it", async () => {
    vi.useFakeTimers({ now: LATE });
    await mountProbe(null);
    const before = shown();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(shown(), "the day turned and the shell kept yesterday").not.toBe(before);
    expect(readerDay(shown())).toBe("2026-09-13");
  });

  it("reads the day in the zone it is told, whatever zone the shell's own stamps are in", async () => {
    // 23:59 in Zurich is 09:59 the next morning in Auckland: two minutes on, the day has turned in Zurich alone.
    setActiveFormatZone("Pacific/Auckland");
    vi.useFakeTimers({ now: LATE });
    await mountProbe(null);
    const before = shown();
    await act(async () => { vi.advanceTimersByTime(120_000); });
    expect(shown(), "the clock read the day in the shell's zone, not in the one it was told").not.toBe(before);
    expect(readerDay(shown())).toBe("2026-09-13");
  });

  it("a fixed instant never moves and arms no timer (the fixture world)", async () => {
    vi.useFakeTimers({ now: LATE });
    await mountProbe(LATE);
    expect(vi.getTimerCount(), "the demo armed a clock watch").toBe(0);
    vi.setSystemTime(PAST_MIDNIGHT);
    await act(async () => { vi.advanceTimersByTime(120_000); });
    expect(shown()).toBe(LATE.toISOString());
  });
});
