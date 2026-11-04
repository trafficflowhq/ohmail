/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { keymap } from "@tiptap/pm/keymap";
import messages from "../messages/en.json";
import { editorOf, typeInto } from "./fixtures/rich-editor-driver";

/**
 * ESCAPE IN THE REPLY OR COMPOSE BODY CLOSES IT, AS IT DID IN 0.25.0.
 *
 * ProseMirror prevents every Escape (`captureKeyDown`, keyCode 27) and the keymap leaves a
 * prevented key alone, so from inside the editor the binding that closes the reply never ran.
 * The editor now prevents Escape only when one of its own bindings takes it. Every press here
 * carries keyCode 27 as a browser's does: without it ProseMirror never prevents, and the case
 * passes for nothing.
 */
(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const { KeymapProvider, useKeyBindings } = await import("../app/shell/keymap");
const { RichEditor } = await import("../app/shell/RichEditor");
const { EMPTY_RICH } = await import("../app/shell/rich-text");

let roots: Root[] = [];

beforeEach(() => {
  window.location.hash = "";
  try { window.localStorage.clear(); } catch { /* storage blocked; the shell still boots */ }
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null, dispatchEvent: () => false,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
    }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  // Off the Ohbox first: its drag hook's cleanup reads `document.body`, which a document root's
  // unmount has already taken away.
  if (document.querySelector(".view-ohbox")) {
    const { go } = await import("../app/shell/routing");
    await act(async () => { go("drafts"); window.dispatchEvent(new HashChangeEvent("hashchange")); });
    await waitFor(() => document.querySelector(".view-ohbox") == null, "teardown could not leave the Ohbox");
  }
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  // A document-level root takes `<html>` with it on unmount; the next case needs one back.
  if (!document.documentElement) {
    const html = document.createElement("html");
    html.append(document.createElement("head"), document.createElement("body"));
    document.appendChild(html);
  }
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

/** Bounded by real time, not a tick count: the editor's lazy import outlasts any count under load. */
async function waitFor(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() <= deadline) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  expect(cond(), what).toBe(true);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

/** A keydown as a browser types it: the key AND its keyCode, bubbling and cancelable. */
async function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const keyCode = key === "Escape" ? 27 : key === "Enter" ? 13 : 0;
  const e = new KeyboardEvent("keydown", { key, keyCode, bubbles: true, cancelable: true, ...init } as KeyboardEventInit);
  await act(async () => { target.dispatchEvent(e); });
  return e;
}

/** The shipped shell, rendered the way the App Router renders it: React's root IS `document`. */
async function shellOnDocument(): Promise<void> {
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const root = createRoot(document as unknown as Element);
  roots.push(root);
  await act(async () => {
    root.render(
      h("html", null, h("head"), h("body", null,
        h(NextIntlClientProvider, {
          locale: "en",
          messages,
          timeZone: "UTC",
          now: new Date("2026-08-02T09:00:00.000Z"),
          children: h(ThemeProvider, {
            storageKey: null,
            children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
          }),
        }))),
    );
  });
  for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); });
}

const replySurface = (): HTMLElement | null => document.querySelector(".reply-editor .rte-surface");
const compose = (): Element | null => document.querySelector(".view-compose");
const composeSurface = (): HTMLElement | null => document.querySelector(".compose-editor .rte-surface");

async function openReply(): Promise<HTMLElement> {
  await waitFor(() => document.querySelector(".view-ohbox") != null, "the shell did not open on the Ohbox");
  await press(document, "j");
  await press(document, "r");
  await waitFor(() => replySurface() != null, "`r` did not open the inline reply");
  return replySurface()!;
}

async function openCompose(): Promise<HTMLElement> {
  await press(document, "c");
  await waitFor(() => compose() != null, "`c` did not open Compose");
  await waitFor(() => composeSurface() != null, "the compose body never mounted");
  return composeSurface()!;
}

// The whole shell boots per case: vitest's 5 s default is shorter than one boot on a loaded host.
describe("Escape in the shipped reply and compose bodies", { timeout: 30_000 }, () => {
  it("CONTROL: Escape in the address suggestions closes only the suggestions", async () => {
    await shellOnDocument();
    await openCompose();
    const to = document.querySelector<HTMLInputElement>("#compose-to")!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    const shown = (): number => document.querySelectorAll(".view-compose .rcp-opt").length;
    for (const prefix of ["a", "e", "m", "s"]) {
      await act(async () => { to.focus(); setter.call(to, prefix); to.dispatchEvent(new Event("input", { bubbles: true })); });
      if (shown() > 0) break;
    }
    expect(shown(), "no address suggestion opened — the case has nothing to close").toBeGreaterThan(0);
    await press(to, "Escape");
    await settle();
    expect(shown(), "Escape left the address suggestions open").toBe(0);
    expect(compose(), "one Escape in the suggestions closed the whole compose view").not.toBeNull();
  });

  it("an empty inline reply closes on Escape", async () => {
    await shellOnDocument();
    const surface = await openReply();
    await press(surface, "Escape");
    await waitFor(() => document.querySelector(".reply-editor") == null, "Escape in the reply body left the reply open");
  });

  it("a written inline reply closes on Escape and keeps what was written", async () => {
    await shellOnDocument();
    const surface = await openReply();
    await act(async () => { typeInto(surface, "Half a thought"); });
    await press(surface, "Escape");
    await waitFor(() => document.querySelector(".reply-editor") == null, "Escape in a written reply left it open");
    await press(document, "r");
    await waitFor(() => replySurface() != null, "`r` did not reopen the reply");
    expect(editorOf(replySurface()!).getText(), "closing the reply lost what was written").toContain("Half a thought");
  });

  it("Escape in the compose body leaves Compose and keeps the draft", async () => {
    await shellOnDocument();
    const surface = await openCompose();
    await act(async () => { typeInto(surface, "A letter begun"); });
    await press(surface, "Escape");
    await waitFor(() => compose() == null, "Escape in the compose body left Compose open");
    await openCompose();
    expect(editorOf(composeSurface()!).getText(), "leaving Compose lost the body").toContain("A letter begun");
  });
});

/*
 * THE DISPATCHER, THE REPORT'S OWN REPRODUCTION: the shipped editor inside the shipped provider,
 * beside a plain field, with one overlay Escape standing for the binding that closes the reply.
 * AFTER the shell cases: a root on a `<div>` marks `document` as listened to, and a later root
 * on `document` then attaches no listeners of its own, so the address field never opens.
 */
describe("Escape in the editor reaches the binding that closes it", () => {
  async function mount(): Promise<{ runs: () => number; host: HTMLElement }> {
    let runs = 0;
    function Closer() {
      useKeyBindings([{ chord: "Escape", group: "app", label: "close", inInput: true, run: () => { runs += 1; } }], "overlay");
      return null;
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC",
        children: h(KeymapProvider, null,
          h(Closer),
          h("input", { id: "plain", "aria-label": "plain" }),
          h(RichEditor, { value: EMPTY_RICH, onChange: () => {}, ariaLabel: "Reply body" })),
      }));
    });
    await waitFor(() => host.querySelector(".rte-surface") != null, "the editor never mounted");
    return { runs: () => runs, host };
  }

  it("CONTROL: Escape in a plain field reaches the binding", async () => {
    const m = await mount();
    await press(m.host.querySelector("#plain")!, "Escape");
    expect(m.runs()).toBe(1);
  });

  it("Escape in the editor reaches the binding, and the editor did not claim it", async () => {
    const m = await mount();
    let claimedByEditor = true;
    const surface = m.host.querySelector<HTMLElement>(".rte-surface")!;
    // Read at the surface, before the keymap's document listener claims the key it runs.
    const look = (e: Event) => { claimedByEditor = e.defaultPrevented; };
    surface.parentElement!.addEventListener("keydown", look);
    await press(surface, "Escape");
    surface.parentElement!.removeEventListener("keydown", look);
    expect(m.runs(), "Escape in the editor never reached the binding that closes it").toBe(1);
    expect(claimedByEditor, "the editor prevented an Escape none of its bindings took").toBe(false);
  });

  it("CONTROL: an editor binding that takes Escape keeps it", async () => {
    const m = await mount();
    const surface = m.host.querySelector<HTMLElement>(".rte-surface")!;
    let took = 0;
    editorOf(surface).registerPlugin(keymap({ Escape: () => { took += 1; return true; } }));
    const e = await press(surface, "Escape");
    expect(took, "the editor's own Escape binding never ran").toBe(1);
    expect(e.defaultPrevented, "a binding took Escape and left it unclaimed").toBe(true);
    expect(m.runs(), "Escape an editor binding took also closed the editor").toBe(0);
  });

  it("CONTROL: an Escape that ends an IME composition stays the editor's", async () => {
    const m = await mount();
    await press(m.host.querySelector(".rte-surface")!, "Escape", { isComposing: true });
    expect(m.runs(), "the Escape that cancels a composition closed the editor").toBe(0);
  });
});
