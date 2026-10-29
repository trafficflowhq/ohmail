/** @vitest-environment jsdom */
/**
 * THE SHELL KEEPS NEWS AND RECEIPTS MOUNTED AMONG THE PILES, AND ONLY THERE (`kept-piles.tsx`).
 *
 * Driven through the real `AppShell` over a fixture mirror, by the route (the same door the keys
 * and the rail take). What must hold: a revisit shows the SAME pile it left, hidden in between; the
 * numbers on screen after a switch are the rail's numbers, a mirror change made while a pile was
 * hidden included; and leaving the piles, or a new engine, unmounts every kept one.
 *
 * Mutations watched red: key the outer boundary on the view again (the same-element rows); keep the
 * piles past the group (the settings row); a kept pile that stops receiving props while hidden (the
 * count row); a raw document query in zone-nav's focus follow or list entry (the focus row).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { OhmailEngine } from "@ohmail/client-engine";
import { FixturesAdapter } from "../../../packages/client-engine/src/adapters/fixtures-adapter";
import { getFixtures } from "@ohmail/fixtures";

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
  const { AppShell } = await import("../app/shell/AppShell.js");
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

const pile = (p: "reads" | "receipts"): HTMLElement | null => host!.querySelector<HTMLElement>(`.view-${p}`);
const shown = (el: HTMLElement | null): boolean =>
  el !== null && el.closest("[data-pile]")?.hasAttribute("data-pile-active") === true && el.style.display !== "none";

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
  it("News and Receipts are the same elements on a revisit, hidden in between", async () => {
    const engine = new OhmailEngine({ adapter: new FixturesAdapter({ fixtures: getFixtures() }) });
    await mountShell(engine);
    await go("#/reads");
    const reads = pile("reads");
    expect(reads, "News never rendered").not.toBeNull();
    expect(shown(reads)).toBe(true);
    await go("#/receipts");
    const receipts = pile("receipts");
    expect(pile("reads"), "News was unmounted on the way to Receipts").toBe(reads);
    expect(shown(reads)).toBe(false);
    expect(shown(receipts)).toBe(true);
    await go("#/ohbox");
    expect(host!.querySelector(".view-ohbox")).not.toBeNull();
    expect(pile("reads")).toBe(reads);
    expect(pile("receipts")).toBe(receipts);
    await go("#/reads");
    expect(pile("reads"), "the revisit mounted News again").toBe(reads);
    expect(shown(reads)).toBe(true);
  });

  it("leaving the piles unmounts every kept one", async () => {
    const engine = new OhmailEngine({ adapter: new FixturesAdapter({ fixtures: getFixtures() }) });
    await mountShell(engine);
    await go("#/reads");
    await go("#/receipts");
    await go("#/drafts");
    expect(pile("reads"), "a kept pile outlived the pile group").toBeNull();
    expect(pile("receipts")).toBeNull();
    await go("#/reads");
    expect(shown(pile("reads"))).toBe(true);
  });

  it("on Receipts after News, focus follows the cursor into Receipts' own rows", async () => {
    const engine = new OhmailEngine({ adapter: new FixturesAdapter({ fixtures: getFixtures() }) });
    await mountShell(engine);
    await go("#/reads");
    expect(pile("reads")!.querySelector(".row.sel"), "control: hidden News holds a selected row").not.toBeNull();
    await go("#/receipts");
    const rows = [...pile("receipts")!.querySelectorAll<HTMLElement>(".row[data-id]")];
    expect(rows.length, "control: the fixture's Receipts holds rows to walk").toBeGreaterThan(2);
    await act(async () => { rows[0]!.click(); });
    await act(async () => { pile("receipts")!.querySelector<HTMLElement>(".row.sel")!.focus(); });
    const press = async (key: string): Promise<void> => {
      await act(async () => {
        (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
      await settle(2);
    };
    await press("j");
    const sel = pile("receipts")!.querySelector<HTMLElement>(".row.sel")!;
    expect(sel.dataset.id, "control: j moved the cursor").toBe(rows[1]!.dataset.id);
    expect(document.activeElement, "focus went to a row in the hidden News pile").toBe(sel);
    await press("ArrowLeft");
    expect(document.activeElement?.closest(".rail"), "control: ← stands on the rail").not.toBeNull();
    await press("ArrowRight");
    expect(document.activeElement, "→ from the rail did not land on Receipts' selected row").toBe(sel);
  });

  it("every count on the rail and on the Screener's tabs says what it counts", async () => {
    const engine = new OhmailEngine({ adapter: new FixturesAdapter({ fixtures: getFixtures() }) });
    await mountShell(engine);
    const counted = [...host!.querySelectorAll<HTMLElement>(".rail .ritem")]
      .map((el) => ({ el, n: (el.querySelector(".cnt")?.textContent ?? "").trim() }))
      .filter(({ n }) => /^\d+$/.test(n));
    const ids = counted.map(({ el }) => el.dataset.railId ?? `tag:${el.dataset.railTagId}`);
    expect(ids, "control: the fixture's rail counts a pile and a tag").toEqual(
      expect.arrayContaining(["triage-aside", expect.stringMatching(/^tag:/)]),
    );
    for (const { el, n } of counted) {
      expect(el.title, `the ${el.textContent} count is a bare number`).toMatch(new RegExp(`\\b${n} [a-z]`));
    }
    expect(host!.querySelector<HTMLElement>('[data-rail-id="triage-aside"]')!.title).toBe("1 item");
    await go("#/screener");
    const waiting = host!.querySelector<HTMLElement>(".scn-seg button");
    const n = (waiting?.querySelector(".scnt")?.textContent ?? "").trim();
    expect(n, "control: the fixture has senders waiting").toMatch(/^\d+$/);
    expect(waiting!.title).toBe(`${n} first-time senders waiting`);
  });

  it("after a switch the pane says the rail's number, a change made while it was hidden included", async () => {
    const engine = new OhmailEngine({ adapter: new FixturesAdapter({ fixtures: getFixtures() }) });
    await mountShell(engine);
    const rail = (): string => host!.querySelector<HTMLElement>('[data-rail-id="reads"]')?.title ?? "";
    const pane = (): string => pile("reads")?.querySelector(".stream-top .meta")?.textContent ?? "";
    await go("#/reads");
    expect(pane(), "control: the pane states a count").toMatch(/since you were here/);
    expect(pane()).toBe(rail());
    const unread = [...pile("reads")!.querySelectorAll<HTMLElement>(".row[data-unseen]")].map((r) => r.dataset.id!);
    expect(unread.length, "control: the fixture's News holds unread mail to read away").toBeGreaterThan(0);
    const before = pane();
    await go("#/receipts");
    // While News is hidden, its unread letters are read on another device.
    await act(async () => {
      await engine.mutate({ kind: "mark_seen", messageIds: unread, unread: false, via: "glance" } as never);
    });
    await settle();
    await go("#/reads");
    expect(pane(), "the revealed pile said an older count than the rail").toBe(rail());
    expect(pile("reads")!.querySelectorAll(".row[data-unseen]").length, "a row read while hidden is still drawn unread").toBe(0);
    expect(before, "control: the change moved the count").not.toBe(pane());
  });
});
