/** @vitest-environment jsdom */
/**
 * Keep the rail count wording and the Screener's first-open preparation specified
 * while their current owners settle those contracts.
 */
import { within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { OhmailEngine } from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { getFixtures } from "@ohmail/testing";

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function settle(n = 8): Promise<void> {
  for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
}

async function go(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await settle();
}

async function mountShell(engine: OhmailEngine): Promise<void> {
  const { AppShell } = await import("./_todays-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages: messages as never, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
      children: h(ThemeProvider, { children: h(ToastHost, { children: h(AppShell, { demo: false, engine }) }) }),
    }));
  });
  await settle(12);
}

beforeEach(() => {
  window.history.replaceState(null, "", "#/ohbox");
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  vi.stubGlobal("IntersectionObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} takeRecords(): [] { return []; } });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
  window.history.replaceState(null, "", "#");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the piles among the piles", () => {





  it("every count on the rail and on the Screener's tabs says what it counts", async () => {
    const engine = new OhmailEngine({ adapter: new FixturesAdapter({ fixtures: getFixtures() }) });
    await mountShell(engine);
    const nav = within(within(host!).getByRole("navigation", { name: "Places" }));
    const tags = nav.getByRole("button", { name: "Tags" });
    if (tags.getAttribute("aria-expanded") !== "true") await act(async () => { tags.click(); });
    // The rail's entries are the kit's: the id stands on the box around the entry's button.
    const counted = [...host!.querySelectorAll<HTMLElement>("[data-rail-id], [data-rail-tag-id]")]
      .map((box) => ({ box, el: box.querySelector<HTMLElement>("button")!, n: (box.querySelector(".oh-railentry-count")?.textContent ?? "").trim() }))
      .filter(({ n }) => /^\d+$/.test(n));
    const ids = counted.map(({ box }) => box.dataset.railId ?? `tag:${box.dataset.railTagId}`);
    expect(ids, "control: the fixture's rail counts a pile and a tag").toEqual(
      expect.arrayContaining(["parked", expect.stringMatching(/^tag:/)]),
    );
    for (const { el, n } of counted) {
      expect(el.title, `the ${el.textContent} count is a bare number`).toMatch(new RegExp(`\\b${n} [a-z]`));
    }
    expect(host!.querySelector<HTMLElement>('[data-rail-id="parked"] button')!.title).toBe("1 item");
    await go("#/screener");
    const waiting = within(host!).getByRole("button", { name: /^Waiting \d+$/ });
    const n = (waiting.getAttribute("aria-label") ?? "").split(" ").at(-1);
    expect(n, "control: the fixture has senders waiting").toMatch(/^\d+$/);
    expect(waiting!.title).toBe(`${n} first-time senders waiting`);
  });
});

describe("the Screener's first open", () => {
  it("the stage draws the Screener's shapes hidden before it is first opened, and none once it has been", async () => {
    // The page lays out (the warm-up primes only where it does); frames run as jsdom's timers do.
    const rects = Element.prototype.getClientRects;
    vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function boxes(this: Element) {
      return this === document.body ? [{ top: 0, bottom: 900, height: 900 }] as unknown as DOMRectList : rects.call(this);
    });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16));
    vi.stubGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
    const drawn: Array<string | null> = [];
    const watch = new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) {
        if (!(n instanceof HTMLElement) || !n.matches(".sc-primer")) continue;
        drawn.push(within(n).queryAllByRole("option", { hidden: true })[0]?.getAttribute("aria-label") ?? null);
      }
    });
    const engine = new OhmailEngine({ adapter: new FixturesAdapter({ fixtures: getFixtures() }) });
    await mountShell(engine);
    watch.observe(host!, { childList: true, subtree: true });
    for (let i = 0; i < 60 && drawn.length === 0; i += 1) await settle(2);
    expect(drawn.length, "the stage never drew the Screener's shapes").toBeGreaterThan(0);
    expect(drawn[0], "the first piece is not the Waiting list's first row").toMatch(/\S/);
    expect(within(host!).getByRole("heading", { name: "Ohbox", level: 1 })).toBeTruthy();
    await go("#/screener");
    expect(within(host!).getByRole("heading", { name: "Screener", level: 1 })).toBeTruthy();
    const before = drawn.length;
    await settle(60);
    watch.disconnect();
    expect(drawn.length - before, "the stage primed a Screener already on screen").toBe(0);
  });
});
