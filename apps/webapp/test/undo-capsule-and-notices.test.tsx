/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost, useToast, type ToastFn } from "@ohmail/ui";
import messages from "../messages/en.json";
import { createUndoDoor } from "@ohmail/app-logic/press/undo-door";

/**
 * THE NOTICES AND THE UNDO CAPSULE, READ AS A SCREEN READER READS THEM. A
 * notice is a new node in its polite region every time it is raised, a repeat included, and a
 * faded one leaves the region. The capsule's Undo names the key that presses it from anywhere
 * (`z`). Focus never falls to the page body around the capsule: not when its Undo is pressed,
 * not when a focused Undo's window ends. Timers are fake; keys go to the focused element.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= { escape: (v: string) => String(v) };
Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(async () => { await import("../app/shell/AppShell.js"); }, 120_000);

beforeEach(() => {
  vi.useFakeTimers();
  window.location.hash = "";
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } }) as unknown as MediaQueryList;
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {} unobserve(): void {} disconnect(): void {}
    takeRecords(): [] { return []; }
  };
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function settle(n = 8): Promise<void> {
  for (let i = 0; i < n; i += 1) await act(async () => { await Promise.resolve(); });
}
const tick = async (ms: number): Promise<void> => { await act(async () => { vi.advanceTimersByTime(ms); }); await settle(); };

async function render(node: React.ReactElement): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(node); });
  await settle();
}

/** A bare host with a handle on its toast, for the region cases. */
async function bareHost(): Promise<ToastFn> {
  let show: ToastFn | null = null;
  function Grab(): null { show = useToast(); return null; }
  await render(h(ToastHost, { children: h(Grab) }));
  return show!;
}

const noticeRegion = (): HTMLElement => host!.querySelector<HTMLElement>(".toast:not(.toast-held)")!;

describe("a notice is heard every time, and leaves when it fades (R22-05)", () => {
  it("a faded notice is gone from its region", async () => {
    const show = await bareHost();
    await act(async () => { show("The mail is back where it was."); });
    expect(noticeRegion().textContent).toBe("The mail is back where it was.");
    await tick(2600 + 300 + 50);
    expect(noticeRegion().textContent, "the faded sentence stays in the polite region").toBe("");
  });

  it("the same words raised again are a new node, standing or faded", async () => {
    const show = await bareHost();
    const heard: number[] = [];
    let n = 0;
    const watch = new MutationObserver((records) => {
      n += records.filter((r) => r.type === "childList" && r.addedNodes.length > 0 || r.type === "characterData").length;
    });
    watch.observe(noticeRegion(), { childList: true, subtree: true, characterData: true });
    for (const wait of [0, 500, 4000]) {
      n = 0;
      await act(async () => { show("That delete could not be saved."); });
      await settle();
      heard.push(n);
      await tick(wait);
    }
    watch.disconnect();
    expect(heard.map((c) => c > 0), `announcements per raise: ${heard.join(",")}`).toEqual([true, true, true]);
  });
});

describe("the capsule's Undo names its key (R22-06)", () => {
  it("through the undo door: the button is named Undo and states z", async () => {
    const show = await bareHost();
    const door = createUndoDoor(show);
    await act(async () => { door.toast("1 message moved.", { action: "Undo", duration: 8000, undo: true, onAction: () => {} }); });
    await settle();
    const button = host!.querySelector<HTMLElement>(".toast-held .toast-act")!;
    expect(button.getAttribute("aria-keyshortcuts")).toBe("z");
    expect(button.textContent?.trim()).toBe("Undo");
  });

  it("an action that is not an Undo names no key (control)", async () => {
    const show = await bareHost();
    const door = createUndoDoor(show);
    await act(async () => { door.toast("Your rule keeps 3 there.", { action: "Remove the rule", duration: 8000, onAction: () => {} }); });
    await settle();
    expect(host!.querySelector(".toast-held .toast-act")!.hasAttribute("aria-keyshortcuts")).toBe(false);
  });
});

/* ── through the shell ───────────────────────────────────────────────────────────────────── */

async function shell(hash: string): Promise<void> {
  window.location.hash = hash;
  const { AppShell } = await import("../app/shell/AppShell.js");
  await render(h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
    children: h(ThemeProvider, { storageKey: null, children: h(ToastHost, { children: h(AppShell, { demo: true }) }) }),
  }));
  await tick(50);
}

async function key(k: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  await act(async () => { (document.activeElement ?? document.body).dispatchEvent(e); });
  await settle(2);
  return e;
}
const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex], [contenteditable="true"]';
async function tab(): Promise<void> {
  const from = (document.activeElement ?? document.body) as HTMLElement;
  const e = await key("Tab");
  if (e.defaultPrevented) return;
  const stops = [...document.querySelectorAll<HTMLElement>(TABBABLE)].filter((s) => s.tabIndex >= 0 && s.closest("[inert]") === null);
  const to = stops.find((s) => s !== from && (from.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
  await act(async () => { to?.focus(); });
}
const onBody = (): boolean => document.activeElement === null || document.activeElement === document.body;

/** A row's delete through the keyboard, then Tab to the capsule's Undo. */
async function deleteAndReachUndo(): Promise<HTMLElement> {
  await shell("#/ohbox");
  await key("j");
  await key("ArrowLeft");
  await key("ArrowRight");
  expect((document.activeElement as HTMLElement | null)?.matches(".row[data-id]"), "not on a row").toBe(true);
  await key("Backspace");
  const undo = (): HTMLElement | null => host!.querySelector<HTMLElement>(".toast-held .toast-act");
  expect(undo(), "no Undo capsule after Backspace").not.toBeNull();
  for (let i = 0; i < 80 && document.activeElement !== undo(); i += 1) await tab();
  expect(document.activeElement, "Tab never reached the Undo").toBe(undo());
  return undo()!;
}

describe("focus never falls to the page around the capsule (R22-06)", () => {
  it("Enter on the Undo: the capsule goes and focus lands on the list", async () => {
    const undo = await deleteAndReachUndo();
    await key("Enter");
    await act(async () => { undo.click(); });
    await settle();
    expect(host!.querySelector(".toast-held .toast-act"), "the capsule stayed").toBeNull();
    expect(onBody(), "focus fell to the page body").toBe(false);
  });

  it("a focused Undo whose window ends: focus lands on the list", async () => {
    await deleteAndReachUndo();
    await tick(30_000);
    expect(host!.querySelector(".toast-held .toast-act"), "the capsule outlived its window").toBeNull();
    expect(onBody(), "focus fell to the page body").toBe(false);
  });
});
