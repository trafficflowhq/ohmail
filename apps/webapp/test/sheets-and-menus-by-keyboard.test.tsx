/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";
import { Row, Rows } from "@ohmail/ui/mail";
import { FocusFollows } from "@ohmail/app-logic/keys/focus-follows";

/**
 * ONE DISCIPLINE FOR SHEETS AND MENUS, through the shipped
 * shell on the demo world, by keys only. A sheet is modal while open; focus goes in and returns to
 * its opener; a menu closes when focus leaves it; the shortcut list scrolls by keyboard; a
 * collapsed doorbell is no Tab stop; the palette and Search give focus back to what opened them.
 * Tab's own move is emulated in document order when nothing prevented it.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.setConfig({ testTimeout: 30_000 });

let roots: Root[] = [];
let phone = false;

beforeEach(() => {
  window.location.hash = "";
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: phone && /max-width:\s*(1023\.98|699\.98|721|640)px/.test(query) && !/min-width/.test(query),
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
  phone = false;
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  vi.restoreAllMocks();
});

async function shell(hash = "", minRows = 3): Promise<void> {
  if (hash) window.location.hash = hash;
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
  await waitFor(() => rows().length >= minRows, "the demo list never grew rows");
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    if (cond()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  expect(cond(), what).toBe(true);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

/* A row of a list: today's row, or the Ohbox's, an option of its listbox; the cursor's is `.sel` there, open here. */
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".view :is(.row, [role=option])[data-id]")];
const CURSOR = ".view :is(.row.sel, [role=option][data-open])[data-id]";
const focused = (): HTMLElement | null => document.activeElement as HTMLElement | null;
const where = (): string => {
  const el = focused();
  if (!el || el === document.body) return "the page body";
  return `<${el.tagName.toLowerCase()} class="${el.className}">${(el.textContent ?? "").trim().slice(0, 40)}`;
};

async function key(k: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  await act(async () => { (document.activeElement ?? document.body).dispatchEvent(e); });
  return e;
}

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex], [contenteditable="true"]';
const stops = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(TABBABLE)]
  .filter((s) => s.tabIndex >= 0 && s.closest("[inert]") === null);

async function tab(shift = false): Promise<void> {
  const from = (document.activeElement ?? document.body) as HTMLElement;
  const e = await key("Tab", { shiftKey: shift });
  if (e.defaultPrevented) return;
  const now = (document.activeElement ?? document.body) as HTMLElement;
  const all = stops();
  const start = now !== from ? now : from;
  const after = (s: HTMLElement): boolean => (start.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  const to = shift ? all.filter((s) => s !== start && !after(s) && !s.contains(start)).pop() : all.find((s) => s !== start && after(s));
  await act(async () => { to?.focus(); });
}

/** Tab until `match` holds, bounded, as a person reaches a control. */
async function tabTo(match: (el: HTMLElement) => boolean, what: string, limit = 80): Promise<HTMLElement> {
  for (let i = 0; i < limit && !(focused() && match(focused()!)); i += 1) await tab();
  expect(focused() && match(focused()!), `Tab never reached ${what}; focus is on ${where()}`).toBe(true);
  return focused()!;
}

/** Enter on the focused button, as a browser presses it: the keydown, then its click. */
async function enter(): Promise<void> {
  const el = focused();
  await key("Enter");
  await act(async () => { el?.click(); });
  await settle();
}

async function standOn(index: number): Promise<string> {
  const id = rows()[index]!.dataset.id!;
  for (let i = 0; i < 12 && document.querySelector<HTMLElement>(CURSOR)?.dataset.id !== id; i += 1) await key("j");
  await key("ArrowLeft");
  await key("ArrowRight");
  expect(focused()?.dataset.id, `could not stand on row ${index}: focus is on ${where()}`).toBe(id);
  return id;
}

describe("the shortcut sheet's list (R21-03)", () => {
  it("is a named Tab stop, and there the scroll keys scroll the sheet instead of closing it", async () => {
    await shell();
    await standOn(1);
    const cursor = document.querySelector<HTMLElement>(CURSOR)!.dataset.id;
    await key("?");
    await settle();
    await tab();
    const list = document.querySelector<HTMLElement>(".ks-cols");
    expect(focused(), `Tab from the Close button went to ${where()}`).toBe(list);
    expect(list!.getAttribute("role")).toBe("region");
    expect(document.getElementById(list!.getAttribute("aria-labelledby") ?? "")?.textContent).toContain("Keyboard shortcuts");
    for (const k of ["PageDown", "ArrowDown", "End", "PageUp", "Home", " "]) {
      const e = await key(k);
      expect(document.querySelector(".ks"), `${k} closed the sheet`).not.toBeNull();
      expect(e.defaultPrevented, `${k} was prevented, so it cannot scroll`).toBe(false);
    }
    expect(document.querySelector<HTMLElement>(CURSOR)!.dataset.id, "a scroll key moved the list behind").toBe(cursor);
  });

  it("any other key still closes it (control), and its headings sit under one h2", async () => {
    await shell();
    await standOn(1);
    await key("?");
    await settle();
    expect(document.querySelector(".ks h2")?.textContent).toContain("Keyboard shortcuts");
    expect(document.querySelectorAll(".ks h3").length).toBeGreaterThan(1);
    expect(document.querySelectorAll(".ks h4").length).toBe(0);
    await key("F" + "7");
    expect(document.querySelector(".ks")).toBeNull();
  });
});

describe("the Screening sheet (R21-04)", () => {
  it("is modal, holds Tab both ways, and its opener states it", async () => {
    await shell();
    await standOn(1);
    await key("s");
    await settle();
    const sheet = document.querySelector<HTMLElement>(".senderm")!;
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    const opener = document.querySelector<HTMLElement>(".read-col .abar-row .abar-screen")!;
    expect(opener.getAttribute("aria-haspopup")).toBe("dialog");
    expect(opener.getAttribute("aria-expanded")).toBe("true");
    expect(opener.getAttribute("aria-controls")).toBe(sheet.id);
    for (let i = 0; i < 14; i += 1) {
      await tab();
      expect(sheet.contains(focused()), `Tab ${i + 1} left the sheet for ${where()}`).toBe(true);
    }
    for (let i = 0; i < 14; i += 1) {
      await tab(true);
      expect(sheet.contains(focused()), `Shift+Tab ${i + 1} left the sheet for ${where()}`).toBe(true);
    }
    await key("Escape");
    await settle();
    expect(document.querySelector(".senderm")).toBeNull();
    expect(opener.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("a letter's menus close when focus leaves them (R21-05)", () => {
  for (const [name, sel] of [["More", ".read-col .abar-row .abar-more"], ["Message actions", ".read-col .msg-more"]] as const) {
    it(`${name}: Tab closes it, and focus does not fall to the page`, async () => {
      await shell();
      await standOn(1);
      const trigger = await tabTo((el) => el.matches(sel), name);
      await enter();
      expect(document.querySelector('[role="menu"]'), `${name} did not open`).not.toBeNull();
      expect(document.querySelector('[role="menu"]')!.contains(focused()), `the menu opened with focus on ${where()}`).toBe(true);
      await tab();
      await settle();
      expect(document.querySelector('[role="menu"]'), `${name} stayed drawn after Tab`).toBeNull();
      expect(focused() === null || focused() === document.body, `focus fell to ${where()}`).toBe(false);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });
  }

  it("Escape still closes More back onto its trigger (control)", async () => {
    await shell();
    await standOn(1);
    const trigger = await tabTo((el) => el.matches(".read-col .abar-row .abar-more"), "More");
    await enter();
    await key("Escape");
    await settle();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(focused()).toBe(trigger);
  });
});

describe("the phone's letter sheet (R21-06)", () => {
  it("takes focus, holds Tab both ways, and Escape returns it to the row", async () => {
    phone = true;
    await shell("#/triage", 1);
    const row = await tabTo((el) => el.matches(".view .row[data-id]"), "a row");
    const id = row.dataset.id;
    await enter();
    const sheet = document.querySelector<HTMLElement>(".reader");
    expect(sheet, "Enter on the row opened no sheet").not.toBeNull();
    expect(sheet!.getAttribute("aria-modal")).toBe("true");
    expect(sheet!.contains(focused()), `the sheet opened with focus on ${where()}`).toBe(true);
    for (let i = 0; i < 24; i += 1) {
      await tab();
      expect(sheet!.contains(focused()), `Tab ${i + 1} reached ${where()} behind the sheet`).toBe(true);
    }
    for (let i = 0; i < 24; i += 1) {
      await tab(true);
      expect(sheet!.contains(focused()), `Shift+Tab ${i + 1} reached ${where()} behind the sheet`).toBe(true);
    }
    await key("Escape");
    await settle();
    expect(document.querySelector(".reader")).toBeNull();
    expect(focused()?.dataset.id, `after Escape focus is on ${where()}`).toBe(id);
  });
});

describe("the collapsed Screener doorbell (R18-01)", () => {
  it("is no Tab stop and no node in the tree; standing, it is both (control)", async () => {
    const { Doorbell } = await import("@ohmail/ui");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const bell = (gone: boolean) => h(Doorbell, { initials: gone ? [] : ["A"], message: "x", actionLabel: "Screener", onPress: () => {}, gone, ariaLabel: "bell" });
    await act(async () => { root.render(bell(true)); });
    const b = container.querySelector<HTMLElement>("button.doorbell")!;
    expect(b.tabIndex).toBe(-1);
    expect(b.getAttribute("aria-hidden")).toBe("true");
    await act(async () => { root.render(bell(false)); });
    expect(b.tabIndex).toBe(0);
    expect(b.hasAttribute("aria-hidden")).toBe(false);
  });
});

describe("a surface that closes after the page has gone (the unhandled errors at the base)", () => {
  it("throws nothing when the document lost its body before the return ran", async () => {
    const { useFocusFollows } = await import("@ohmail/app-logic/keys/focus-follows");
    const errors: unknown[] = [];
    vi.stubGlobal("queueMicrotask", (cb: () => void) => { try { cb(); } catch (e) { errors.push(e); } });
    function Sheet(): React.ReactElement {
      const ref = React.useRef<HTMLDivElement>(null);
      useFocusFollows(ref);
      return h("div", { ref, role: "dialog", "aria-modal": "true" }, h("button", { type: "button" }, "Close"));
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(h(Sheet)); });
    const body = document.body;
    await act(async () => { document.documentElement.removeChild(body); });
    await act(async () => { root.unmount(); });
    document.documentElement.appendChild(body);
    vi.unstubAllGlobals();
    expect(errors.map(String)).toEqual([]);
  });
});

describe("Escape gives focus back to what opened the palette and Search (R18-02)", () => {
  it("Search, opened from the rail, returns to the rail's Search row", async () => {
    await shell();
    await tabTo((el) => el.matches("[data-rail-id] button") && /Search/.test(el.textContent ?? ""), "the rail's Search row");
    await enter();
    await waitFor(() => document.querySelector(".view-search") !== null, "Search did not open");
    await key("Escape");
    await waitFor(() => document.querySelector(".view-search") === null, "Escape did not leave Search");
    await settle();
    const now = focused();
    expect(now?.matches("[data-rail-id] button") && /Search/.test(now.textContent ?? ""), `after Escape focus is on ${where()}`).toBe(true);
  });

  it("the palette, opened from a rail row, returns to that row", async () => {
    await shell();
    const opener = await tabTo((el) => el.matches("[data-rail-id] button") && /History/.test(el.textContent ?? ""), "the rail's History row");
    await key("k", { ctrlKey: true });
    await settle();
    expect(document.querySelector(".palette"), "Ctrl+K did not open the palette").not.toBeNull();
    await key("Escape");
    await settle();
    expect(document.querySelector(".palette")).toBeNull();
    expect(focused(), `after Escape focus is on ${where()}`).toBe(opener);
  });
});

describe("the composer, closed, gives the keyboard back to the list it left (R18-02, a view that went while it stood)", () => {
  /* `c` leaves the Ohbox for the composer and Escape comes back: the control that opened it is gone with the view, so
     the keyboard goes to the row it stood on, else the cursor's row, else the list's own stop. Never a control of the
     list's head, where the next Enter would press it. */
  const compose = async (): Promise<void> => {
    await key("c");
    await waitFor(() => document.querySelector(".view-ohbox") === null, "c did not open the composer");
    await settle();
    await key("Escape");
    await waitFor(() => document.querySelector(".view-ohbox") !== null && rows().length > 0, "Escape did not come back to the Ohbox");
    await settle();
  };
  const LIST = ".view-ohbox :is(.scroller, .ob-scroll)";

  it("opened from the cursor's row: back on that row", async () => {
    await shell("#/ohbox");
    const id = await standOn(1);
    await compose();
    expect(focused()?.dataset.id, `after the composer closed focus is on ${where()}`).toBe(id);
    expect(focused()?.matches(CURSOR)).toBe(true);
  });

  it("opened from a control of the head with a letter open: on the cursor's row", async () => {
    await shell("#/ohbox");
    const id = await standOn(1);
    const head = [...document.querySelectorAll<HTMLElement>(".view-ohbox :is(.oh-listhead-aside, .vhead) button:not([disabled])")].pop()!;
    await act(async () => { head.focus(); });
    expect(focused(), "the premise: a control of the head holds the keyboard").toBe(head);
    await compose();
    expect(focused()?.dataset.id, `after the composer closed focus is on ${where()}`).toBe(id);
  });

  it("opened from a row that holds the keyboard with no letter open: back on that row", async () => {
    await shell("#/ohbox");
    expect(document.querySelector(CURSOR), "the premise: no cursor").toBeNull();
    const row = rows()[2]!;
    const id = row.dataset.id;
    await act(async () => { row.focus(); });
    expect(focused(), "the premise: the row holds the keyboard").toBe(row);
    await compose();
    expect(focused()?.dataset.id, `after the composer closed focus is on ${where()}`).toBe(id);
  });

  it("opened with no cursor in the list: on the list's own stop", async () => {
    await shell("#/ohbox");
    expect(document.querySelector(CURSOR), "the premise: no cursor").toBeNull();
    await compose();
    expect(focused()?.matches(LIST), `after the composer closed focus is on ${where()}`).toBe(true);
  });
});

describe("the shell's focus rule over the Ohbox's own rows, mounted alone (focus-follows)", () => {
  /* In the shipped shell the list's keeper lands a row a verb took away before the rule beneath it is asked; the rule
     must still say the same over the new list: a cursor row taken away goes to the cursor, else the list's own stop,
     never a neighbour, which would wear the ring while the verbs act elsewhere. */
  it("a focused row taken away with no cursor in the list: the keyboard on the list's own stop", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    let stop: HTMLDivElement | null = null;
    const keep = (el: HTMLDivElement | null): void => { if (el !== null) stop = el; };
    const draw = (ids: readonly string[]) => h("div", { className: "view" },
      h(FocusFollows),
      h("div", { className: "ob-scroll", tabIndex: -1, ref: keep },
        h(Rows, {
          label: "New", many: true,
          children: ids.map((id) => h(Row, {
            key: id, who: id, people: [], subject: id, listing: { name: id, selected: false }, mark: { id },
          })),
        })));
    await act(async () => { root.render(draw(["a", "b", "c"])); });
    const b = [...host.querySelectorAll<HTMLElement>("[role=option]")].find((o) => o.getAttribute("aria-label") === "b")!;
    await act(async () => { b.focus(); });
    expect(document.activeElement, "the premise: the row holds the keyboard").toBe(b);
    await act(async () => { root.render(draw(["a", "c"])); });
    await settle();
    const at = document.activeElement as HTMLElement | null;
    expect(at, `after the row went the keyboard is on ${at?.getAttribute("aria-label") ?? at?.tagName}`).toBe(stop);
  });
});
