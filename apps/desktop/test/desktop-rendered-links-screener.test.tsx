/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import { setRenderedLinksBatchSink, setRenderedLinksSink } from "../../../packages/letter-body/src/rendered-links";
import { enableExternalLinks, interceptLinkClicks } from "@ohmail/app-logic/session/open-external";
import { HeldUnsubscribe } from "../../webapp/app/views/ScreenerView";
import messages from "../../webapp/messages/en.json";
import { reportRenderedLinksToShell } from "../src/native.js";

/**
 * THE SCREENER's LINKS ON THE SHELL's LIST: the case of `desktop-rendered-links.test.tsx` that draws today's
 * Screener, moved here as it stood (share reader-1) so that file reads only parts that stay; it waits for the
 * Screener's mount (`WAITS:screener`, its row). The window is armed exactly as `main.tsx` arms it and every command it
 * sends the shell is recorded, as in the file it came from.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

/** Every command the window sent the shell, in order. */
const sent: Array<{ command: string; payload?: Record<string, unknown> }> = [];
const LINKS = "rendered_links_batch";
const reports = (): Array<{ surface: string; urls: string[] }> =>
  sent
    .filter((s) => s.command === LINKS)
    .map((s) => s.payload as { surfaces: string[]; urls: string[][] })
    .flatMap((b) => b.surfaces.map((surface, i) => ({ surface, urls: b.urls[i]! })));

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;
let dispose: (() => void) | null = null;

async function turns(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}

async function mount(element: React.ReactElement): Promise<HTMLElement> {
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => { root!.render(element); });
  await turns();
  return mountPoint;
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  // The removal rides the next batch, a frame later at most (`rendered-links.ts`).
  await turns(4);
  root = null;
  mountPoint?.remove();
  mountPoint = null;
}

beforeEach(() => {
  sent.length = 0;
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      sent.push({ command, payload });
      return null;
    },
  };
  vi.spyOn(window, "open").mockImplementation(() => null);
  // What `main.tsx` arms before the first render: the interceptor, and the sink to the shell.
  enableExternalLinks();
  dispose = interceptLinkClicks(document, { trustSameOrigin: true });
  setRenderedLinksBatchSink(reportRenderedLinksToShell);
});

afterEach(async () => {
  await unmount();
  dispose?.();
  dispose = null;
  setRenderedLinksSink(null);
  delete host.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("a message's links are on the shell's list while it is on screen", () => {
  it("the Screener's unsubscribe link is reported while it is drawn", async () => {
    const url = "https://lists.example.test/unsubscribe?id=7";
    const el = await mount(
      h(NextIntlClientProvider, {
        locale: "en",
        messages: messages as never,
        timeZone: "UTC",
        children: h(HeldUnsubscribe, { state: "not_one_click", url, onUnsubscribe: async () => null }),
      }),
    );
    expect(el.querySelector("a.hm-unsub-link")?.getAttribute("href")).toBe(url);
    expect(reports().flatMap((r) => r.urls)).toEqual([url]);
    await unmount();
    expect(reports().at(-1)?.urls).toEqual([]);
  });
});
