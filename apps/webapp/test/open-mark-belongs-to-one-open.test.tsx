/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { resetUiVitalsForTest, takeUiVitals } from "@ohmail/app-logic/session/ui-vitals";

/**
 * AN OPEN IS TIMED FROM ITS OWN PRESS, THROUGH THE WHOLE SHELL. The pane ends the mark in a
 * layout effect and the bar starts it in a passive one, so for a body already in the mirror the
 * end ran first and the mark stood until that message was opened again: 0.24.0 read an open p95
 * of 6 816 173 ms on Windows. Demo bodies are all in the mirror, so every open here is that case —
 * and each is one reading, from the key to the paint (0.25.2 read `openCount 0` over 15 opens).
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** Added to the real clock, so an hour can pass between two keys. */
let offset = 0;

function setViewport(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

async function flush(): Promise<void> {
  // Two frames and the passive effects behind them: `afterPaint` waits for both.
  for (let i = 0; i < 4; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
}

async function waitFor(ready: () => boolean, why: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (ready()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  throw new Error(why);
}

const key = async (k: string): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
};

const openSubject = (): string =>
  host!.querySelector(".reader .msg .msg-subject")?.textContent
  ?? host!.querySelector(".read-col .msg .msg-subject")?.textContent
  ?? "";

async function mountShell(): Promise<void> {
  const { AppShell } = await import("../app/shell/AppShell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  offset = 0;
  const real = performance.now.bind(performance);
  vi.spyOn(performance, "now").mockImplementation(() => real() + offset);
  setViewport();
  window.location.hash = "#/ohbox";
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
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
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  resetUiVitalsForTest();
  vi.restoreAllMocks();
});

describe("the open mark in the shell", () => {
  it("never reads the time since an earlier open of the same message", async () => {
    await mountShell();
    await key("j");
    await waitFor(() => openSubject() !== "", "the Ohbox never opened a message");
    const first = openSubject();
    await flush();
    await key("j");
    await waitFor(() => openSubject() !== first, "`j` did not move to a second message");
    await flush();
    takeUiVitals(); // the window so far

    offset += 60 * 60_000; // an hour on the second message
    await key("k");
    await waitFor(() => openSubject() === first, "`k` did not return to the first message");
    await flush();

    const report = takeUiVitals();
    const p95 = report.openP95Ms ?? 0;
    expect(p95, "an open read the gap since the message was last opened").toBeLessThan(60 * 60_000);
    // The `k` press painted a body the mirror held: one open, timed from the key.
    expect(report.openCount, "the press that painted the body was not timed").toBe(1);
    expect(report.openTimeouts ?? 0, "a finished open expired as a timeout").toBe(0);
  });

  it("an open in History's own column is timed too, from the pointer", async () => {
    window.location.hash = "#/history";
    await mountShell();
    await waitFor(() => (host!.querySelectorAll(".view-history .row[data-id]").length > 1), "History never listed rows");
    await flush();
    takeUiVitals(); // the window so far
    const row = host!.querySelectorAll<HTMLElement>(".view-history .row[data-id]")[1]!;
    await act(async () => {
      row.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(() => window.location.hash.startsWith("#/history/m/"), "the History open never reached the address");
    await flush();
    expect(takeUiVitals().openCount, "an open in History was not timed").toBe(1);
  });
});
