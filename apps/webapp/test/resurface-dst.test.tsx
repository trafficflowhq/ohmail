/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { setActiveFormatZone } from "../app/shell/locale";
import {
  WALL_CLOCK_CASES, WALL_CLOCK_ZONE, askedTime,
} from "../../../test/support/wall-clock-days.js";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * ═══ AN APPOINTMENT SURVIVES THE CLOCK CHANGE ════════════════════════════════════════════
 *
 * Two surfaces book a wall clock somebody chose — the resurface strip (part one) and send
 * later (part two) — and there is ONE composition under both, asserted against the shared
 * table at `test/support/wall-clock-days.ts` that the phone's suite reads too.
 *
 * The invariant: the time the strip SAYS and the time it BOOKS are the same wall clock, on
 * every night of the year — including the two a chosen hour cannot simply be written onto.
 * On the spring night 02:30 does not exist (01:59:59 → 03:00:00), and in autumn it happens
 * twice. Both are reachable the moment the hour is the reader's to choose.
 *
 * Measured through the rendered strip, never through the arithmetic: the label is read BEFORE
 * the press, the dispatched instant is read back in the reader's zone AFTER it, and the two
 * have to agree. Red before the fix on the spring arm (label 02:30, booked 03:30) and on the
 * autumn arm (the second occurrence, an hour later than the first).
 *
 * "Next week" has no arm LANDING on either night, and cannot have one: no zone in the tz database
 * changes its clocks on a Monday between 2026 and 2030 (measured over every `supportedValuesOf`
 * zone). What it owes instead is that it composes the same way — the equality arm below — and that
 * its day is counted in the reader's calendar across a change, which is the late-evening arm.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const MESSAGE: Record<string, unknown> = {
  id: "m1", accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
  subject: "subj", from: { name: "Andi", address: "andi@ex.example" }, to: [], cc: [],
  date: "2026-03-28T09:00:00.000Z", folder: "INBOX", snippet: "snip",
  unread: false, hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: "2026-03-28T09:00:00.000Z",
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let log: string[] = [];
let mountedNow: Date = PLAIN_EVE;

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

/** The bar alone, through the chrome — the seam the shell supplies the stored time on. */
async function mountBar(now: Date, stored: string): Promise<void> {
  await unmount();
  mountedNow = now;
  vi.setSystemTime(now);
  const { MessageActionBar } = await import("../app/shell/MessagePane.js");
  const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const chrome: Record<string, unknown> = {
    ownAddresses: [],
    replyTo: null,
    replyBody: { text: "", html: "" },
    onReplyBody: () => {},
    closeReply: () => {},
    sendReply: () => {},
    replySendState: () => ({ phase: "idle" }),
    openSenderMenu: () => {},
    conversationOf: () => [],
    bodyOf: (m: Record<string, unknown>) => ({
      text: m.snippet as string, state: "snippet", html: null,
      loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
    }),
    hydrateBody: () => {},
    hydrateThread: () => {},
    resurfaceTime: stored,
    onResurfaceTime: (hhmm: string) => log.push(`remember:${hhmm}`),
  };
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: ZONE, now,
        children: h(MessageChromeProvider as never, {
          value: chrome,
          children: h(MessageActionBar as never, {
            message: MESSAGE, now, onAction: (a: string) => log.push(a),
          } as never),
        } as never),
      }),
    );
  });
}

const byText = (text: string): HTMLElement => {
  const found = [...host!.querySelectorAll("button")]
    .filter((b) => (b.textContent ?? "").trim().startsWith(text));
  expect(found, `expected exactly one button starting "${text}"`).toHaveLength(1);
  return found[0] as HTMLElement;
};
async function openStrip(): Promise<void> {
  await act(async () => { byText("Resurface").click(); });
}
/** Open the strip, read what the horizon SAYS, press it, hand back what it BOOKED. */
async function choose(horizon: string): Promise<{ said: string; iso: string; panel: string }> {
  await openStrip();
  const said = byText(horizon).getAttribute("aria-label") ?? "";
  const panel = host!.querySelector(".abar-panel")?.textContent ?? "";
  await act(async () => { byText(horizon).click(); });
  const dispatched = log.find((l) => l.startsWith("resurface:"));
  expect(dispatched, "no dated resurface was dispatched").toBeDefined();
  return { said, iso: dispatched!.slice("resurface:".length), panel };
}

beforeEach(() => {
  vi.useFakeTimers({ now: PLAIN_EVE });
  setActiveFormatZone(ZONE);
  log = [];
});

afterEach(async () => {
  await unmount();
  setActiveFormatZone(null);
  vi.useRealTimers();
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
    expect(said).toBe("Tomorrow, 09:00");
  });

  it("…and across the spring change", async () => {
    await mountBar(SPRING_SMALL_HOURS, "09:00");
    const { iso } = await choose("Tomorrow");
    expect(iso).toBe("2027-03-28T07:00:00.000Z");
  });

  it("the picker lets today be chosen while today's hour is still ahead", async () => {
    await mountBar(AUTUMN_SMALL_HOURS, "09:00");
    await openStrip();
    await act(async () => { byText("Pick a date").click(); });
    const today = host!.querySelector('[data-day="2026-10-25"]');
    expect(today?.getAttribute("aria-disabled"), "today is blocked at 00:28").toBeNull();
    await act(async () => { (today as HTMLElement).click(); });
    expect(log).toContain("resurface:2026-10-25T08:00:00.000Z");
  });

  it("in the day, a later hour unlocks today and a passed one keeps it closed", async () => {
    for (const [stored, open] of [["18:00", true], ["09:00", false]] as const) {
      await mountBar(PLAIN_EVE, stored);
      await openStrip();
      await act(async () => { byText("Pick a date").click(); });
      const today = host!.querySelector('[data-day="2026-08-11"]');
      expect(today?.getAttribute("aria-disabled") == null, `today at ${stored}`).toBe(open);
    }
  });

  it("on a Sunday in the day, Tomorrow and Next week are one Monday, offered once", async () => {
    await mountBar(new Date("2026-10-25T10:00:00.000Z"), "09:00");
    await openStrip();
    const labels = [...host!.querySelectorAll(".abar-panel button")].map((b) => (b.textContent ?? "").trim());
    expect(labels.filter((l) => l.startsWith("Next week"))).toEqual([]);
    await act(async () => { byText("Tomorrow").click(); });
    expect(log).toContain("resurface:2026-10-26T08:00:00.000Z");
    const { resurfaceHorizons } = await import("../app/shell/format.js");
    expect(resurfaceHorizons(new Date("2026-10-25T04:01:00.000Z"), "09:00").nextWeek).toBeNull();
    expect(resurfaceHorizons(new Date("2026-10-25T21:30:00.000Z"), "09:00").nextWeek).toBeNull();
  });

  it("at 00:28 on that Sunday both are offered: this morning and Monday", async () => {
    await mountBar(AUTUMN_SMALL_HOURS, "09:00");
    expect((await choose("Next week")).iso).toBe("2026-10-26T08:00:00.000Z");
    log = [];
    expect((await choose("Tomorrow")).iso).toBe("2026-10-25T08:00:00.000Z");
  });

  it("send later offers this morning, and never the same instant twice", async () => {
    const { sendLaterMornings } = await import("../app/shell/format.js");
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
    expect(said).toBe(`Tomorrow, ${wallTime(iso)}`);
  });

  it("says the hour it books when the clocks skip the one that was chosen", async () => {
    // 02:30 does not exist on 28 March 2027 in Zurich. The booking is the first instant after
    // the missing hour — 03:30 — and the strip has to say 03:30 BEFORE the press, not 02:30.
    await mountBar(SPRING_EVE, "02:30");
    const { said, iso } = await choose("Tomorrow");
    expect(wallClock(iso)).toBe("28/03/2027, 03:30");
    expect(said, "the strip promised an hour it did not book").toBe(`Tomorrow, ${wallTime(iso)}`);
  });

  it("takes the FIRST of the two when the chosen hour comes round twice", async () => {
    // 02:30 happens at 00:30Z (CEST) and again at 01:30Z (CET) on 25 October 2026. The earlier
    // one is the booking: a resurface comes back when the reader's clock first reads its time.
    await mountBar(AUTUMN_EVE, "02:30");
    const { said, iso } = await choose("Tomorrow");
    expect(iso).toBe("2026-10-25T00:30:00.000Z");
    expect(wallClock(iso)).toBe("25/10/2026, 02:30");
    expect(said).toBe(`Tomorrow, ${wallTime(iso)}`);
  });

  it("counts the day in the reader's calendar, not in milliseconds", async () => {
    /* 23:30 CET on the 27th: adding a day in MILLISECONDS from here lands at 00:30 CEST on the
       29th — one calendar day too far, because the day the reader crosses into is an hour short.
       The arm exists because the earlier fixtures all sit at midday, where that error hides. */
    const lateEve = new Date("2027-03-27T22:30:00.000Z");
    await mountBar(lateEve, "02:30");
    const { said, iso } = await choose("Tomorrow");
    expect(wallClock(iso)).toBe("28/03/2027, 03:30");
    expect(said).toBe(`Tomorrow, ${wallTime(iso)}`);
  });

  it("counts NEXT WEEK's day in the calendar too — both horizons, one arithmetic", async () => {
    /* The same late evening, two days before the coming Monday: in milliseconds that Monday is
       the 30th. A fix applied to one horizon and not the other is half-applied by construction. */
    await mountBar(new Date("2027-03-27T22:30:00.000Z"), "02:30");
    const { said, iso } = await choose("Next week");
    expect(wallClock(iso)).toBe("29/03/2027, 02:30");
    expect(said).toBe(`Next week, ${wallTime(iso)}`);
  });

  it("says on screen which time it will book, before anything is pressed", async () => {
    await mountBar(SPRING_EVE, "02:30");
    await openStrip();
    const panel = host!.querySelector(".abar-panel")?.textContent ?? "";
    expect(panel, "the strip resolved the hour silently")
      .toContain("Tomorrow lands at 03:30 — the clocks skip 02:30 that night.");
  });

  it("says nothing extra on the nights that book the hour that was asked for", async () => {
    // The repeated hour books 02:30 — what was chosen — so a sentence about it would be noise,
    // and an ordinary night has nothing to say at all. Both arms, because one of them alone is a
    // guard that cannot tell "never renders" from "renders correctly".
    for (const eve of [AUTUMN_EVE, PLAIN_EVE]) {
      await mountBar(eve, "02:30");
      await openStrip();
      const panel = host!.querySelector(".abar-panel")?.textContent ?? "";
      expect(panel, `a sentence appeared for ${eve.toISOString()}`).not.toContain("the clocks skip");
    }
  });

  it("composes a PICKED date through the same function — the rule is not the horizon's", async () => {
    const { dayAt, nextWeekAt, tomorrowAt } = await import("../app/shell/format.js");
    // The date picker's own path (`pick(dayAt(day, resurfaceAt))`), the two buttons' paths, and
    // the account's 09:00 default: one composition, four callers, one answer per night.
    expect(dayAt("2027-03-28", "02:30")).toEqual({
      iso: "2027-03-28T01:30:00.000Z", time: "03:30", verdict: "shifted_forward",
    });
    expect(dayAt("2026-10-25", "02:30")).toEqual({
      iso: "2026-10-25T00:30:00.000Z", time: "02:30", verdict: "first_of_two",
    });
    // ONE composition, not three that agree today: each horizon is its own day handed to the
    // same function, so a horizon and the picked day it names are the SAME value, verdict and all.
    expect(tomorrowAt(SPRING_EVE, "02:30")).toEqual(dayAt("2027-03-28", "02:30"));
    expect(nextWeekAt(SPRING_EVE, "02:30")).toEqual(dayAt("2027-03-29", "02:30"));
    expect(nextWeekAt(SPRING_EVE, "02:30").verdict).toBe("exact");
    expect(dayAt("2027-03-28", null)).toEqual({
      iso: "2027-03-28T07:00:00.000Z", time: "09:00", verdict: "exact",
    });
  });

  it("the picker's days each state the hour they would book", async () => {
    /* THE DAY PICKER, NOT THE HORIZON BUTTONS. Before this the popover's cells named a date and
       nothing else, so the only hour on screen was the one in the field — 02:30, which no day on
       the 28th can book. Each cell now carries the composition for its OWN day: the 28th says
       03:30, the 29th says 02:30, and the two are the same asked hour. */
    await mountBar(SPRING_EVE, "02:30");
    await openStrip();
    await act(async () => { byText("Pick a date").click(); });
    const cell = (day: string): string =>
      host!.querySelector(`[data-day="${day}"]`)?.getAttribute("aria-label") ?? "";
    expect(cell("2027-03-28"), "the skipped morning named no hour").toBe(
      "Sunday, March 28, 2027, 03:30",
    );
    expect(cell("2027-03-29")).toBe("Monday, March 29, 2027, 02:30");
    // The hour is the CELL's, not the field's: a day that books 03:30 may not say 02:30.
    expect(cell("2027-03-28")).not.toContain("02:30");
  });

  it("the picker's trigger promises no hour, because it names no day", async () => {
    await mountBar(SPRING_EVE, "02:30");
    await openStrip();
    /* It read "Pick a date, 02:30" and there was no day it could have booked that at. The two
       buttons beside it still carry their hour — they name a day, so the hour is a fact. */
    expect(byText("Pick a date").getAttribute("aria-label") ?? "Pick a date")
      .not.toContain("02:30");
    expect(byText("Tomorrow").getAttribute("aria-label")).toBe("Tomorrow, 03:30");
  });

  it("holds for Next week too — the horizon is not the rule", async () => {
    // The coming Monday is 29 March 2027, the day AFTER the change: the same chosen 02:30 is an
    // ordinary time there, and the booking is exactly it. The arm that proves the rule travels.
    await mountBar(SPRING_EVE, "02:30");
    const { said, iso } = await choose("Next week");
    expect(wallClock(iso)).toBe("29/03/2027, 02:30");
    expect(said).toBe(`Next week, ${wallTime(iso)}`);
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
   hour after the reader's clock first reads what they typed.
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe("send later composes the wall clock the same way", () => {
  it("answers the shared table on every case — the same table the phone's suite reads", async () => {
    const { composedLocalInput, dayAt } = await import("../app/shell/format.js");
    for (const c of WALL_CLOCK_CASES) {
      const typed = `${c.day}T${askedTime(c)}`;
      const custom = composedLocalInput(typed);
      expect(custom, `${c.name}: the field read nothing from ${typed}`).not.toBeNull();
      expect(custom!.instant.toISOString(), c.name).toBe(c.iso);
      expect(`${pad2(custom!.hour)}:${pad2(custom!.minute)}`, c.name).toBe(c.time);
      expect(custom!.verdict, c.name).toBe(c.verdict);
      /* ONE COMPOSITION, TWO DOORS: the resurface day and the typed clock are the same
         function on the same fields, so they cannot answer one night differently. */
      expect(dayAt(c.day, askedTime(c)), c.name).toEqual({
        iso: c.iso, time: c.time, verdict: c.verdict,
      });
    }
  });

  it("takes the FIRST of two when the typed hour comes round twice", async () => {
    const { composedLocalInput } = await import("../app/shell/format.js");
    // It answered 01:30Z — 02:30 CET, the second one. A chosen clock comes round when the
    // reader's clock FIRST reads it; the raw door's last-of-two rule is for closing windows.
    const at = composedLocalInput("2026-10-25T02:30")!;
    expect(at.instant.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(wallClock(at.instant.toISOString())).toBe("25/10/2026, 02:30");
    expect(at.verdict).toBe("first_of_two");
  });

  it("once the first of the two has passed, the repeated hour is the second", async () => {
    const { composedLocalInput } = await import("../app/shell/format.js");
    // 02:55 CET, the second 02:55 of the night: 02:58 is three minutes ahead, not an hour behind.
    const at = composedLocalInput("2026-10-25T02:58", new Date("2026-10-25T01:55:00.000Z"))!;
    expect(at.instant.toISOString()).toBe("2026-10-25T01:58:00.000Z");
    expect(composedLocalInput("2026-10-25T02:58", new Date("2026-10-24T23:00:00.000Z"))!.instant.toISOString())
      .toBe("2026-10-25T00:58:00.000Z");
  });

  it("the evening preset is a composition too, verdict and all", async () => {
    const { todayEvening } = await import("../app/shell/format.js");
    const evening = todayEvening(SPRING_EVE);
    expect(evening.instant.toISOString()).toBe("2027-03-27T17:00:00.000Z");
    expect(evening.verdict).toBe("exact");
    expect(evening.hour).toBe(18);
  });
});

describe("the send-later field says which hour it will send at", () => {
  /* REAL TIMERS AND THE REAL CLOCK HERE. The composer's body is ProseMirror, which mounts on a
     timer a fake clock never advances, and this describe does not need a pinned "now": the
     sentence is about the clock somebody TYPED, and 2027 is ahead of any day this runs on. */
  beforeEach(() => {
    vi.useRealTimers();
    window.location.hash = "";
    try { window.localStorage.clear(); } catch { /* storage blocked; the shell still boots */ }
    Object.defineProperty(window, "matchMedia", {
      configurable: true, writable: true,
      value: (query: string) => ({
        matches: false, media: query, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
      }),
    });
    (globalThis as Record<string, unknown>).CSS = { escape: (x: string) => x };
    const el = Element.prototype as unknown as Record<string, () => void>;
    el.scrollIntoView = () => {};
    el.scrollTo = () => {};
    (globalThis as Record<string, unknown>).IntersectionObserver = class {
      observe(): void {} unobserve(): void {} disconnect(): void {}
      takeRecords(): [] { return []; }
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).IntersectionObserver;
    delete (globalThis as Record<string, unknown>).CSS;
    vi.restoreAllMocks();
  });

  const drain = async (n = 8): Promise<void> => {
    for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  const nativeValue = async (el: HTMLInputElement, value: string): Promise<void> => {
    /* The setter off the ELEMENT's own prototype: the global one refuses this instance under
       jsdom here ("not a valid instance of HTMLInputElement"). */
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!;
    await act(async () => {
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  /** The shipped client on the fixture world, parked on compose with a SENDABLE message and the
   *  picker open — send later wears the same lock as Send, so nothing less opens it. */
  async function openSendLater(): Promise<void> {
    await unmount();
    const { AppShell } = await import("../app/shell/AppShell.js");
    const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
    const { typeInto } = await import("./fixtures/rich-editor-driver.js");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: ZONE, now: new Date(),
        children: h(ThemeProvider as never, {
          storageKey: null,
          children: h(ToastHost as never, { children: h(AppShell as never, { demo: true }) } as never),
        } as never),
      }));
    });
    for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
    await act(async () => {
      window.location.hash = "#/compose";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await settleFirstPaint();
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    await nativeValue(host!.querySelector<HTMLInputElement>("#compose-to")!, "ada@fake.test");
    let surface: HTMLElement | null = null;
    for (let i = 0; i < 40 && !surface; i += 1) {
      const el = host!.querySelector<HTMLElement>(".compose-editor .rte-surface")
        ?? host!.querySelector<HTMLElement>(".compose-editor [contenteditable=true]");
      if (el && (el as unknown as { editor?: unknown }).editor) surface = el;
      else await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    if (!surface) throw new Error("the compose editor never mounted a ProseMirror handle");
    await act(async () => { typeInto(surface!, "Tomorrow works."); });
    await drain(4);
    await act(async () => { host!.querySelector<HTMLButtonElement>(".send-later-toggle")!.click(); });
  }

  /** Type a wall clock into the field, and hand back every note the picker is showing. */
  async function typeWhen(value: string): Promise<string> {
    await nativeValue(host!.querySelector<HTMLInputElement>("#compose-send-at")!, value);
    return [...host!.querySelectorAll(".send-note")].map((n) => n.textContent ?? "").join(" | ");
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
    expect(host!.querySelector<HTMLInputElement>("#compose-send-at")!.min).toBe("2026-10-25T02:58");
    expect(await typeWhen("2026-10-25T02:58")).not.toContain("That time has passed");
    const confirm = [...host!.querySelectorAll<HTMLButtonElement>(".send-later-custom button")]
      .find((b) => b.textContent?.startsWith(messages.compose.sendLaterConfirm));
    expect(confirm?.disabled).toBe(false);
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
