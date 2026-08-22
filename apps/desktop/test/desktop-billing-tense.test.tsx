/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import messages from "../../webapp/messages/en.json";
import german from "../../webapp/messages/de.json";
import { BILLING_PATH, DesktopBilling } from "../src/DesktopBilling.js";

/**
 * ═══ THE PLAN ROW'S TENSE — WHAT THE PANE SAYS ABOUT A DATE IT DID NOT CHOOSE ═══════════════
 *
 * The row under the plan carries one sentence about `currentPeriodEnd`, and that sentence used
 * to be picked from `cancelAtPeriodEnd` alone: "Renews {when}" unless a cancellation was
 * scheduled. Two states made it false.
 *
 *  · A CARD-LESS TRIAL. `status: "trialing"` with no cancellation scheduled read "Renews" —
 *    a promise of a charge that nothing on file can make. At the recorded date the trial ends,
 *    into a plan if a card was added and into nothing if not, and "Trial ends" is the sentence
 *    that is right in both futures. The browser tab's billing pane says exactly that; the same
 *    account read differently in this window.
 *
 *  · A DATE ALREADY GONE. Nothing server-side expires a trial on the clock — the subscription
 *    row waits for the billing event that moves it — so a mirror row can sit at `trialing` with
 *    a `currentPeriodEnd` days in the past, and the pane kept announcing that date in the
 *    future tense. Past date, past tense: a gone trial gets "Trial ended {when}" (true
 *    whichever way it went), and every other state collapses to "Billing period ended {when}" —
 *    a statement about the period the pane can actually see, never a renewal it cannot confirm
 *    happened.
 *
 * ── THE FIXTURE DATES ARE RELATIVE TO NOW, AND THAT IS LOAD-BEARING ─────────────────────────
 *
 * A tense is a claim about a date's position against the wall clock, so a fixture pinned to a
 * literal date changes meaning on no commit at all: the day it slips into the past, a case
 * written about a future date starts exercising the other arm and keeps passing. Both windows
 * are named below (`endsInMs` positive and negative) and neither can drift.
 *
 * ── AND THE BOUNDARY IS WATCHED WHILE THE PANE IS ON SCREEN ─────────────────────────────────
 *
 * The tense is chosen from `Date.now()` during a render, so a pane opened before the period
 * ends and left mounted past it would keep the future-tense sentence for as long as it stayed
 * open — the one case where the transition happens while somebody is watching. The component
 * schedules one timer for that instant; the last case is the only thing that proves the timer
 * exists. It runs on a fake clock, which does not weaken it — advancing fires timers that
 * EXIST, so a component that schedules nothing stays in the future tense and fails — and the
 * clock is taken over only after the module is imported, so the deadline and the advance are
 * measured on the same clock the component reads.
 *
 * ── MUTATION WATCH ──────────────────────────────────────────────────────────────────────────
 *
 * Each of these was run against the finished component, watched fail, and restored:
 *  · choose the key from `cancelAtPeriodEnd` alone again → the trial cases go red on "Renews";
 *  · force the past-tense arm unconditionally → the mid-window case goes red on "Trial ended";
 *  · collapse the gone trial into the neutral sentence → the past-trial cases go red;
 *  · delete the boundary timer → the last case goes red ("the row never left the future tense").
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface Host { __TAURI_INTERNALS__?: { invoke: Invoke } }
const host = globalThis as unknown as Host;

/** One answer, framed exactly as the shell frames one for the window's pipe. */
function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

/**
 * A subscription whose period end sits `endsInMs` from NOW — the same `Date.now()` the
 * component reads, which under the fake clock below is the frozen one, so the distance between
 * the fixture and the boundary is exact rather than raced.
 */
function status(over: {
  status?: string;
  endsInMs?: number | null;
  cancelAtPeriodEnd?: boolean;
}): Record<string, unknown> {
  return {
    subscription: {
      plan: "solo",
      status: over.status ?? "trialing",
      mailboxLimit: 2,
      monthlyCredits: 500,
      currentPeriodEnd:
        over.endsInMs == null ? null : new Date(Date.now() + over.endsInMs).toISOString(),
      cancelAtPeriodEnd: over.cancelAtPeriodEnd ?? false,
      graceUntil: null,
    },
    balance: 500,
    entitlements: { syncEnabled: true, aiEnabled: true, mailboxLimit: 2 },
  };
}

const DAY = 24 * 60 * 60 * 1000;

let answer: Record<string, unknown>;

function shellAnswering(): void {
  host.__TAURI_INTERNALS__ = {
    invoke: async (_command, payload) => {
      const url = ((payload ?? {}) as { url?: string }).url ?? "";
      if (url === BILLING_PATH) return encode(200, JSON.stringify(answer));
      // The AI switch's own read. Answered so the pane settles; nothing here asserts on it.
      return encode(200, JSON.stringify({ aiEnabled: true }));
    },
  };
}

let hostEl: HTMLDivElement;
let root: Root;

/**
 * Settled on MICROTASKS alone, never `setTimeout`: the boundary case runs under a fake clock,
 * where a macrotask sleep would hang the mount, and the pane's two reads are plain promise
 * chains that need no timer to resolve.
 */
async function mountPane(locale: "en" | "de" = "en"): Promise<void> {
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale,
        messages: locale === "de" ? german : messages,
        timeZone: "UTC",
        children: h(ThemeProvider, null, h(ToastHost, null, h(DesktopBilling))),
      }),
    );
  });
  await act(async () => { for (let i = 0; i < 24; i += 1) await Promise.resolve(); });
}

/** The rendered row whose label is `label`, as text — keyed on the design system's row markup. */
function rowText(label: string): string | null {
  for (const row of Array.from(hostEl.querySelectorAll(".set-row"))) {
    if (row.querySelector(".lab > b")?.textContent?.trim() === label) {
      return (row.textContent ?? "").trim();
    }
  }
  return null;
}

beforeEach(() => {
  shellAnswering();
  /* Nothing on this path may open a socket: this window has no API client and no network
     permission. A fallback to one would land here rather than passing quietly. */
  globalThis.fetch = (async () => {
    throw new Error("the window opened a socket — nothing in this pane may reach the network");
  }) as typeof fetch;
});

afterEach(async () => {
  if (root) await act(async () => { root.unmount(); });
  hostEl?.remove();
  delete host.__TAURI_INTERNALS__;
});

describe("the plan row's tense", () => {
  it("a card-less trial mid-window says the trial ends — never that it renews, never that it ended", async () => {
    answer = status({ endsInMs: 7 * DAY });
    await mountPane();
    const row = rowText("Subscription");
    expect(row, "no plan row at all").not.toBeNull();
    expect(row).toContain("Trial ends");
    // The defect this file was written against: `cancelAtPeriodEnd` alone chose the sentence.
    expect(row, "a promise of a charge nothing on file can make").not.toContain("Renews");
    // …and the mid-window arm is what catches a component gone past-tense unconditionally.
    expect(row).not.toContain("Trial ended");
  });

  /**
   * Asserted in BOTH catalogues, because a missing key is not a failed render — it is the raw
   * key on screen — and the German future tense is a PREFIX of the past ("endet"/"endete"), so
   * the absence assertion needs the trailing space to mean anything.
   */
  it.each([
    ["en", "Subscription", "Trial ended", "Trial ends"],
    ["de", "Abo", "Testphase endete", "Testphase endet "],
  ] as const)("%s: a trial whose end date has passed is spoken about in the past", async (locale, label, past, future) => {
    answer = status({ endsInMs: -5 * DAY });
    await mountPane(locale);
    const row = rowText(label);
    expect(row, "no plan row at all").not.toBeNull();
    expect(row).toContain(past);
    expect(row).not.toContain(future);
    expect(row, "the catalogue key leaked to the screen").not.toContain("webPlanTrialEnded");
  });

  it.each([
    ["en", "Subscription", "Billing period ended", "Renews"],
    ["de", "Abo", "Abrechnungszeitraum endete", "Verlängert sich"],
  ] as const)("%s: a live plan past its recorded end speaks about the period, not a renewal it cannot confirm", async (locale, label, past, renews) => {
    answer = status({ status: "active", endsInMs: -5 * DAY });
    await mountPane(locale);
    const row = rowText(label);
    expect(row, "no plan row at all").not.toBeNull();
    expect(row).toContain(past);
    expect(row).not.toContain(renews);
    expect(row, "the catalogue key leaked to the screen").not.toContain("webPlanPeriodEnded");
  });

  it("the two future-tense arms are untouched: a live plan renews, a cancelled one ends", async () => {
    answer = status({ status: "active", endsInMs: 10 * DAY });
    await mountPane();
    expect(rowText("Subscription")).toContain("Renews");

    await act(async () => { root.unmount(); });
    hostEl.remove();

    answer = status({ status: "active", endsInMs: 10 * DAY, cancelAtPeriodEnd: true });
    await mountPane();
    const row = rowText("Subscription");
    expect(row).toContain("Ends ");
    expect(row).not.toContain("Renews");
    expect(row).not.toContain("Billing period ended");
  });

  /**
   * THE PANE NOTICES THE BOUNDARY GO BY WHILE IT IS ON SCREEN. Only the timer's existence is
   * guarded here: the row is rendered a minute before the end and read again after it, and the
   * only thing that can move it is the one wake-up the component schedules for that instant.
   */
  it("a pane left open across the boundary re-renders itself into the past tense", async () => {
    vi.useFakeTimers();
    try {
      answer = status({ endsInMs: 60_000 });
      await mountPane();
      expect(rowText("Subscription"), "the row starts in the future tense").toContain("Trial ends");
      // Past the boundary AND past the component's own settling margin.
      await act(async () => { vi.advanceTimersByTime(61_500); });
      const after = rowText("Subscription") ?? "";
      expect(after, "the row never left the future tense").toContain("Trial ended");
      expect(after).not.toContain("Trial ends");
    } finally {
      vi.useRealTimers();
    }
  });
});
