/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { stubThreadLayout, type ThreadLayout } from "./fixtures/thread-layout.js";

/**
 * THE WHOLE SHELL KEEPS THE ROW BEING READ IN "NEW" — the view reports its armed read, the shell
 * has the engine hold it (`holdOpenRow`) and derives the Ohbox through `ohboxView(presented, held)`.
 * The view holds nothing of its own any more, so this is the guard on the wiring: drop either half
 * and the row leaves New the moment its read lands. The demo engine, the real shell.
 */

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

function setViewport(): void {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;
}

const ids = (label: string): string[] =>
  [...host!.querySelectorAll(`[role="listbox"][aria-label="${label}"] .row[data-id]`)]
    .map((e) => (e as HTMLElement).dataset.id!);
const unreadCount = (): string | null => /(\d+) unread/.exec(host!.textContent ?? "")?.[1] ?? null;
/** The rail's Ohbox count — the same number the dock badge is told (`onUnread`). */
const railCount = (): string | null => {
  const item = [...host!.querySelectorAll<HTMLElement>("button.ritem")].find((b) => b.textContent?.startsWith("Ohbox"));
  return item?.querySelector(".cnt")?.textContent ?? null;
};

async function tick(ms: number): Promise<void> {
  await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); });
}
async function click(id: string): Promise<void> {
  const el = host!.querySelector<HTMLElement>(`.row[data-id="${id}"]`)!;
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
}

let layout: ThreadLayout;
beforeEach(async () => {
  vi.useFakeTimers();
  layout = stubThreadLayout();
  setViewport();
  const { AppShell } = await import("../app/shell/AppShell.js");
  window.location.hash = "#/ohbox";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
      children: h(ThemeProvider, {
        storageKey: null,
        children: h(ToastHost, { children: h(AppShell as never, { demo: true } as never) }),
      }),
    }));
  });
  for (let i = 0; i < 12; i++) await tick(50);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host?.remove();
  root = null; host = null;
  layout.restore();
  vi.useRealTimers();
});

describe("the shell holds the open row in New", () => {
  it("a clicked row keeps its place while read; moving on files it in Earlier", async () => {
    expect(ids("New")).toEqual(["giulia", "petra", "ben"]);
    expect(unreadCount()).toBe("3");
    expect(railCount()).toBe("3");

    await click("petra");                     // a click enters it: the message on screen is read
    for (let i = 0; i < 12; i++) await tick(250);
    expect(ids("New"), "the saved read moved the open row").toEqual(["giulia", "petra", "ben"]);
    expect(unreadCount(), "the count follows the read, the place does not").toBe("2");
    expect(railCount(), "the rail and the badge count unread, not the group").toBe("2");

    await click("ben");                       // moving on
    for (let i = 0; i < 4; i++) await tick(250);
    expect(ids("New")).toEqual(["giulia", "ben"]);
    expect(ids("Earlier")).toContain("petra");
  });
});
