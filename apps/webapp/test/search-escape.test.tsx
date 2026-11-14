/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

/**
 * TRI-F3 / TRI-F8 — ESCAPE CLOSES WHAT IS OPEN, IN SEARCH AND OVER THE NAV DRAWER.
 *
 * The app's own `?` sheet reads "esc — Close what is open", and two surfaces contradicted it:
 *
 *   · SEARCH was a keyboard trap. The box autofocuses, every letter types, and Escape did
 *     nothing — no blur, no clear, no exit. A keyboard user had no route out. And re-entering
 *     kept the old query with the caret at its end, so the next question was APPENDED to the
 *     last one.
 *   · The 390px NAV DRAWER stayed open and swallowed every press until its backdrop was
 *     tapped — Escape closed all seven overlays around it and left exactly this one standing.
 *
 * Every case runs the real shell on the fixture world and presses the real key.
 */
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

beforeEach(() => {
  window.location.hash = "";
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
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
    takeRecords(): [] {
      return [];
    }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const root of roots) {
    await act(() => {
      root.unmount();
    });
  }
  roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

async function shell(): Promise<HTMLElement> {
  const { AppShell } = await import("./_todays-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);

  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  return container;
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
};

async function waitFor(predicate: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const searchInput = (el: HTMLElement): HTMLInputElement | null =>
  el.querySelector<HTMLInputElement>(".view-search input");

describe("TRI-F3 — Escape in Search: clear, then leave", () => {
  it("first press clears the query, second returns to the view `/` was pressed in", async () => {
    const container = await shell();
    // Enter Search from Reads — the way back out must be Reads, not a hard-coded Ohbox.
    // Wait on the VIEW, not the raw hash: jsdom delivers `hashchange` a task later, and two
    // navigations inside one task cancel out before React ever sees the first.
    await key("g");
    await key("r");
    await waitFor(() => container.querySelector(".view-reads") != null, "the Reads pile");
    await key("/");
    await waitFor(() => searchInput(container) != null, "search input");
    await type(searchInput(container)!, "glaze");
    await waitFor(() => container.querySelectorAll(".hit-w").length > 0, "hits");

    await key("Escape");
    expect(searchInput(container)!.value, "Escape did not clear the query").toBe("");
    expect(window.location.hash, "one Escape must not also leave").toBe("#/search");

    await key("Escape");
    await waitFor(() => container.querySelector(".view-reads") != null, "back to Reads");
    expect(window.location.hash).toBe("#/reads");
  }, 20000);

  it("on an empty box a single Escape leaves", async () => {
    const container = await shell();
    await key("/");
    await waitFor(() => searchInput(container) != null, "search input");
    await key("Escape");
    await waitFor(() => container.querySelector(".view-ohbox") != null, "back out of Search");
    expect(window.location.hash).toBe("#/ohbox");
  }, 20000);

  it("an overlay still outranks the view: Escape closes the ? sheet, the query survives", async () => {
    const container = await shell();
    await key("/");
    await waitFor(() => searchInput(container) != null, "search input");
    await type(searchInput(container)!, "glaze");

    await key("Shift", { shiftKey: true });
    await key("?", { shiftKey: true });
    await waitFor(() => container.querySelector(".ks") != null, "the ? sheet");

    await key("Escape");
    expect(container.querySelector(".ks"), "Escape did not close the sheet").toBeNull();
    expect(searchInput(container)!.value, "Escape spent itself on the query instead").toBe("glaze");
  }, 20000);

  it("re-entering keeps the old query SELECTED, so typing replaces instead of appending", async () => {
    const container = await shell();
    await key("/");
    await waitFor(() => searchInput(container) != null, "search input");
    await type(searchInput(container)!, "glaze");

    await key("g");
    await key("o");
    // The view, not the hash — Search must actually UNMOUNT before `/` remounts it, or the
    // mount effect under test never runs (see the note on the first case).
    await waitFor(() => container.querySelector(".view-ohbox") != null, "away to the Ohbox");
    await key("/");
    await waitFor(() => searchInput(container) != null, "search again");

    const input = searchInput(container)!;
    expect(input.value).toBe("glaze"); // the answer survives the round trip…
    expect(
      [input.selectionStart, input.selectionEnd],
      "…but must come back selected, or the next question is appended to the last",
    ).toEqual([0, "glaze".length]);
  }, 20000);
});

/*
 * THE NAV DRAWER IN THE FRAME. Under 840 px the whole rail is More's sheet over the app: the case above's probe re-read
 * (the dock's More opens it, the sheet's scrim is its backdrop, a window's width is its innerWidth, and Escape is
 * pressed where the keys are, as a browser does).
 */
describe("TRI-F8 — Escape closes the nav drawer, in the frame", () => {
  afterEach(() => { Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 }); });

  it("open the drawer from the topbar, press Escape, the drawer and backdrop are gone", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    const container = await shell();
    const openNav = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === "More")!;
    await act(async () => openNav.click());
    await waitFor(() => document.querySelector("[data-scrim]") != null, "the drawer backdrop");

    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await waitFor(() => document.querySelector("[data-scrim]") == null, "Escape closed the drawer");
  }, 20000);
});
