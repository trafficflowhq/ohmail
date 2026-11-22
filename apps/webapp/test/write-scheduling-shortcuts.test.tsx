/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { NONE } from "@ohmail/app/host";
import { WEB_PANE_PARTS } from "../app/(product)/mailbox/pane-parts";
import { chordKeys, modGlyph } from "@ohmail/app-logic/keys/keymap";

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

/** The mounted mail shell on the demo fixture, with the web Account entry. */
async function shell(): Promise<void> {
  const { MailShell } = await import("./_mail-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const { account } = WEB_PANE_PARTS;
  if (account === NONE) throw new Error("the web app did not supply Account settings");

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
          children: h(ToastHost, { children: h(MailShell, { demo: true, accountDoors: account }) }),
        }),
      }),
    );
  });
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    (document.activeElement ?? document).dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
};

const go = async (hash: string): Promise<void> => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
};

/** Move focus out of the composition field so typing ? invokes the shortcut sheet. */
function focusWriteControl(): void {
  screen.getByRole("button", { name: messages.write.marks.bold }).focus();
}

/** Each shortcut sentence can carry more than one chord. */
function sheetRows(): Array<{ label: string; chords: string[] }> {
  const sheet = within(screen.getByRole("dialog", { name: messages.shortcuts.title }));
  return sheet.getAllByRole("paragraph").map((row) => {
    const label = row.querySelector(".oh-keyhelp-label")?.textContent ?? "";
    const chords = [...row.querySelectorAll(".oh-keyhelp-chord")].map(
      (chord) => [...chord.querySelectorAll("kbd")].map((key) => key.textContent ?? "").join(""),
    );
    return { label, chords };
  });
}

/* The modifier's cap is the PLATFORM's (`modGlyph`) — jsdom announces no Mac, so the sheet
   prints Ctrl here, and the expectation is spelled with the same function the sheet uses. */
const cap = (chord: string): string => chordKeys(chord, modGlyph()).join("");

/** Assert every chord in `expected` has a row in the open sheet, naming the missing one. */
function expectListed(expected: string[]): void {
  const caps = new Set(sheetRows().flatMap((row) => row.chords));
  const missing = expected.filter((chord) => !caps.has(cap(chord)));
  expect(missing, `shortcuts missing from the sheet: ${missing.join(", ")}`).toEqual([]);
}

it("the Compose sheet carries send, schedule and the send-later digits", async () => {
  await shell();
  await go("#/compose");
  focusWriteControl();
  await key("?");

  expectListed(["mod+Enter", "1", "2", "3", "4", "Escape"]);
  const rows = sheetRows();
  expect(rows).toContainEqual({ label: messages.write.keys.send, chords: [cap("mod+Enter")] });
  // The four presets share one line in the sheet. Rail digits cannot stand in for it.
  expect(rows.filter(({ label }) => label === messages.write.keys.later)).toEqual([
    { label: messages.write.keys.later, chords: ["1", "2", "3", "4"].map(cap) },
  ]);
  expect(rows).toContainEqual({ label: messages.write.keys.leave, chords: [cap("Escape")] });
});
