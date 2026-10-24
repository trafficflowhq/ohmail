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
  const { AppShell } = await import("../app/shell/AppShell.js");
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

  it("the thread squares' chip, where it stands before it is placed, is no Tab stop, no name and no target", async () => {
    const { ThreadTip } = await import("../app/shell/ThreadMarks.js");
    const style = document.createElement("style");
    style.textContent = `.tm-tip{${ruleOf(read("../app/app.css"), ".tm-tip")}}`;
    document.head.appendChild(style);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const m = {
      id: "p1", threadId: "T", subject: "Q3 plan", from: { name: "Lena", address: "lena@example.invalid" },
      date: "2026-10-22T09:00:00.000Z", unread: true, folder: "INBOX",
    } as unknown as Parameters<typeof ThreadTip>[0]["m"];
    await act(async () => {
      root.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(ThreadTip, { m, place: "left" }) }));
    });
    const chip = document.querySelector<HTMLElement>(".tm-tip")!;
    expect(chip.textContent, "the chip did not render").toMatch(/^Lena/);
    expect(chip.getAttribute("aria-hidden"), "the chip is named to assistive tech").toBe("true");
    expect(stops().filter((s) => chip.contains(s)), "Tab stops inside the chip").toEqual([]);
    expect(getComputedStyle(chip).pointerEvents, "the chip takes the pointer").toBe("none");
    style.remove();
  });
});

describe("the navigation drawer at 390px", () => {
  it("closed: out of the Tab order and the tree, and its toggle says so", async () => {
    await shell();
    expect(rail().hasAttribute("inert"), "the closed rail is not inert").toBe(true);
    expect(stops().filter((s) => rail().contains(s)), "Tab stops inside the closed rail").toEqual([]);
    const toggle = document.querySelector<HTMLElement>(".topbar .tb-btn")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(rail().id);
    expect(rail().id).not.toBe("");
  });

  it("open: focus goes in, Tab and Shift+Tab stay, Escape parks it again", async () => {
    await shell();
    const toggle = await pressToggle();
    expect(rail().classList.contains("open"), "the toggle did not open the drawer").toBe(true);
    expect(rail().hasAttribute("inert")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(rail().contains(document.activeElement), "focus stayed behind the open drawer").toBe(true);
    for (let i = 0; i < 30; i += 1) {
      await tab();
      expect(rail().contains(document.activeElement), `Tab ${i + 1} left the drawer`).toBe(true);
    }
    for (let i = 0; i < 30; i += 1) {
      await tab(true);
      expect(rail().contains(document.activeElement), `Shift+Tab ${i + 1} left the drawer`).toBe(true);
    }
    await key("Escape");
    await settle();
    expect(rail().classList.contains("open")).toBe(false);
    expect(rail().hasAttribute("inert")).toBe(true);
    expect(rail().contains(document.activeElement), "focus stayed in the parked drawer").toBe(false);
  });

  it("at a desktop width the standing rail is never inert (control)", async () => {
    wide = true;
    await shell();
    expect(rail().hasAttribute("inert")).toBe(false);
    expect(stops().some((s) => rail().contains(s))).toBe(true);
  });
});
