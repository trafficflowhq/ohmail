/** @vitest-environment jsdom */
import { act, cleanup, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dayAtIn, nextWeekAtIn, resurfaceHorizonsIn, tomorrowAtIn } from "@ohmail/app-logic/reader";
import { composedLocalInput, sendLaterMornings, todayEvening } from "@ohmail/app-logic/text/format";
import { setActiveFormatZone } from "../app/shell/locale";
import {
  WALL_CLOCK_CASES, WALL_CLOCK_ZONE, askedTime,
} from "../../../test/support/wall-clock-days.js";
import { mountPanel, press, pressVerb, type PanelMount } from "./_reader-1-panel.js";
import { mountShell, press as pressReal, stubDom, unmountAll } from "./_draft-shell.js";
import { typeInto } from "./fixtures/rich-editor-driver.js";

/**
 * ═══ AN APPOINTMENT SURVIVES THE CLOCK CHANGE ════════════════════════════════════════════
 *
 * Two surfaces book a wall clock somebody chose — the reader's Resurface menu (part one) and send
 * later (part two) — and each composes through ONE function, asserted against the shared table at
 * `test/support/wall-clock-days.ts` that the phone's suite reads too.
 *
 * The invariant: the time the menu SAYS and the time it BOOKS are the same wall clock, on every
 * night of the year — including the two a chosen hour cannot simply be written onto. On the spring
 * night 02:30 does not exist (01:59:59 → 03:00:00), and in autumn it happens twice. Both are
 * reachable the moment the hour is the reader's to choose.
 *
 * Measured through the rendered menu of the new reader (its panel's Resurface, the account's hour
 * handed above the panes as the mail ground hands it), never through the arithmetic: the hour an
 * item states is read BEFORE the press, the dispatched instant is read back in the reader's zone
 * AFTER it, and the two have to agree. The reader's zone is the platform's, so the file runs where
 * the reader is: Zurich.
 *
 * "Next week" has no arm LANDING on either night, and cannot have one: no zone in the tz database
 * changes its clocks on a Monday between 2026 and 2030 (measured over every `supportedValuesOf`
 * zone). What it owes instead is that it composes the same way — the equality arm below — and that
 * its day is counted in the reader's calendar across a change, which is the late-evening arm.
 */

const ZONE = WALL_CLOCK_ZONE;
/** The night the clocks go forward: 2027-03-28, 02:00 → 03:00. The base is the evening before. */
const SPRING_EVE = new Date("2027-03-27T10:00:00.000Z");
/** The night the clocks go back: 2026-10-25, 03:00 → 02:00, so 02:30 happens twice. */
const AUTUMN_EVE = new Date("2026-10-24T10:00:00.000Z");
/** A night with nothing on it — the positive control. */
const PLAIN_EVE = new Date("2026-08-11T10:00:00.000Z");

/** The wall clock an instant reads WHERE THE READER IS — the only honest way to assert this. */
function wallClock(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
}
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Just the "HH:MM" of that reading — what a label claims. */
function wallTime(iso: string): string {
  return wallClock(iso).slice(-5);
}

/** The one hour a menu item or a day states (it states exactly one, or it promises nothing). */
function hourStated(el: Element): string | null {
  const hours = (el.textContent ?? "").match(/(?<!\d)\d\d:\d\d(?!\d)/g) ?? [];
  expect(hours.length, `"${el.textContent}" states more than one hour`).toBeLessThanOrEqual(1);
  return hours[0] ?? null;
}

let mount: PanelMount | null = null;
let mountedNow: Date = PLAIN_EVE;
let zoneBefore: string | undefined;

/** The open letter's panel, at `now`, with the account's stored hour handed to the room. */
async function mountBar(now: Date, stored: string): Promise<void> {
  cleanup();
  mountedNow = now;
  vi.setSystemTime(now);
  mount = mountPanel({}, { resurface: stored });
  await act(async () => {});
}
const log = (): string[] => mount!.actions;

const resurfaceMenu = (): HTMLElement => screen.getByRole("menu", { name: "Resurface" });
/** The one item of the open menu whose name starts `text`. */
const item = (text: string): HTMLElement => {
  const found = screen.getAllByRole("menuitem").filter((b) => (b.textContent ?? "").trim().startsWith(text));
  expect(found, `expected exactly one item starting "${text}"`).toHaveLength(1);
  return found[0]!;
};
async function openStrip(): Promise<void> {
  await pressVerb("Resurface");
}
async function openPicker(): Promise<void> {
  await openStrip();
  await press(item("Pick a date"));
}
/** The picker's day, by its date as the kit names a day (`Sun 25 Oct 2026, …`). */
const dayCell = (named: string): HTMLElement =>
  within(screen.getByRole("menu", { name: "Pick a date" })).getByRole("button", {
    name: new RegExp(`^${named},`),
  });
/** Open the menu, read the hour the horizon SAYS, press it, hand back what it BOOKED. */
async function choose(horizon: string): Promise<{ said: string | null; iso: string; panel: string }> {
  await openStrip();
  const said = hourStated(item(horizon));
  const panel = resurfaceMenu().textContent ?? "";
  const before = log().length;
  await press(item(horizon));
  const dispatched = log().slice(before).find((l) => l.startsWith("resurface:"));
  expect(dispatched, "no dated resurface was dispatched").toBeDefined();
  return { said, iso: dispatched!.slice("resurface:".length), panel };
}

beforeAll(() => {
  zoneBefore = process.env.TZ;
  process.env.TZ = ZONE;
});
afterAll(() => {
  if (zoneBefore === undefined) delete process.env.TZ;
  else process.env.TZ = zoneBefore;
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: PLAIN_EVE });
  setActiveFormatZone(ZONE);
});

afterEach(() => {
  cleanup();
  mount = null;
  setActiveFormatZone(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("after midnight, Tomorrow is the coming morning (00:28 on a Sunday)", () => {
  /** 00:28 CEST on Sunday 25 October 2026, the autumn night; 09:00 that morning is CET. */
  const AUTUMN_SMALL_HOURS = new Date("2026-10-24T22:28:00.000Z");
  /** 00:28 CET on Sunday 28 March 2027, the spring night; 09:00 that morning is CEST. */
  const SPRING_SMALL_HOURS = new Date("2027-03-27T23:28:00.000Z");

  it("books this morning's 09:00 across the autumn change, not Monday's", async () => {
    await mountBar(AUTUMN_SMALL_HOURS, "09:00");
    const { said, iso } = await choose("Tomorrow");
    expect(iso).toBe("2026-10-25T08:00:00.000Z");
    expect(said).toBe("09:00");
  });

  it("…and across the spring change", async () => {
    await mountBar(SPRING_SMALL_HOURS, "09:00");
    const { iso } = await choose("Tomorrow");
    expect(iso).toBe("2027-03-28T07:00:00.000Z");
  });

  it("the picker lets today be chosen while today's hour is still ahead", async () => {
    await mountBar(AUTUMN_SMALL_HOURS, "09:00");
    await openPicker();
    const today = dayCell("Sun 25 Oct 2026");
    expect(today.hasAttribute("disabled"), "today is blocked at 00:28").toBe(false);
    await press(today);
    expect(log()).toContain("resurface:2026-10-25T08:00:00.000Z");
  });

  it("in the day, a later hour unlocks today and a passed one keeps it closed", async () => {
    for (const [stored, open] of [["18:00", true], ["09:00", false]] as const) {
      await mountBar(PLAIN_EVE, stored);
      await openPicker();
      const today = dayCell("Tue 11 Aug 2026");
      expect(!today.hasAttribute("disabled"), `today at ${stored}`).toBe(open);
    }
  });

  it("on a Sunday in the day, Tomorrow and Next week are one Monday, offered once", async () => {
    await mountBar(new Date("2026-10-25T10:00:00.000Z"), "09:00");
    await openStrip();
    const labels = within(resurfaceMenu()).getAllByRole("menuitem").map((b) => (b.textContent ?? "").trim());
    expect(labels.filter((l) => l.startsWith("Next week"))).toEqual([]);
    await press(item("Tomorrow"));
    expect(log()).toContain("resurface:2026-10-26T08:00:00.000Z");
    expect(resurfaceHorizonsIn(new Date("2026-10-25T04:01:00.000Z"), "09:00", ZONE).nextWeek).toBeNull();
    expect(resurfaceHorizonsIn(new Date("2026-10-25T21:30:00.000Z"), "09:00", ZONE).nextWeek).toBeNull();
  });

  it("at 00:28 on that Sunday both are offered: this morning and Monday", async () => {
    await mountBar(AUTUMN_SMALL_HOURS, "09:00");
    expect((await choose("Next week")).iso).toBe("2026-10-26T08:00:00.000Z");
    expect((await choose("Tomorrow")).iso).toBe("2026-10-25T08:00:00.000Z");
  });

  it("send later offers this morning, and never the same instant twice", () => {
    expect(sendLaterMornings(AUTUMN_SMALL_HOURS)).toEqual({
      tomorrow: "2026-10-25T08:00:00.000Z", monday: "2026-10-26T08:00:00.000Z",
    });
    // Sunday daytime: tomorrow morning IS Monday morning, so Monday is not offered again.
    expect(sendLaterMornings(new Date("2026-10-25T10:00:00.000Z"))).toEqual({
      tomorrow: "2026-10-26T08:00:00.000Z", monday: null,
    });
  });
});

describe("a resurface across a clock change", () => {
  it("books the hour the strip is showing on an ordinary night", async () => {
    await mountBar(PLAIN_EVE, "14:30");
    const { said, iso } = await choose("Tomorrow");
    expect(wallClock(iso)).toBe("12/08/2026, 14:30");
    expect(said).toBe(wallTime(iso));
  });

  it("says the hour it books when the clocks skip the one that was chosen", async () => {
    // 02:30 does not exist on 28 March 2027 in Zurich. The booking is the first instant after
    // the missing hour — 03:30 — and the menu has to say 03:30 BEFORE the press, not 02:30.
    await mountBar(SPRING_EVE, "02:30");
    const { said, iso } = await choose("Tomorrow");
    expect(wallClock(iso)).toBe("28/03/2027, 03:30");
    expect(said, "the menu promised an hour it did not book").toBe(wallTime(iso));
  });

  it("takes the FIRST of the two when the chosen hour comes round twice", async () => {
    // 02:30 happens at 00:30Z (CEST) and again at 01:30Z (CET) on 25 October 2026. The earlier
    // one is the booking: a resurface comes back when the reader's clock first reads its time.
    await mountBar(AUTUMN_EVE, "02:30");
    const { said, iso } = await choose("Tomorrow");
    expect(iso).toBe("2026-10-25T00:30:00.000Z");
    expect(wallClock(iso)).toBe("25/10/2026, 02:30");
    expect(said).toBe(wallTime(iso));
  });

  it("counts the day in the reader's calendar, not in milliseconds", async () => {
    /* 23:30 CET on the 27th: adding a day in MILLISECONDS from here lands at 00:30 CEST on the
       29th — one calendar day too far, because the day the reader crosses into is an hour short.
       The arm exists because the earlier fixtures all sit at midday, where that error hides. */
    const lateEve = new Date("2027-03-27T22:30:00.000Z");
    await mountBar(lateEve, "02:30");
    const { said, iso } = await choose("Tomorrow");
    expect(wallClock(iso)).toBe("28/03/2027, 03:30");
    expect(said).toBe(wallTime(iso));
  });

  it("counts NEXT WEEK's day in the calendar too — both horizons, one arithmetic", async () => {
    /* The same late evening, two days before the coming Monday: in milliseconds that Monday is
       the 30th. A fix applied to one horizon and not the other is half-applied by construction. */
    await mountBar(new Date("2027-03-27T22:30:00.000Z"), "02:30");
    const { said, iso } = await choose("Next week");
    expect(wallClock(iso)).toBe("29/03/2027, 02:30");
    expect(said).toBe(wallTime(iso));
  });

  it("says on screen which time it will book, before anything is pressed", async () => {
    await mountBar(SPRING_EVE, "02:30");
    await openStrip();
    const panel = resurfaceMenu().textContent ?? "";
    expect(hourStated(item("Tomorrow"))).toBe("03:30");
    expect(panel).not.toContain("the clocks skip");
  });

  it("says nothing extra on the nights that book the hour that was asked for", async () => {
    // The repeated hour books 02:30 — what was chosen — so a sentence about it would be noise,
    // and an ordinary night has nothing to say at all. Both arms, because one of them alone is a
    // guard that cannot tell "never renders" from "renders correctly".
    for (const eve of [AUTUMN_EVE, PLAIN_EVE]) {
      await mountBar(eve, "02:30");
      await openStrip();
      const panel = resurfaceMenu().textContent ?? "";
      expect(panel, `a sentence appeared for ${eve.toISOString()}`).not.toContain("the clocks skip");
    }
  });

  it("composes a PICKED date through the same function — the rule is not the horizon's", () => {
    // The day picker's own path (`dayAtIn(day, at, zone)` at the press), the two items' paths, and
    // the product's 09:00 default: one composition, four callers, one answer per night.
    expect(dayAtIn("2027-03-28", "02:30", ZONE)).toEqual({
      iso: "2027-03-28T01:30:00.000Z", time: "03:30", verdict: "shifted_forward",
    });
    expect(dayAtIn("2026-10-25", "02:30", ZONE)).toEqual({
      iso: "2026-10-25T00:30:00.000Z", time: "02:30", verdict: "first_of_two",
    });
    // ONE composition, not three that agree today: each horizon is its own day handed to the
    // same function, so a horizon and the picked day it names are the SAME value, verdict and all.
    expect(tomorrowAtIn(SPRING_EVE, "02:30", ZONE)).toEqual(dayAtIn("2027-03-28", "02:30", ZONE));
    expect(nextWeekAtIn(SPRING_EVE, "02:30", ZONE)).toEqual(dayAtIn("2027-03-29", "02:30", ZONE));
    expect(nextWeekAtIn(SPRING_EVE, "02:30", ZONE).verdict).toBe("exact");
    expect(dayAtIn("2027-03-28", null, ZONE)).toEqual({
      iso: "2027-03-28T07:00:00.000Z", time: "09:00", verdict: "exact",
    });
  });

  it("the picker's days each state the hour they would book", async () => {
    /* THE DAY PICKER, NOT THE HORIZON ITEMS. Before this the popover's cells named a date and
       nothing else, so the only hour on screen was the one in the field — 02:30, which no day on
       the 28th can book. Each cell carries the composition for its OWN day: the 28th says 03:30,
       the 29th says 02:30, and the two are the same asked hour. (The day as the kit names one.) */
    await mountBar(SPRING_EVE, "02:30");
    await openPicker();
    const cell = (named: string): string => dayCell(named).getAttribute("aria-label") ?? "";
    expect(cell("Sun 28 Mar 2027"), "the skipped morning named no hour").toBe("Sun 28 Mar 2027, 03:30");
    expect(cell("Mon 29 Mar 2027")).toBe("Mon 29 Mar 2027, 02:30");
    // The hour is the CELL's, not the field's: a day that books 03:30 may not say 02:30.
    expect(cell("Sun 28 Mar 2027")).not.toContain("02:30");
  });

  it("the picker's trigger promises no hour, because it names no day", async () => {
    await mountBar(SPRING_EVE, "02:30");
    await openStrip();
    /* It read "Pick a date, 02:30" and there was no day it could have booked that at. The two
       items beside it still carry their hour — they name a day, so the hour is a fact. */
    expect(item("Pick a date").textContent).not.toContain("02:30");
    expect(hourStated(item("Pick a date"))).toBeNull();
    expect(hourStated(item("Tomorrow"))).toBe("03:30");
  });

  it("holds for Next week too — the horizon is not the rule", async () => {
    // The coming Monday is 29 March 2027, the day AFTER the change: the same chosen 02:30 is an
    // ordinary time there, and the booking is exactly it. The arm that proves the rule travels.
    await mountBar(SPRING_EVE, "02:30");
    const { said, iso } = await choose("Next week");
    expect(wallClock(iso)).toBe("29/03/2027, 02:30");
    expect(said).toBe(wallTime(iso));
    expect(mountedNow.toISOString()).toBe("2027-03-27T10:00:00.000Z");
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   PART TWO — SEND LATER, the other surface that books a wall clock somebody chose.

   Its three presets sit on hours no transition crosses (08, 09, 12, 15, 18, 21 local; every
   transition in the tz database lands between 22:00 and 04:00), so the preset half is proved
   at the FUNCTION — the hour is its parameter, not the list. The field beside them takes any
   hour at all, which makes it the one appointment in the product that reaches the two nights
   today, and it was answering with `zonedInstant`: the LAST of two on the autumn night, an
   hour after the reader's clock first reads what they typed. (Write's later port composes with
   these, `@ohmail/app-logic/writing/writing-of.ts`.)
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe("send later composes the wall clock the same way", () => {
  it("answers the shared table on every case — the same table the phone's suite reads", () => {
    for (const c of WALL_CLOCK_CASES) {
      const typed = `${c.day}T${askedTime(c)}`;
      const custom = composedLocalInput(typed);
      expect(custom, `${c.name}: the field read nothing from ${typed}`).not.toBeNull();
      expect(custom!.instant.toISOString(), c.name).toBe(c.iso);
      expect(`${pad2(custom!.hour)}:${pad2(custom!.minute)}`, c.name).toBe(c.time);
      expect(custom!.verdict, c.name).toBe(c.verdict);
      /* ONE COMPOSITION, TWO DOORS: the resurface day and the typed clock are the same
         function on the same fields, so they cannot answer one night differently. */
      expect(dayAtIn(c.day, askedTime(c), ZONE), c.name).toEqual({
        iso: c.iso, time: c.time, verdict: c.verdict,
      });
    }
  });

  it("takes the FIRST of two when the typed hour comes round twice", () => {
    // It answered 01:30Z — 02:30 CET, the second one. A chosen clock comes round when the
    // reader's clock FIRST reads it; the raw door's last-of-two rule is for closing windows.
    const at = composedLocalInput("2026-10-25T02:30")!;
    expect(at.instant.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(wallClock(at.instant.toISOString())).toBe("25/10/2026, 02:30");
    expect(at.verdict).toBe("first_of_two");
  });

  it("once the first of the two has passed, the repeated hour is the second", () => {
    // 02:55 CET, the second 02:55 of the night: 02:58 is three minutes ahead, not an hour behind.
    const at = composedLocalInput("2026-10-25T02:58", new Date("2026-10-25T01:55:00.000Z"))!;
    expect(at.instant.toISOString()).toBe("2026-10-25T01:58:00.000Z");
    expect(composedLocalInput("2026-10-25T02:58", new Date("2026-10-24T23:00:00.000Z"))!.instant.toISOString())
      .toBe("2026-10-25T00:58:00.000Z");
  });

  it("the evening preset is a composition too, verdict and all", () => {
    const evening = todayEvening(SPRING_EVE);
    expect(evening.instant.toISOString()).toBe("2027-03-27T17:00:00.000Z");
    expect(evening.verdict).toBe("exact");
    expect(evening.hour).toBe(18);
  });
});

describe("the send-later field says which hour it will send at", () => {
  /* REAL TIMERS AND THE REAL CLOCK HERE. The composer's body is ProseMirror, which mounts on a
     timer a fake clock never advances, and this describe does not need a pinned "now": the
     sentence is about the clock somebody TYPED, and 2027 is ahead of any day this runs on.
     The whole new shell, through its test door (`_draft-shell.ts`'s `mountShell`: the web's
     `MailShell`, the frame over the mail ground), parked on Write (`#/compose`), the letter made
     sendable and Send later's card open: its day and its time are two fields of the kit, and what
     the card says about the typed clock is the time field's line. */
  beforeEach(() => {
    vi.useRealTimers();
    stubDom();
  });
  afterEach(async () => {
    await unmountAll();
  });

  const drain = async (n = 8): Promise<void> => {
    for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  /** Poll until `ready()`, draining React between attempts; bounded by real time, never a tick count. */
  async function waitFor(ready: () => boolean, why: string, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!ready()) {
      if (Date.now() > deadline) throw new Error(why);
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    }
  }
  const nativeValue = async (el: HTMLInputElement, value: string): Promise<void> => {
    /* The setter off the ELEMENT's own prototype: the global one refuses this instance under
       jsdom here ("not a valid instance of HTMLInputElement"). */
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!;
    await act(async () => {
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const card = (): HTMLElement => screen.getByRole("dialog", { name: "Send later" });
  const field = (name: string): HTMLInputElement => within(card()).getByLabelText(name) as HTMLInputElement;

  /** The shipped client, parked on Write with a SENDABLE message and the card open — send later
   *  wears the same lock as Send, so nothing less opens it. */
  async function openSendLater(): Promise<void> {
    await mountShell("#/compose", []);
    await waitFor(() => document.querySelector('input[aria-label="To"]') !== null, "Write never drew its To field");
    await nativeValue(document.querySelector<HTMLInputElement>('input[aria-label="To"]')!, "ada@fake.test");
    const surface = (): HTMLElement | null =>
      document.querySelector<HTMLElement>('[contenteditable=true][aria-label="Message"]');
    await waitFor(
      () => !!(surface() as unknown as { editor?: unknown } | null)?.editor,
      "the compose editor never mounted a ProseMirror handle",
    );
    await act(async () => { typeInto(surface()!, "Tomorrow works."); });
    await drain(4);
    const later = (): HTMLButtonElement => screen.getByRole("button", { name: "Send later" }) as HTMLButtonElement;
    await waitFor(() => !later().disabled, "Send later stayed locked on a sendable letter");
    await pressReal(later(), "Send later");
    await pressReal(within(card()).getByRole("menuitem", { name: /^Pick a date and time/ }), "Pick a date and time");
  }

  /** Type a wall clock into the card's day and time, and hand back everything the card is saying. */
  async function typeWhen(value: string): Promise<string> {
    const [day, time] = value.split("T");
    await nativeValue(field("Date"), day!);
    await nativeValue(field("Time"), time!);
    return card().textContent ?? "";
  }

  it("names the hour it will book when the typed one is skipped", async () => {
    await openSendLater();
    expect(await typeWhen("2027-03-28T02:30"))
      .toContain("That will send at 03:30 — the clocks skip 02:30 that night.");
  });

  it("at 02:55 in the repeated hour, 02:58 is a time ahead, not one that has passed", async () => {
    // Only Date is faked: the editor mounts on timers a fake clock would never advance.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-25T01:55:00.000Z") });
    await openSendLater();
    /* The earliest time the card offers (today's field's `min`, the card's seeded day and time). */
    expect(`${field("Date").value}T${field("Time").value}`).toBe("2026-10-25T02:58");
    expect(await typeWhen("2026-10-25T02:58")).not.toContain("That time has passed");
    const confirm = within(card()).getByRole("button", { name: "Schedule send" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
  });

  it("says nothing on the repeated hour or an ordinary one", async () => {
    // Both arms, because one alone cannot tell "never renders" from "renders correctly": the
    // autumn night books the time that was asked for, and an ordinary night has nothing to say.
    await openSendLater();
    for (const typed of ["2026-10-25T02:30", "2027-03-29T02:30"]) {
      expect(await typeWhen(typed), `a sentence appeared for ${typed}`).not.toContain("clocks skip");
    }
  });
});
