/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * A CLOSED DRAWER IS INERT. At phone width the rail is translated off canvas, and
 * 26 of 35 Tab stops walked through it unseen. The census: every stylesheet rule that parks a
 * surface off canvas names the surface that makes itself inert while it is parked there. The
 * behaviour, through the shipped shell at 390px: closed, the rail is inert and its toggle states
 * collapsed and what it controls; open, focus goes in and Tab and Shift+Tab stay; Escape parks it.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.setConfig({ testTimeout: 20_000 });

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SHEETS = ["../app/app.css", "../app/zero-layout.css", "../../../packages/ui/src/composites/rail.css"];

/** Rules outside `@keyframes` that translate a surface by its own full size or more. */
function offCanvasSelectors(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  const out: string[] = [];
  for (const m of text.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    if (/(?:transform\s*:[^;]*translate[XY]?|translate\s*:)\s*\(?\s*-?(?:1\d\d|[2-9]\d\d)%/.test(m[2]!)) out.push(m[1]!.trim());
  }
  return out;
}

/** Each parked surface, and the fact the case below proves about it. */
const PARKED: Record<string, string> = {
  ".deck > .rail": "the navigation drawer (RailNav's inert)",
  ".tm-tip": "the thread squares' chip (aria-hidden, pointer-events none, nothing focusable)",
};

/** The declarations of `selector`'s own rule in `css`. */
const ruleOf = (css: string, selector: string): string =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{};]+)\{([^{}]*)\}/g)].find((m) => m[1]!.trim() === selector)?.[2] ?? "";

let roots: Root[] = [];
let wide = false;

beforeEach(() => {
  window.location.hash = "";
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
  // 390px: under the phone edge (699.98), the drawer edge (1023.98) and the Zero ribbon's 392,
  // so a closed rail is off canvas.
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: !wide && /max-width:\s*(1023\.98|699\.98|721)px/.test(query) && !/min-width/.test(query),
      media: query, onchange: null,
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
  for (const root of roots) await act(async () => { root.unmount(); });
  roots = [];
  wide = false;
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  vi.restoreAllMocks();
});

async function shell(): Promise<void> {
  const { AppShell } = await import("./_todays-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
      children: h(ThemeProvider, { storageKey: null, children: h(ToastHost, { children: h(AppShell, { demo: true }) }) }),
    }));
  });
  await settleFirstPaint();
  await settle();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex], [contenteditable="true"]';
const stops = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(TABBABLE)]
  .filter((s) => s.tabIndex >= 0 && s.closest("[inert]") === null);
const rail = (): HTMLElement => document.querySelector<HTMLElement>("nav.rail")!;

async function key(k: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  await act(async () => { (document.activeElement ?? document.body).dispatchEvent(e); });
  return e;
}

/** Tab, with the browser's own move when nothing prevented it: the next stop in document order. */
async function tab(shift = false): Promise<void> {
  const from = (document.activeElement ?? document.body) as HTMLElement;
  const e = await key("Tab", { shiftKey: shift });
  if (e.defaultPrevented) return;
  const all = stops();
  const after = (s: HTMLElement): boolean => (from.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  const to = shift ? all.filter((s) => s !== from && !after(s) && !s.contains(from)).pop() : all.find((s) => s !== from && after(s));
  await act(async () => { to?.focus(); });
}

/** Onto the toggle the keyboard way, then Enter presses it as a browser does (a click). */
async function pressToggle(): Promise<HTMLElement> {
  const toggle = document.querySelector<HTMLElement>(".topbar .tb-btn")!;
  for (let i = 0; i < 40 && document.activeElement !== toggle; i += 1) await tab();
  expect(document.activeElement, "Tab never reached the drawer's toggle").toBe(toggle);
  await key("Enter");
  await act(async () => { toggle.click(); });
  await settle();
  return toggle;
}

describe("the census: a surface parked off canvas says what makes it inert", () => {
  const found = SHEETS.flatMap((f) => offCanvasSelectors(read(f)));

  it("reads the rail's off-canvas rule (positive control)", () => {
    expect(found).toContain(".deck > .rail");
  });

  it("every off-canvas rule is one this file names, and every name is still a rule", () => {
    expect([...new Set(found)].sort()).toEqual(Object.keys(PARKED).sort());
  });

  // The thread squares' chip case (today's `ThreadMarks` ThreadTip, drawn by no part of the new shell) left with it: the
  // kit's squares draw no chip (`packages/ui/test/mail/lists.test.tsx`, "ReadSquares"). `.tm-tip` stays in PARKED while
  // its rule stands in app.css.
});

/*
 * THE DRAWER IN THE FRAME. Under 840 px the whole rail is More's sheet over the app; at a desktop width it stands at
 * the side. Today's drawer cases, with their probe re-read: the sheet is the drawer, the dock's More its toggle, and a
 * window's width is its innerWidth (the frame's plan reads it).
 */
const atWidth = (width: number): void => { Object.defineProperty(window, "innerWidth", { configurable: true, value: width }); };
const sheet = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"][aria-label="More"]');
/** Parked: not in the tree, or inert in it. */
const parked = (): boolean => sheet() === null || sheet()!.closest("[inert]") !== null;
const more = (): HTMLElement => [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.getAttribute("aria-label") === "More")!;
const standingRail = (): HTMLElement => document.querySelector<HTMLElement>("nav.oh-rail")!;

/** Onto More the keyboard way, then Enter presses it as a browser does (a click). */
async function pressMore(): Promise<HTMLElement> {
  const toggle = more();
  for (let i = 0; i < 40 && document.activeElement !== toggle; i += 1) await tab();
  expect(document.activeElement, "Tab never reached the drawer's toggle").toBe(toggle);
  await key("Enter");
  await act(async () => { toggle.click(); });
  await settle();
  return toggle;
}

describe("the navigation drawer at 390px, in the frame", () => {
  afterEach(() => { atWidth(1024); });

  /* The closed sheet is not in the tree; More, which opens it, is a Tab stop named More. */
  it("closed: out of the Tab order and the tree, and its toggle says so", async () => {
    atWidth(390);
    await shell();
    expect(parked(), "the closed drawer is in the tree and not inert").toBe(true);
    expect(stops().filter((s) => sheet()?.contains(s) ?? false), "Tab stops inside the closed drawer").toEqual([]);
    expect(stops().filter((s) => standingRail()?.contains(s) ?? false), "a rail stands open at 390").toEqual([]);
    const toggle = more();
    expect(toggle, "no More to open the drawer").toBeTruthy();
    expect(stops()).toContain(toggle);
    expect(toggle.hasAttribute("aria-expanded")).toBe(false);
  });

  it("open: focus goes in, Tab and Shift+Tab stay, Escape parks it again", async () => {
    atWidth(390);
    await shell();
    const toggle = await pressMore();
    expect(sheet() !== null, "the toggle did not open the drawer").toBe(true);
    expect(sheet()!.closest("[inert]") !== null).toBe(false);
    // More opens a modal dialog, which says itself; the toggle, inert behind it, says no state.
    expect(sheet()!.getAttribute("aria-modal")).toBe("true");
    expect(toggle.hasAttribute("aria-expanded")).toBe(false);
    expect(sheet()!.contains(document.activeElement), "focus stayed behind the open drawer").toBe(true);
    for (let i = 0; i < 30; i += 1) {
      await tab();
      expect(sheet()?.contains(document.activeElement), `Tab ${i + 1} left the drawer`).toBe(true);
    }
    for (let i = 0; i < 30; i += 1) {
      await tab(true);
      expect(sheet()?.contains(document.activeElement), `Shift+Tab ${i + 1} left the drawer`).toBe(true);
    }
    await key("Escape");
    await settle();
    expect(sheet() !== null).toBe(false);
    expect(parked()).toBe(true);
    expect(sheet()?.contains(document.activeElement) ?? false, "focus stayed in the parked drawer").toBe(false);
  });

  it("at a desktop width the standing rail is never inert (control)", async () => {
    wide = true;
    atWidth(1440);
    await shell();
    expect(standingRail().closest("[inert]") !== null).toBe(false);
    expect(stops().some((s) => standingRail().contains(s))).toBe(true);
  });
});
