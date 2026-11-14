/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { useSuggestText } from "../app/shell/suggest-text";
import {
  OhmailEngine, MemoryMirrorStore,
  type EngineMessage, type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import type { ScreenerState } from "@ohmail/app-logic/screener/screener-state";
import { settleFirstPaint } from "./_first-paint.js";
import messages from "../messages/en.json";

/**
 * THE FIRST DERIVATION IS DEFERRED PAST FIRST PAINT — and deferred is all it is. Three claims:
 * 1. DEFERRED, NOT DERIVED-EMPTY: at first paint the queue is withheld (`queueSettled` false);
 *    one settle later the rows are the eager shape's. Mutation: seed `useState(true)` → red.
 * 2. THE SETTLE IS NOT A GAIN: the late delivery lands after the mount effects, where the
 *    activation read cannot consume its `queueGainAt`, so unclassified it buys a debounced
 *    re-read the eager shape never made. The wire is read ONCE across the whole window.
 *    Mutation: make the gain arm in `forSenders` unconditional → red.
 * 3. A GAIN IS STILL A GAIN: a post-settle arrival schedules the re-read — the positive control.
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
let seq = 0;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function held(id: string, from: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: "2026-08-02T09:00:00.000Z",
    folder: "ohmail/Screener", snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

async function engineWith(
  mail: EngineMessage[],
): Promise<{ engine: OhmailEngine; deliver: (m: EngineMessage[]) => Promise<void> }> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    mail.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
  );
  let pending: EngineMessage[] = [];
  const engine = new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => {
        const batch = pending;
        pending = [];
        return {
          changes: {
            creates: batch.map((m): SyncChange => ({
              type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
            })),
            updates: [], moves: [], deletes: [],
          },
          cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
        };
      },
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
    },
  });
  const deliver = async (m: EngineMessage[]): Promise<void> => {
    pending = m;
    await act(async () => { await engine.syncOnce(); });
  };
  return { engine, deliver };
}

/** GET /screener hydration reads (never the suggest endpoint) — the count claims 2 and 3 turn on. */
let hydrationReads = 0;
function installFetch(): void {
  hydrationReads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    const path = url.replace(/^\/api/, "");
    if (path.startsWith("/screener") && !path.startsWith("/screener/suggest")) hydrationReads++;
    return new Response(
      JSON.stringify({ items: [], nextCursor: null, suggestable: { senders: [], credits: 0, maxPerRequest: 50 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

/**
 * Mount the REAL pair, wired the way `AppShell` wires them — `forSenders` handed the queue AND
 * its settle flag at every render. `withSuggest: false` mounts the state hook alone (claim 1).
 */
/** The debounce window, off the module itself — imported here so the import stays dynamic. */
async function debounceMs(): Promise<number> {
  return (await import("../app/shell/screener-suggest.js")).HYDRATE_DEBOUNCE_MS;
}

async function mount(
  engine: OhmailEngine, withSuggest: boolean,
): Promise<{ latest: () => ScreenerState }> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  const { useScreenerSuggestions } = await import("../app/shell/screener-suggest.js");
  const { CLOUD_WIRE } = await import("../app/(product)/mailbox/suggest-wire.js");
  // (api-client reads API_BASE at load — the module top sets it, and every shell import stays dynamic.)
  const { KeymapProvider } = await import("@ohmail/app/keys");

  let live: ScreenerState | null = null;

  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const suggestions = useScreenerSuggestions({
      text: useSuggestText(),
      wire: CLOUD_WIRE,
      active: withSuggest,
      toast: (() => {}) as never,
    });
    const state = useScreenerState(engine, null, v, (() => {}) as never, useScreenerText(), suggestions.suggestions);
    live = state;
    // The shell's own seam: the queue and its settle flag travel together, every render.
    if (withSuggest) suggestions.forSenders(state.unsuggestedSenders, state.suggestedSenders, 0, state.queueSettled);
    return h(React.Fragment, {});
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
  return { latest: () => live! };
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe("the Screener's first derivation is deferred past first paint", () => {
  it("withholds the queue at first paint and serves the eager shape one settle later", async () => {
    const { engine } = await engineWith([
      held("m1", "a@example.test"), held("m2", "b@example.test"), held("m3", "c@example.test"),
    ]);
    const { latest } = await mount(engine, false);

    // FIRST PAINT: the mirror holds three senders and the queue says so with a WITHHELD, not
    // with an empty answer — the flag is what an empty-state sentence must gate on.
    expect(latest().queueSettled).toBe(false);
    expect(latest().waiting).toHaveLength(0);
    expect(latest().waitingCount).toBe(0);

    await settleFirstPaint();

    // SETTLED: the rows are the eager derivation's, exactly.
    expect(latest().queueSettled).toBe(true);
    expect(latest().waiting.map((w) => w.from.address).sort()).toEqual([
      "a@example.test", "b@example.test", "c@example.test",
    ]);
    expect(latest().waitingCount).toBe(3);
  });

  it("classifies the settle's delivery as the activation set — one hydration read, no gain read", async () => {
    vi.useFakeTimers();
    installFetch();
    const { engine } = await engineWith([held("m1", "a@example.test"), held("m2", "b@example.test")]);
    await mount(engine, true);

    // The activation read, at mount — the one read the eager shape made.
    expect(hydrationReads).toBe(1);

    await settleFirstPaint();
    // Cross the whole debounce window: a gain read scheduled off the settle would fire in it.
    await act(async () => { await vi.advanceTimersByTimeAsync(await debounceMs() + 1_000); });

    expect(hydrationReads).toBe(1);
  });

  it("still schedules the gain read for a sender who arrives after the settle", async () => {
    vi.useFakeTimers();
    installFetch();
    const { engine, deliver } = await engineWith([held("m1", "a@example.test")]);
    await mount(engine, true);
    await settleFirstPaint();
    await act(async () => { await vi.advanceTimersByTimeAsync(await debounceMs() + 1_000); });
    expect(hydrationReads).toBe(1);

    // A REAL gain: a sender this session has not seen joins the settled active queue.
    await deliver([held("m9", "new@example.test")]);
    await act(async () => { await vi.advanceTimersByTimeAsync(await debounceMs() + 1_000); });

    expect(hydrationReads).toBe(2);
  });
});
