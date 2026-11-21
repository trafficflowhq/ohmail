/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { screen, within } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";

/**
 * ═══ THE PALETTE SAYS WHEN IT CANNOT ACT ══════════════════════════════════════════════
 *
 * Two ⌘K rows act on the open Ohbox message — "Tag it <name>" and "Resurface selection" —
 * and both bodies have always been `if (selectedOhbox) …`. Since the Ohbox stopped opening
 * the newest message on arrival, "nothing is selected" is the state a fresh window is IN,
 * not an edge case: pressing either row answered with silence, closed the palette, and left
 * the person to guess whether it had worked.
 *
 * Their keyboard twins have never had that problem. `t` (`OhboxView`) and `b` (`AppShell`'s
 * global registry) both carry `disabled` on an absent selection, so the dispatcher skips
 * them and the `?` sheet dims them. These are the SAME commands reached the other way, so
 * this file asserts the palette carries the same declaration — the rail, the palette and
 * the keyboard landing in different places is the failure the registry exists to prevent.
 *
 * Driven through the real shell rather than by reading the command array, because the array
 * is only half the claim: a `disabled` field nothing rendered would be a field, not a
 * behaviour. The assertions are on the native disabled buttons the person reaches and on what
 * pressing ↵ over the row does.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function setViewport(mobile: boolean): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: mobile && query.includes("max-width"),
      media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

async function mountShell(): Promise<void> {
  await unmount();
  const { MailShell } = await import("./_mail-shell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(MailShell, { demo: true }) }),
        }),
      }),
    );
  });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
  await screen.findByRole("navigation", { name: "Places" });
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    (document.activeElement ?? document).dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
};

/** Open ⌘K and hand back the rows it drew. */
async function openPalette(): Promise<HTMLElement[]> {
  await key("k", { metaKey: true });
  const list = await screen.findByRole("listbox", { name: messages.palette.ariaLabel });
  return within(list).getAllByRole("option");
}

const rowNamed = (rows: HTMLElement[], startsWith: string): HTMLElement => {
  const found = rows.find((r) => (r.textContent ?? "").startsWith(startsWith));
  if (!found) {
    throw new Error(
      `no palette row starting "${startsWith}" — rows were: ` +
        rows.map((r) => JSON.stringify(r.textContent)).join(", "),
    );
  }
  return found;
};

const off = (row: HTMLElement): boolean => row instanceof HTMLButtonElement && row.disabled;

beforeEach(() => {
  setViewport(false);
  window.location.hash = "#/ohbox";
});

afterEach(async () => {
  await unmount();
  vi.restoreAllMocks();
});

describe("the ⌘K rows that act on the open message", () => {
  it("are declared unavailable while nothing is open, and live once something is", async () => {
    await mountShell();

    /* A fresh Ohbox opens nothing. Both rows are listed — a command that vanishes with the
       cursor is a command nobody learns — and both say they cannot act. */
    let rows = await openPalette();
    expect(rows.length).toBeGreaterThan(0);
    const restingResurface = rowNamed(rows, "Resurface selection");
    expect(off(restingResurface)).toBe(true);

    const restingTag = rows.find((r) => (r.textContent ?? "").startsWith("Tag: "));
    expect(restingTag, "the demo world has tags, so a tag row must exist").toBeTruthy();
    expect(off(restingTag!)).toBe(true);

    /* …and pressing ↵ over one does NOTHING — not even close the sheet, because closing is
       the one outcome that reads as "that worked". */
    const input = screen.getByRole("combobox", { name: messages.palette.ariaLabel });
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value",
    )!.set!;
    await act(async () => {
      setter.call(input, "Resurface selection");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(screen.getByRole("dialog", { name: messages.palette.ariaLabel }), "a refused row must not close the palette").toBeTruthy();

    /* Close it, open a message the way the product now says to — `j` — and re-ask. */
    await key("Escape");
    await key("j");
    rows = await openPalette();
    expect(off(rowNamed(rows, "Resurface selection"))).toBe(false);
    expect(off(rows.find((r) => (r.textContent ?? "").startsWith("Tag: "))!)).toBe(false);
  });
});
