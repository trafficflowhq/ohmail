/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

/**
 * ═══ `#/address/<addr>` PUTS THE ADDRESS VIEW ON THE STAGE ═════════════════════════════════
 *
 * The route parsed, the view existed and the controls linked to it for a whole slice before
 * anything mounted it: `effectiveView` had no `address` case, so following an address landed on
 * an EMPTY stage under a URL that named a person. Nothing failed — the router was right, the
 * view's own render suite was green over a hand-mounted `AddressView`, and the address bar said
 * exactly what the reader had asked for. That is the shape this file exists to refuse, so the
 * assertions cover what the frame gives the address: its name in the header and the first
 * preview's letter in the URL without an extra history entry.
 *
 * ── ESCAPE, AND WHY IT HAS TWO ARMS ────────────────────────────────────────────────────────
 *
 * `goAddress` is a hash ASSIGNMENT, so following an address stacks a history entry and stepping
 * back returns to the list it was clicked in (`routing.ts` says so at the function). Escape is
 * that same gesture, which is why it is spelled as the step back rather than as a hard-coded
 * destination: a reader who followed an address out of Reads is returned to Reads.
 *
 * The exception is a tab whose FIRST entry is the address itself — a pasted link, or a reload on
 * this hash. There is nothing behind it, so stepping back would leave the product altogether on
 * a keystroke that means "close this". The Ohbox is the floor there. Both arms are driven below,
 * and they are told apart by where they land, not by reading the branch.
 */
(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The fixtures' own correspondent — demo mode holds mail from this address. */
const JONAS = "jonas@lichtgrat.example";
const HASH = `#/address/${encodeURIComponent(JONAS)}`;
const FIRST_LETTER_HASH = `${HASH}/m/jonas`;

let roots: Root[] = [];
let container: HTMLDivElement | null = null;

beforeEach(() => {
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
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  container?.remove();
  container = null;
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "#");
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

/** Mount the whole shell in demo mode over whatever hash the case installed. */
async function mountShell(): Promise<void> {
  const { AppShell } = await import("./_todays-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  container = document.createElement("div");
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
}

/** Give the shell's effects and the archive pass time to land, then read the DOM. */
async function settle(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !pred()) {
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  }
}

describe("the shell mounts the address view at its own hash", () => {
  it("Escape on a pasted link falls to the Ohbox rather than leaving the product", async () => {
    // ONE entry, installed with `replaceState` so nothing is stacked behind it — a pasted link
    // or a reload. Stepping back here would navigate away from the app on a keystroke that
    // means "close this".
    window.history.replaceState(null, "", HASH);
    await mountShell();
    const direction = () => screen.queryByRole("group", { name: "Direction" });
    await settle(() => direction() !== null && window.location.hash === FIRST_LETTER_HASH);
    expect(direction()).not.toBeNull();
    expect(window.location.hash).toBe(FIRST_LETTER_HASH);
    // THE PRECONDITION, asserted rather than assumed: with anything stacked behind this entry
    // the case measures the other arm. jsdom's session history accumulates across the cases in
    // one file, which is why this one runs first.
    expect(window.history.length, "nothing may be stacked behind a pasted link").toBe(1);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await settle(() => window.location.hash === "#/ohbox");
    expect(window.location.hash).toBe("#/ohbox");
    const ohbox = () => screen.queryByRole("heading", { name: "Ohbox" });
    await settle(() => ohbox() !== null);
    expect(ohbox()).not.toBeNull();
    expect(direction()).toBeNull();
  }, 20000);

  it("names the address and its first letter without adding a history entry", async () => {
    window.history.replaceState(null, "", HASH);
    const historyLength = window.history.length;
    await mountShell();
    await settle(() => window.location.hash === FIRST_LETTER_HASH);
    const view = within(screen.getByRole("region", { name: "Messages" }));
    const heading = view.getByRole("heading", { name: "Jonas Halter" });
    const header = within(heading.closest("header")!);
    expect(header.getByText(JONAS, { exact: true })).toBeTruthy();
    expect(header.getByRole("group", { name: "Direction" })).toBeTruthy();
    expect(window.location.hash).toBe(FIRST_LETTER_HASH);
    expect(window.history.length).toBe(historyLength);
    expect(screen.queryByRole("heading", { name: "Ohbox" })).toBeNull();
  }, 20000);

  it("Escape returns to the view the address was followed from", async () => {
    // Two entries: Reads, then the address. This is what a click on an address produces.
    window.history.replaceState(null, "", "#/reads");
    await mountShell();
    const news = () => screen.queryByRole("heading", { name: "News" });
    const direction = () => screen.queryByRole("group", { name: "Direction" });
    await settle(() => news() !== null);
    expect(news()).not.toBeNull();
    await act(async () => { window.location.hash = HASH; });
    await settle(() => direction() !== null);
    expect(direction()).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await settle(() => window.location.hash === "#/reads");
    expect(window.location.hash, "back to the list the address was clicked in").toBe("#/reads");
    await settle(() => news() !== null);
    expect(news()).not.toBeNull();
  }, 20000);

});
