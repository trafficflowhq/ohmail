/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { setActiveFormatZone } from "../app/shell/locale";
import { useDayClock } from "../app/shell/day-clock";

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
 *  · In `MessagePane`, mint the horizon at RENDER again — `pick(() => tomorrowAt(nowAt(), …))`
 *    → `pick(() => tomorrow)` — and cases 1 and 2 go red on the booked day.
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

const MESSAGE: Record<string, unknown> = {
  id: "m1", accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
  subject: "subj", from: { name: "Andi", address: "andi@ex.example" }, to: [], cc: [],
  date: "2026-09-12T09:00:00.000Z", folder: "INBOX", snippet: "snip",
  unread: false, hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-12T09:00:00.000Z",
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let log: string[] = [];
/** The clock the chrome hands the strip — the shell's own `nowAt`, under the test's control. */
let clock = LATE;

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

async function mountBar(): Promise<void> {
  await unmount();
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
    resurfaceTime: null,
    // THE SEAM UNDER TEST: the shell's press-time clock, asked rather than captured.
    nowAt: () => clock,
  };
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: ZONE, now: LATE,
        children: h(MessageChromeProvider as never, {
          value: chrome,
          children: h(MessageActionBar as never, {
            // The MOUNT value, deliberately stale by the time anything is pressed — this is
            // exactly the value the defect used.
            message: MESSAGE, now: LATE, onAction: (a: string) => log.push(a),
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

/** The instant the strip dispatched, off the one `resurface:` action it raised. */
function booked(): string {
  const line = log.find((l) => l.startsWith("resurface:"));
  expect(line, "the strip dispatched no dated resurface").toBeTruthy();
  return line!.slice("resurface:".length);
}

beforeEach(() => {
  setActiveFormatZone(ZONE);
  log = [];
  clock = LATE;
});

afterEach(async () => {
  await unmount();
  setActiveFormatZone(null);
  vi.useRealTimers();
});

describe("the horizon is minted from the clock at the press", () => {
  it("mounted at 23:59 and pressed at 05:01, Tomorrow is the NEW tomorrow", async () => {
    await mountBar();
    await openStrip();
    // The day turns while the strip stands open — nothing re-mounts, nothing re-renders. Past
    // the small hours, because until 05:00 "Tomorrow" is the coming morning, the 13th.
    clock = NEXT_MORNING;
    await act(async () => { byText("Tomorrow").click(); });
    expect(readerDay(booked()), "the booking came from the day the app was opened on")
      .toBe("2026-09-14");
  });

  it("Next week moves with it", async () => {
    clock = SUNDAY_SMALL_HOURS;
    await mountBar();
    await openStrip();
    clock = MONDAY_EARLY;
    await act(async () => { byText("Next week").click(); });
    // Pressed on the Monday, "next week" is the Monday after — never the one this press is on.
    expect(readerDay(booked()), "the horizon came from the Sunday the strip opened on")
      .toBe("2026-09-21");
  });

  it("…and from the Sunday it would have been the 14th (the pair's other side)", async () => {
    clock = SUNDAY_SMALL_HOURS;
    await mountBar();
    await openStrip();
    await act(async () => { byText("Next week").click(); });
    expect(readerDay(booked())).toBe("2026-09-14");
  });

  it("a press inside the same day is unchanged (the positive control)", async () => {
    await mountBar();
    await openStrip();
    await act(async () => { byText("Tomorrow").click(); });
    expect(readerDay(booked())).toBe("2026-09-13");
  });
});

describe("useDayClock re-reads at the day boundary and not on the minute", () => {
  function Probe({ fixed }: { fixed: Date | null }): React.ReactElement {
    const now = useDayClock(fixed);
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

  it("a fixed instant never moves and arms no timer (the fixture world)", async () => {
    vi.useFakeTimers({ now: LATE });
    await mountProbe(LATE);
    expect(vi.getTimerCount(), "the demo armed a clock watch").toBe(0);
    vi.setSystemTime(PAST_MIDNIGHT);
    await act(async () => { vi.advanceTimersByTime(120_000); });
    expect(shown()).toBe(LATE.toISOString());
  });
});
