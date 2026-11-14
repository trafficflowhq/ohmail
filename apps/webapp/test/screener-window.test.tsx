/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore, OhmailEngine, type EngineMessage, type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import { ESTIMATED_ROW_PX, FALLBACK_VIEWPORT_PX, FULL_RANGE_MAX_ROWS } from "@ohmail/app-logic/lists/list-window";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * THE SCREENER MOUNTS ITS WINDOW. A long queue of senders mounted a row each on every switch into
 * the view (the Windows reading: switch p95 1 394 ms). The queue now goes through `useListWindow`:
 * a viewport's rows mount, the rest is reserved height, and `j` past the mounted slice still lands
 * on its row. Counts, never timers; jsdom runs the window on its own fallbacks, imported.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= { escape: (s: string) => s };
Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  })) as never;

const NOW = new Date("2026-08-02T12:00:00.000Z");
const SPAN = Math.floor(FALLBACK_VIEWPORT_PX / ESTIMATED_ROW_PX) + 1;
const ROWS_AT_TOP = SPAN + 8;
const ROWS_MOUNTED = SPAN + 16;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** Sender `i`'s one held message, newest first by `i`. */
function held(i: number): EngineMessage {
  const at = new Date(NOW.getTime() - (i + 1) * 60_000).toISOString();
  return {
    id: `m${i}`, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${i}`, from: { name: null, address: `s${i}@gate.example` }, to: [], cc: [],
    date: at, folder: "ohmail/Screener", snippet: `snippet ${i}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: at,
  } as EngineMessage;
}

async function mount(senders: number): Promise<{ scroller: HTMLElement; ids: () => string[] }> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(Array.from({ length: senders }, (_, i): SyncChange => {
    const m = held(i);
    return { type: "message", op: "create", id: m.id, seq: i + 1, updatedAt: m.updatedAt, entity: m };
  }));
  const engine = new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
    },
  });
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  function Probe(): React.ReactElement {
    const state = useScreenerState(engine, 0, (() => {}) as never, new Map() as never, undefined as never);
    const [sel, setSel] = React.useState<Record<string, string | null>>({ waiting: null, screened: null, spam: null });
    return h(ScreenerView, {
      owed: false, state, segment: "waiting", settled: true, selection: sel as never,
      onSelect: (s: string, id: string | null) => setSel((m) => ({ ...m, [s]: id })),
      hydrateBody: () => {}, hydrateBodies: () => {}, full: false, onFull: () => {},
    } as never);
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, { storageKey: null, children: h(KeymapProvider, { children: h(Probe) }) }),
    }));
  });
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
  await settleFirstPaint();
  const scroller = host.querySelector(".view-screener .list-col .scroller") as HTMLElement;
  return {
    scroller,
    ids: () => [...host!.querySelectorAll(".view-screener .row[data-id]")].map((n) => n.getAttribute("data-id")!),
  };
}

async function frames(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

beforeEach(() => {
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

describe("the Screener queue is a window", () => {
  it("a queue under the window's floor renders whole — the positive control", async () => {
    const m = await mount(40);
    expect(m.ids()).toHaveLength(40);
    expect(40).toBeLessThanOrEqual(FULL_RANGE_MAX_ROWS);
  });

  it("a long queue of waiting senders mounts a viewport's rows, and the rest is reserved height", async () => {
    const m = await mount(1510);
    expect(m.scroller, "no list scroller — the window has nothing to read").not.toBeNull();
    expect(m.ids()).toHaveLength(ROWS_AT_TOP);
    expect(m.ids()[0]).toBe("m0");
    // The top spacer (where slot 0 starts) reserves nothing at the top; the bottom one the rest.
    expect(m.scroller.querySelector<HTMLElement>(".rows > [data-window-top]")?.style.height).toBe("0px");
    const spacer = m.scroller.querySelector<HTMLElement>(".rows > div[aria-hidden]:not([data-window-top])");
    expect(spacer?.style.height).toBe(`${(1510 - ROWS_AT_TOP) * ESTIMATED_ROW_PX}px`);
  });

  it("scrolling moves the window through the queue, and the mounted count stays a window", async () => {
    const m = await mount(1510);
    m.scroller.scrollTop = 700 * ESTIMATED_ROW_PX;
    await act(async () => { m.scroller.dispatchEvent(new Event("scroll")); });
    await frames();
    expect(m.ids()).toContain("m700");
    expect(m.ids()).not.toContain("m0");
    expect(m.ids()).toHaveLength(ROWS_MOUNTED);
  });

  it("j from a selection the window has scrolled past lands on the next sender's row", async () => {
    const m = await mount(1510);
    // The first sender is selected; scroll it out of the mounted slice, then walk.
    m.scroller.scrollTop = 900 * ESTIMATED_ROW_PX;
    await act(async () => { m.scroller.dispatchEvent(new Event("scroll")); });
    await frames();
    expect(m.ids()).not.toContain("m1");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    });
    await frames();
    expect(m.ids()).toContain("m1");
    expect(host!.querySelector(".view-screener .row.sel")?.getAttribute("data-id")).toBe("m1");
  });
});
