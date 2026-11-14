/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { headCount } from "./ohbox/_finders";

/**
 * TRI-F13 — "MARK ALL READ" IS REVERSIBLE.
 *
 * The button fired instantly with no confirmation and no undo: one click over hundreds of
 * unread, irreversible short of marking each row unread by hand. The product's own ceremony
 * for exactly this shape is the TRUE-UNDO toast (`ToastHost` — the toast carries the action,
 * fires it at most once). The undo flips exactly the ids the press flipped, so mail that was
 * already read before the press stays read.
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

describe("TRI-F13 — mark all read answers with an undo", () => {
  it("the press flips the pile; the toast's Undo flips exactly those rows back", async () => {
    const container = await shell();
    /* The head states the unread count in its Mark all read's name ("Mark all 3 unread messages read"); the design's
       head prints no "n unread" beside the title (studio PARITY 2.1), and draws no Mark all read once nothing is
       unread, so "0 unread" is the head with none. */
    const meta = () => {
      const n = headCount(container);
      return n === null ? "0 unread" : `${n} unread`;
    };
    await waitFor(() => meta().includes("3 unread"), "the Ohbox meta line");
    // The fixture's three (since the 2026-08-31 landing review — see fixtures/data.ts#techcheck).
    // The demo's Answer Later pile (`nadja`, `jonas`) is parked and READ, so it is in no Ohbox
    // group and contributes nothing here either way — a mail is in exactly one pile
    // (`selectors.ts#parkedMessageIds`), and this line counts what the Ohbox lists.
    expect(meta()).toContain("3 unread");

    const button = (container.querySelector<HTMLButtonElement>(".mark-all-read") ?? [...document.querySelectorAll<HTMLButtonElement>(".view-ohbox button")].find((b) => /^Mark (all \d+ unread messages|the 1 unread message) read$/.test(b.getAttribute("aria-label") ?? "")) ?? null);
    expect(button, "no mark-all-read affordance").not.toBeNull();
    await act(async () => button!.click());
    await waitFor(() => meta().includes("0 unread"), "everything read");

    // The toast carries the undo — the product's true-undo pattern, not a confirm dialog.
    const undo = document.querySelector<HTMLButtonElement>(".toast .toast-act");
    expect(undo, "the mark-all toast offers no Undo").not.toBeNull();
    expect(document.querySelector(".toast")?.textContent).toContain("read");

    await act(async () => undo!.click());
    // Back to the three the Ohbox holds — the undo restores exactly the rows the press flipped,
    // and the press could only reach the rows the Ohbox lists. Parked mail was never in it.
    await waitFor(() => meta().includes("3 unread"), "the undo restored the unread rows");
  }, 20000);
});
