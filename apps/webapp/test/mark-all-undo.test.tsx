/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

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
    const meta = () => container.querySelector(".view-ohbox")?.textContent ?? "";
    await waitFor(() => meta().includes("3 unread"), "the Ohbox meta line");
    // The fixture's three (since the 2026-08-31 landing review — see fixtures/data.ts#techcheck).
    // The demo's Answer Later pile (`nadja`, `jonas`) is parked and READ, so it is in no Ohbox
    // group and contributes nothing here either way — a mail is in exactly one pile
    // (`selectors.ts#parkedMessageIds`), and this line counts what the Ohbox lists.
    expect(meta()).toContain("3 unread");

    const button = container.querySelector<HTMLButtonElement>(".mark-all-read");
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
