/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { OhmailEngine, MemoryMirrorStore } from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import type { ScreenerState } from "@ohmail/app-logic/screener/screener-state";
import type { ScreenerSegmentId } from "../app/shell/routing.js";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * THE ZERO-STATE RENDERS ONCE, NOT ONCE PER PANE.
 *
 * The Screener is a two-pane split: senders on the left (`ListPane` → `ListRows`), the selected
 * sender's held mail on the right (`.read-col.scn-read`). When a segment is empty BOTH panes fell
 * back to `<Empty>` — the list because it had no rows, the read column because it had nothing to
 * preview — so the same glyph, title and hint appeared twice, side by side on desktop. Reported
 * on "Screened out" and "Spam", which are empty on any fresh account.
 *
 * The list owns the message: it is the pane a stranger sees first, and on mobile it is the ONLY
 * pane visible until a sender is opened. So the read column no longer renders its own copy when
 * the segment is empty. This asserts exactly one `.empty` node for an empty `spam` and an empty
 * `screened` segment. Mutation watch: restore the read column's unconditional `<Empty>` and the
 * count goes to 2.
 *
 * `apps/webapp` typechecks its tests, so the render props below are checked too.
 */

// See the sync-liveness harness for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

const NOW = new Date("2026-08-02T12:00:00.000Z");
let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** An engine over an EMPTY mirror — every Screener segment is empty. */
async function emptyEngine(): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => ({ text: "", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
    },
  });
}

async function mount(segment: ScreenerSegmentId): Promise<void> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../../../test/support/keymap-provider");
  const engine = await emptyEngine();

  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const state: ScreenerState = useScreenerState(engine, null, v, (() => {}) as never, useScreenerText());
    return h(ScreenerView, {
      owed: false,
      state,
      segment, settled: true,
      selection: { waiting: null, screened: null, spam: null } as never,
      onSelect: () => {}, hydrateBody: () => {}, full: false, onFull: () => {},
    } as never);
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(KeymapProvider, { children: h(Probe) }),
        }),
      }),
    );
  });
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
  await settleFirstPaint();
}

beforeEach(() => {
  globalThis.fetch = (async () =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

describe("Screener zero-state renders once, not once per pane", () => {
  it("an empty Spam segment shows exactly one empty state", async () => {
    await mount("spam");
    expect(host!.querySelectorAll(".empty")).toHaveLength(1);
  });

  it("an empty Screened out segment shows exactly one empty state", async () => {
    await mount("screened");
    expect(host!.querySelectorAll(".empty")).toHaveLength(1);
  });
});
