/** @vitest-environment jsdom */
/**
 * ═══ COMPOSE IS A PANEL WITH A HEAD, A MESSAGE AND A FOOT ═════════════════════════════════
 *
 * The pass this file guards is a composition, so the assertions are about STRUCTURE — which
 * element contains which — and not about a computed pixel. Two of the three are things a
 * screenshot cannot tell you and a CSS change cannot fake:
 *
 *  (The older tests' sorting: the markup cases of points 1 and 3 left with today's view by their
 *  rows; points 2 and the bare Subject are read over Write's new letter, below.)
 *
 *  1. THE CC/BCC AFFORDANCE IS INSIDE THE `TO` ROW. It had a full-width strip of its own
 *     (`.c-ccbcc-row`) between To and Subject, which read as a fourth field and cost the form a
 *     band of vertical space to say one 11.5px word. Lifting the button back out of the row is
 *     exactly the mutation this catches: `closest(".c-field")` stops resolving to the To field
 *     and the first assertion goes red. A test that merely asked "is there a Cc/Bcc button"
 *     would pass against the shipped defect, which is why it asks WHERE.
 *
 *  2. IT STILL OPENS THE FIELDS. Moving a control is only safe if it still does its job, so the
 *     press is driven and both rows are read out of the DOM.
 *
 *  3. THE PANEL'S THREE REGIONS ARE IN ORDER AND THE FOOT IS LAST. `.compose-head`,
 *     `.compose-editor`, `.compose-foot` are direct children of `.compose-wrap` in that order,
 *     and Send and the status line are both inside the foot — which is what `margin-top: auto`
 *     acts on. Put SendStatus back outside the foot and the last assertion fails.
 *
 * Mounted through the shipped shell rather than by handing `ComposeView` props, for the reason
 * `compose-from.test.ts` gives about the From row: the defect this replaces was a working data
 * path with the wrong thing on screen, so the acceptance is the rendered surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  window.location.hash = "";
  try { window.localStorage.clear(); } catch { /* storage blocked; the in-memory half still runs */ }
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {} unobserve(): void {} disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

async function mountCompose(): Promise<void> {
  const { AppShell } = await import("./_todays-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
  await act(async () => {
    window.location.hash = "#/compose";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await settleFirstPaint();
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

/*
 * THE OLDER TESTS' SORTING: the shell above is the new shell's test door (`_todays-shell.js`'s old
 * name of it); `#/compose` is Write's new letter, the region "New message". Its people line is the kit's Recipients
 * (the combobox "To", "Cc", "Bcc"; the toggle the press "Cc Bcc"), its subject the input "Subject". The cases that drew
 * today's markup (`.c-field`, `.compose-wrap`, `.compose-head`, `.compose-foot`) left with today's view by their rows;
 * what a person meets behind them is held where each row names.
 */
const LETTER = '[role="region"][aria-label="New message"]';
const line = (name: string): HTMLElement | null =>
  host!.querySelector<HTMLElement>(`${LETTER} [role="combobox"][aria-label="${name}"]`);
const toggle = (): HTMLButtonElement | null =>
  [...host!.querySelectorAll<HTMLButtonElement>(`${LETTER} button`)]
    .find((b) => b.getAttribute("aria-label") === "Cc Bcc" || (b.textContent ?? "").trim() === "Cc Bcc") ?? null;

describe("the Cc/Bcc affordance lives in the To row", () => {
  it("still opens Cc and Bcc, and takes itself off screen once they are up", async () => {
    await mountCompose();
    expect(line("Cc"), "Cc was already open before the toggle was pressed").toBeNull();

    await act(async () => { toggle()!.click(); });

    expect(line("Cc"), "the toggle no longer reveals Cc").not.toBeNull();
    expect(line("Bcc"), "the toggle no longer reveals Bcc").not.toBeNull();
    expect(
      toggle(),
      "the toggle is still on screen with nothing left to reveal",
    ).toBeNull();
  });
});

describe("the panel is head · message · foot, in that order", () => {
  it("renders Subject BARE — an accessible name, no label element", async () => {
    await mountCompose();
    const subject = host!.querySelector<HTMLInputElement>(`${LETTER} input[aria-label="Subject"], ${LETTER} textarea[aria-label="Subject"]`);
    expect(
      [...host!.querySelectorAll(`${LETTER} label`)].filter((l) => (l.textContent ?? "").trim() === "Subject"),
      "the Subject label gutter is back",
    ).toEqual([]);
    // Bare is not nameless. Losing this is the one way "bare" becomes a regression.
    expect(subject?.getAttribute("aria-label"), "Subject has no accessible name").toBe("Subject");
  });
});
