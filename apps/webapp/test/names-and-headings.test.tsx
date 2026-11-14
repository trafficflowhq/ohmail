/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * NAMES CARRY THE WORDS, ONE HEADING LEVEL PER VIEW. A control that
 * draws its key names itself by its words ("Reply", not "Reply r"), its keycap is hidden from the
 * tree and the key is stated in `aria-keyshortcuts`. An open letter's subject is a level-2 heading
 * under the view's h1, as the Screener's held mail is. The accessible name here is the one every
 * reader computes: `aria-label`, else the text outside `aria-hidden` subtrees.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.setConfig({ testTimeout: 30_000 });

let roots: Root[] = [];

beforeEach(() => {
  window.location.hash = "";
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
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
  for (const root of roots) await act(async () => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  vi.restoreAllMocks();
});

async function mount(node: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"), children: node }));
  });
  await settleFirstPaint();
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return container;
}

async function shell(hash: string): Promise<HTMLElement> {
  window.location.hash = hash;
  const { AppShell } = await import("./_todays-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  return mount(h(ThemeProvider, { storageKey: null, children: h(ToastHost, { children: h(AppShell, { demo: true }) }) }));
}

function nameOf(el: Element): string {
  const label = el.getAttribute("aria-label");
  if (label !== null) return label.trim();
  const walk = (n: Node): string => {
    if (n.nodeType === 3) return n.textContent ?? "";
    if (!(n instanceof Element) || n.getAttribute("aria-hidden") === "true") return "";
    return [...n.childNodes].map(walk).join("");
  };
  return walk(el).replace(/\s+/g, " ").trim();
}

/** Every control that draws a keycap, with the name a reader hears and the keys it states. */
function keyedControls(root: ParentNode): Array<{ name: string; caps: string[]; keys: string | null }> {
  return [...root.querySelectorAll<HTMLElement>("button, a[href]")]
    .filter((b) => b.querySelector("kbd") !== null)
    .map((b) => ({
      name: nameOf(b),
      caps: [...b.querySelectorAll("kbd")].map((k) => (k.textContent ?? "").trim()),
      keys: b.getAttribute("aria-keyshortcuts"),
    }));
}

describe("a control's name is its words (R21-08)", () => {
  it("an open letter's controls: no keycap in any name, and the key stated beside it", async () => {
    const root = await shell("#/ohbox");
    const row = root.querySelectorAll<HTMLElement>(".view .row[data-id]")[1]!;
    await act(async () => { row.click(); });
    for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const controls = keyedControls(root);
    const names = new Set(controls.map((c) => c.name));
    for (const want of ["Reply", "Later", "Park", "Screening"]) expect(names, `no control named "${want}"`).toContain(want);
    const withCap = controls.filter((c) => c.caps.some((cap) => cap !== "" && c.name.endsWith(cap)));
    expect(withCap.map((c) => `${c.name} (${c.caps.join(" ")})`), "names that end in their keycap").toEqual([]);
    const byName = Object.fromEntries(controls.map((c) => [c.name, c.keys]));
    expect(byName.Reply).toBe("r");
    expect(byName.Forward).toBe("Shift+F");
    /* The rail's Compose and Search print no keycap at rest, and state their keys all the same, as 1.0's did. */
    const inRail = (want: string) =>
      [...root.querySelectorAll<HTMLElement>("nav button, nav a")].find((b) => nameOf(b) === want);
    expect(inRail("Compose"), "the rail has no control named Compose").toBeTruthy();
    expect(inRail("Compose")!.getAttribute("aria-keyshortcuts")).toBe("c");
    expect(inRail("Search"), "the rail has no control named Search").toBeTruthy();
    expect(inRail("Search")!.getAttribute("aria-keyshortcuts")).toBe("/");
  });

  it("a keycap that is a control's only text stays its name (control)", async () => {
    const { Kbd } = await import("@ohmail/ui");
    const root = await mount(h("div", null,
      h("button", { type: "button", id: "only" }, h(Kbd, { shortcut: "?", children: "?" })),
      h("button", { type: "button", id: "words" }, "Help ", h(Kbd, { shortcut: "?", children: "?" })),
      h("p", { id: "prose" }, "Press ", h(Kbd, { children: "?" }))));
    expect(nameOf(root.querySelector("#only")!)).toBe("?");
    expect(root.querySelector("#only")!.hasAttribute("aria-keyshortcuts")).toBe(false);
    expect(nameOf(root.querySelector("#words")!)).toBe("Help");
    expect(root.querySelector("#words")!.getAttribute("aria-keyshortcuts")).toBe("?");
    expect(root.querySelector("#prose kbd")!.hasAttribute("aria-hidden")).toBe(false);
  });
});

describe("one heading level per view (R21-09)", () => {
  const levels = (root: ParentNode): number[] => [...root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6, [role=heading]")]
    .map((el) => Number(el.getAttribute("aria-level") ?? el.tagName.slice(1)));

  it("an open letter's subject is a level-2 heading under the view's h1", async () => {
    const root = await shell("#/ohbox");
    const row = root.querySelectorAll<HTMLElement>(".view .row[data-id]")[1]!;
    await act(async () => { row.click(); });
    for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const subject = root.querySelector(".read-col .msg-subject");
    expect(subject?.getAttribute("role")).toBe("heading");
    expect(subject?.getAttribute("aria-level")).toBe("2");
    const view = root.querySelector(".view")!;
    const seen = levels(view);
    expect(seen[0]).toBe(1);
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]! - seen[i - 1]!, `a skipped level in ${seen.join(",")}`).toBeLessThanOrEqual(1);
  });

  it("the Screener's held mail is level 2 under its h1, not 3", async () => {
    const root = await shell("#/screener/screened");
    const view = root.querySelector(".view")!;
    const seen = levels(view);
    expect(seen[0]).toBe(1);
    expect(seen.slice(1).length, "no held mail heading read").toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]! - seen[i - 1]!, `a skipped level in ${seen.join(",")}`).toBeLessThanOrEqual(1);
  });
});
