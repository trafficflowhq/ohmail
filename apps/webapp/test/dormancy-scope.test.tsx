/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";

import en from "../messages/en.json";
import de from "../messages/de.json";
import { DormancyRow } from "../app/shell/DormancyRow";

/**
 * ═══ SETTINGS → SCREENER OFFERS "ALL TIME", AND SAYS WHAT IT DOES ═════════════════════════
 *
 * What was reported: the pane offered a window and nothing else, so an account could not ask the
 * Screener to look further back than a year — while the engine had had `screening_scope`
 * ('window' | 'all_time') since mail 0083 and the onboarding flow had been writing it all along.
 * The dial was in the product; only Settings could not reach it.
 *
 * ── WHAT THE MODE MEANS, WHICH IS WHAT THE COPY IS PINNED TO ────────────────────────────────
 *
 * Widening is a change to WHO THE SCREENER ASKS ABOUT, and to nothing else. Senders past the old
 * cutline become active-undecided in the Screener QUEUE; their mail stays physically where it is,
 * and it moves only when a decision is made about that sender. So no sentence on this pane may
 * claim it moves mail, and these cases assert that as a property of the rendered copy rather than
 * as a promise in a comment — in BOTH locales, because a claim is a claim in German too.
 *
 * ── AND WHY THE PAIR TRAVELS AS ONE CALL ────────────────────────────────────────────────────
 *
 * The window and the mode answer one question, and the server writes them in one upsert. The
 * control's half of that contract: a number names BOTH (choosing 90 on an all-time account has to
 * move the mode back, or the number would be stored and ignored), and "all time" names ONLY the
 * mode (so the stored number survives underneath and narrowing restores what was chosen). Both
 * directions are asserted below, because getting either wrong is a control that reports success
 * and changes nothing.
 *
 * `apps/webapp` typechecks its tests, so the setter's shape is checked as well as its arguments.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

type Call = [number | null | undefined, ("window" | "all_time")?];

async function mount(opts: {
  days: number;
  scope: "window" | "all_time";
  messages?: typeof en;
  locale?: string;
  face?: string;
}): Promise<{ host: HTMLElement; root: Root; calls: Call[] }> {
  const calls: Call[] = [];
  const host = document.createElement("div");
  // The FACE is a real attribute on a real ancestor, not a prop: the pane is themed by the
  // shell's own root, and a control that only looks right under one face is the defect the
  // one-UI rule exists to catch.
  host.setAttribute("data-face", opts.face ?? "paper");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: opts.locale ?? "en",
      messages: (opts.messages ?? en) as never,
      timeZone: "UTC",
      children: h(ThemeProvider, {
        storageKey: null,
        children: h(DormancyRow, {
          days: opts.days,
          scope: opts.scope,
          setDormancyDays: async (
            d: number | null | undefined, sc?: "window" | "all_time",
          ): Promise<number> => {
            calls.push(sc === undefined ? [d] : [d, sc]);
            return d ?? opts.days;
          },
        }),
      }),
    }));
  });
  return { host, root, calls };
}

/** Every rung on screen. `SegmentedControl` renders options as buttons in a `role="group"`. */
/** Unmount inside `act`, or React warns about the alive-guard effect on every teardown. */
const drop = async (root: Root, host: HTMLElement): Promise<void> => {
  await act(async () => { root.unmount(); });
  host.remove();
};

const labels = (host: HTMLElement): string[] =>
  [...host.querySelectorAll("button")].map((el) => (el.textContent ?? "").trim()).filter(Boolean);

/** The rung the control reports as chosen — `aria-pressed`, the `role="group"` spelling. */
const selectedLabel = (host: HTMLElement): string =>
  ([...host.querySelectorAll("button[aria-pressed='true']")]
    .map((el) => (el.textContent ?? "").trim())[0]) ?? "";

const press = async (host: HTMLElement, label: string): Promise<void> => {
  const el = [...host.querySelectorAll("button")]
    .find((n) => (n.textContent ?? "").trim() === label);
  expect(el, `no rung labelled "${label}" — rungs were ${labels(host).join(" / ")}`).toBeTruthy();
  await act(async () => { (el as HTMLElement).click(); });
};

describe("Settings → Screener: the window and its mode", () => {
  it("offers the onboarding ladder and 'All time'", async () => {
    const { host, root } = await mount({ days: 365, scope: "window" });
    const got = labels(host);
    for (const rung of ["90", "180", "365", "All time"]) expect(got).toContain(rung);
    await drop(root, host);
  });

  /**
   * The band is 1–365 and the ladder is three of those, so an account can hold a window the
   * ladder does not offer. Rendering the ladder alone would leave the control with nothing
   * selected over a real stored setting, which reads as "unset". The default (60) is no longer
   * that case: it is always a rung, below.
   */
  it("shows a stored window that is not on the ladder, so nothing reads as unset", async () => {
    const { host, root } = await mount({ days: 120, scope: "window" });
    expect(labels(host)).toContain("120");
    expect(selectedLabel(host)).toBe("120");
    await drop(root, host);
  });

  it("always offers the product default, labelled as the default, in both locales", async () => {
    for (const [messages, locale] of [[en, "en"], [de as unknown as typeof en, "de"]] as const) {
      const label = messages.settings.dormancy.dayLabelDefault.replace("{days}", "60");
      for (const days of [60, 90, 365]) {
        const { host, root } = await mount({ days, scope: "window", messages, locale });
        expect(labels(host).filter((l) => l.startsWith("60")), `${locale} at ${days}`).toEqual([label]);
        if (days === 60) expect(selectedLabel(host)).toBe(label);
        await drop(root, host);
      }
    }
  });

  it("selects the mode rung — not a number — when the account is on all time", async () => {
    const { host, root } = await mount({ days: 90, scope: "all_time" });
    expect(selectedLabel(host)).toBe("All time");
    await drop(root, host);
  });

  it("choosing 'All time' names ONLY the mode, so the stored window survives", async () => {
    const { host, root, calls } = await mount({ days: 180, scope: "window" });
    await press(host, "All time");
    expect(calls).toEqual([[undefined, "all_time"]]);
    await drop(root, host);
  });

  it("choosing a number names BOTH, so it cannot be stored and ignored", async () => {
    const { host, root, calls } = await mount({ days: 180, scope: "all_time" });
    await press(host, "90");
    expect(calls).toEqual([[90, "window"]]);
    await drop(root, host);
  });

  it("re-pressing the rung already selected writes nothing", async () => {
    const { host, root, calls } = await mount({ days: 90, scope: "all_time" });
    await press(host, "All time");
    expect(calls).toEqual([]);
    await drop(root, host);
  });

  /* ── THE CLAIM, IN BOTH LOCALES ────────────────────────────────────────────────────────── */

  const MOVES_CLAIMS = [
    /moves your mail/i, /move your mail/i, /verschiebt deine post/i, /deine post wird verschoben/i,
  ];

  it("never claims the setting moves mail — en and de, both modes", async () => {
    for (const [locale, msgs] of [["en", en], ["de", de]] as const) {
      for (const scope of ["window", "all_time"] as const) {
        const { host, root } = await mount({ days: 90, scope, messages: msgs as never, locale });
        const text = host.textContent ?? "";
        for (const claim of MOVES_CLAIMS) {
          expect(text, `${locale}/${scope} made a moves-your-mail claim`).not.toMatch(claim);
        }
        // …and it says the true thing instead: the mail stays until a decision.
        expect(text.length).toBeGreaterThan(40);
        await drop(root, host);
      }
    }
  });

  it("says quiet senders' mail, read or unread, is in History — never that unread always shows", async () => {
    for (const [locale, msgs, history, readOrUnread, unreadShows] of [
      ["en", en, /History/, /read or unread/, /unread always shows/i],
      ["de", de, /Historie/, /gelesen oder ungelesen/, /Ungelesenes wird immer angezeigt/i],
    ] as const) {
      const { host, root } = await mount({ days: 60, scope: "window", messages: msgs as never, locale });
      const text = host.textContent ?? "";
      expect(text, locale).toMatch(history);
      expect(text, locale).toMatch(readOrUnread);
      expect(text, locale).not.toMatch(unreadShows);
      await drop(root, host);
    }
  });

  it("says what widening does, in both locales", async () => {
    for (const [locale, msgs] of [["en", en], ["de", de]] as const) {
      const { host, root } = await mount({
        days: 90, scope: "all_time", messages: msgs as never, locale,
      });
      const text = host.textContent ?? "";
      const wider = (msgs as typeof en).settings.dormancy.microcopyWider;
      const allTime = (msgs as typeof en).settings.dormancy.microcopyAllTime;
      expect(wider, `${locale} has no widening note`).toBeTruthy();
      expect(text).toContain(wider);
      expect(text).toContain(allTime);
      await drop(root, host);
    }
  });

  it("renders under both faces with the mode rung present", async () => {
    for (const face of ["paper", "ohmarchy"]) {
      const { host, root } = await mount({ days: 90, scope: "all_time", face });
      expect(labels(host), `face ${face}`).toContain("All time");
      await drop(root, host);
    }
  });

  /**
   * KEYBOARD IS THE CONTROL'S, NOT THIS ROW'S — and the assertion is that the mode rung is
   * handed to the SAME control as the numbers, not a re-test of the primitive.
   *
   * `SegmentedControl` renders a `role="group"` of real `<button>`s, so every rung is
   * tab-reachable and Enter/Space activates it, with no key handling anywhere in this file. A
   * mode rung rendered outside that group — as a checkbox beside the dial, say — would reach the
   * keyboard by a different route and report its state in a different way, which is exactly the
   * divergence this pins.
   */
  it("puts the mode rung in the same group, and states it the same way", async () => {
    const { host, root } = await mount({ days: 90, scope: "window" });
    const group = host.querySelector("[role='group']");
    expect(group).toBeTruthy();
    const inside = [...group!.querySelectorAll("button")].map((n) => (n.textContent ?? "").trim());
    expect(inside).toContain("All time");
    expect(inside).toContain("90");
    // Every rung states its own selectedness, so none is a control of a different kind.
    for (const b of group!.querySelectorAll("button")) {
      expect(b.getAttribute("aria-pressed")).toMatch(/^(true|false)$/);
    }
    await drop(root, host);
  });
});
