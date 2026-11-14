/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { setActiveFormatZone } from "../app/shell/locale";
import {
  bookedIn, mountResurface, openResurface, resurfaceTime, zoneIs, type ResurfaceWorld,
} from "./_reader-2-resurface.js";

/**
 * ═══ THE RESURFACE STRIP SHOWS THE TIME, AND A CHOSEN TIME BECOMES THE DEFAULT ═══════════
 * Three claims, measured on the rendered strip: (1) the time control is filled in the moment the
 * strip opens — the account's stored hour, or 09:00 — so nobody has to guess what "Tomorrow"
 * means; (2) the horizons land at the shown time in the READER'S zone, asserted through
 * `Intl.DateTimeFormat` there rather than by slicing the ISO string, because the fixture zone
 * crosses DST inside the window under test; (3) a changed time is remembered, an unchanged one
 * is not, "Now" never is, and the write follows the dispatch. Red on: `hour: 9` left literal in
 * `clockOn`; the `store` call removed; the input's `value` dropped. Over the new reader's chooser
 * (`packages/app/src/reader/actions/ResurfaceMenu.tsx`), the account's hour handed to the room as a
 * shell hands it.
 */

/**
 * Europe/Zurich, and the clock is set the day BEFORE the 2026 spring change (29 March). So
 * "tomorrow at 14:30" crosses it: the wall clock the reader asked for is 14:30 CEST, which is
 * 12:30Z — an hour off what the same arithmetic would produce on either side of the boundary,
 * and exactly one hour off what an ms-based "+1 day" would mint.
 */
const ZONE = "Europe/Zurich";
const NOW = new Date("2026-03-28T10:00:00.000Z");

/** The wall clock an instant reads as WHERE THE READER IS — the only honest way to assert this. */
function wallClock(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
}

let world: ResurfaceWorld = { log: [] };
let log: string[] = [];
let undoZone: () => void = () => {};

/** The chooser's letter open in the new reader, the account's hour handed to the room. */
async function mountBar(opts: { stored?: string | null; canStore?: boolean } = {}): Promise<void> {
  cleanup();
  world = mountResurface(opts);
  log = world.log;
}

const item = (name: RegExp | string): HTMLElement => screen.getByRole("menuitem", { name });
const timeInput = (): HTMLInputElement => {
  const el = resurfaceTime();
  expect(el, "the strip drew no time control").not.toBeNull();
  return el;
};
async function openStrip(): Promise<void> {
  await act(async () => { openResurface(); });
}
async function typeTime(value: string): Promise<void> {
  await act(async () => { fireEvent.change(timeInput(), { target: { value } }); });
}
async function press(name: RegExp): Promise<void> {
  await act(async () => { fireEvent.click(item(name)); });
}

beforeEach(() => {
  undoZone = zoneIs(ZONE);
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  setActiveFormatZone(ZONE);
  log = [];
});

afterEach(() => {
  cleanup();
  setActiveFormatZone(null);
  vi.useRealTimers();
  undoZone();
});

describe("the resurface strip's time", () => {
  it("is shown before any press — the product's 09:00 when the account has chosen nothing", async () => {
    await mountBar();
    await openStrip();
    expect(timeInput().value, "the strip opened with no time in it").toBe("09:00");
  });

  it("is the account's stored time when there is one", async () => {
    await mountBar({ stored: "14:30" });
    await openStrip();
    expect(timeInput().value).toBe("14:30");
  });

  it("falls back to 09:00 for a value no writer could have stored", async () => {
    // Reachable by a hand-run UPDATE alone; the point is that the strip stays usable rather
    // than rendering an hour the horizons cannot mint.
    await mountBar({ stored: "25:00" });
    await openStrip();
    expect(timeInput().value).toBe("09:00");
  });

  it("Tomorrow lands at the shown time, in the reader's zone, across a DST boundary", async () => {
    await mountBar({ stored: "14:30" });
    await openStrip();
    await press(/^Tomorrow/);

    const dispatched = log.find((l) => l.startsWith("resurface:"));
    expect(dispatched, "no dated resurface was dispatched").toBeDefined();
    const iso = dispatched!.slice("resurface:".length);
    // 29 March 2026 is the day the zone moves to CEST, so this instant is 12:30Z — the assertion
    // is on the WALL CLOCK, which is what was chosen and what the label reads back.
    expect(wallClock(iso)).toBe("29/03/2026, 14:30");
  });

  it("Tomorrow at the default lands at 09:00 where the reader is", async () => {
    await mountBar();
    await openStrip();
    await press(/^Tomorrow/);
    const iso = bookedIn(log)!;
    expect(wallClock(iso)).toBe("29/03/2026, 09:00");
  });

  it("a time typed into the strip moves the horizon it is pressed with", async () => {
    await mountBar();
    await openStrip();
    await typeTime("07:15");
    await press(/^Next week/);
    const iso = bookedIn(log)!;
    // 30 March 2026 is the coming Monday, and it is past the change — 07:15 CEST, 05:15Z.
    expect(wallClock(iso)).toBe("30/03/2026, 07:15");
  });

  it("a CHANGED time is remembered, AFTER the resurface has been dispatched", async () => {
    await mountBar({ stored: "09:00" });
    await openStrip();
    await typeTime("14:30");
    await press(/^Tomorrow/);
    expect(log.filter((l) => l.startsWith("resurface:") || l.startsWith("remember:")))
      .toEqual([expect.stringMatching(/^resurface:/), "remember:14:30"]);
  });

  it("an UNCHANGED time is not remembered — an untouched control is not a decision", async () => {
    await mountBar({ stored: "14:30" });
    await openStrip();
    await press(/^Tomorrow/);
    expect(log.some((l) => l.startsWith("remember:")), "the strip wrote a default nobody chose")
      .toBe(false);
  });

  it("Now dispatches the state and remembers nothing — the time cannot apply to it", async () => {
    await mountBar();
    await openStrip();
    await typeTime("14:30");
    await press(/^Now$/);
    expect(log).toEqual(["resurface_now"]);
  });

  it("a door that cannot store one still chooses — the strip never withholds the time", async () => {
    await mountBar({ canStore: false });
    await openStrip();
    await typeTime("14:30");
    await press(/^Tomorrow/);
    const iso = bookedIn(log)!;
    expect(wallClock(iso), "the standalone window lost the chosen hour").toBe("29/03/2026, 14:30");
    expect(log.some((l) => l.startsWith("remember:"))).toBe(false);
  });

  it("the horizons say the time out loud — a screen reader hears what a reader sees", async () => {
    await mountBar({ stored: "14:30" });
    await openStrip();
    // Each horizon's accessible name carries the hour it books, as its visible note does.
    expect(item(/^Tomorrow\b.*14:30/), "Tomorrow's name says no hour").toBeTruthy();
    expect(item(/^Next week\b.*14:30/), "Next week's name says no hour").toBeTruthy();
    /* NARROWED, not weakened. "Pick a date" carried the asked hour and could not honour it: a day
       on either of the two nights books a different one, and this button names no day. The hour
       moved to the popover's cells, where it is composed per day — `resurface-dst` asserts them. */
    expect(item("Pick a date")).toBeTruthy();
    // "Now" carries none either: it ignores the time, and an accessible name claiming otherwise
    // would be the one place this strip could lie.
    expect(item("Now")).toBeTruthy();
    // The field's accessible name is its VISIBLE label — one string, so a screen reader and a
    // sighted reader cannot be told different words about the same control.
    const label = timeInput().closest("label");
    expect(label, "the time field has no label around it").not.toBeNull();
    expect(label!.textContent).toBe("Time");
  });

  it("a cleared field keeps the last real time rather than minting from a hidden fallback", async () => {
    await mountBar({ stored: "14:30" });
    await openStrip();
    await typeTime("");
    expect(timeInput().value, "an emptied control silently became 09:00").toBe("14:30");
  });
});
