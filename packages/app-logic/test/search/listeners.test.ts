/** @vitest-environment jsdom */
import { act, cleanup, render } from "@testing-library/react";
import { createElement as h, useContext, useRef, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type MutationOutcome,
  type SyncResponse,
} from "@ohmail/client-engine";
import { KeymapContext, useKeymapStore, type KeymapStore } from "@ohmail/app-logic/keys/keymap";
import { useSearchList } from "@ohmail/app-logic/search";

/**
 * NO LISTENER, BINDING OR TIMER IS LEFT BEHIND PER SEARCH. Forty questions asked and cleared in one tab leave the
 * document's and the window's listeners, the keyboard registry's bindings and the pending timers where the first
 * five left them: what a search takes, it gives back when the question changes.
 */
const NOW = new Date("2026-11-16T12:00:00.000Z");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Live listeners on the document and the window, and live timers, counted from here on. */
function census() {
  const listeners = new Map<EventTarget, number>();
  const timers = new Set<unknown>();
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const watched = (t: EventTarget) => t === document || t === window;
  /* The window holds its own pair (jsdom), the document the prototype's: both are counted. */
  const winAdd = window.addEventListener;
  const winRemove = window.removeEventListener;
  const counted = (target: EventTarget, by: number) => {
    if (watched(target)) listeners.set(target, (listeners.get(target) ?? 0) + by);
  };
  EventTarget.prototype.addEventListener = function (
    this: EventTarget,
    ...a: Parameters<EventTarget["addEventListener"]>
  ) {
    counted(this, 1);
    return add.apply(this, a);
  };
  EventTarget.prototype.removeEventListener = function (
    this: EventTarget,
    ...a: Parameters<EventTarget["removeEventListener"]>
  ) {
    counted(this, -1);
    return remove.apply(this, a);
  };
  window.addEventListener = (...a: Parameters<typeof winAdd>) => {
    counted(window, 1);
    return winAdd.apply(window, a);
  };
  window.removeEventListener = (...a: Parameters<typeof winRemove>) => {
    counted(window, -1);
    return winRemove.apply(window, a);
  };
  globalThis.setTimeout = ((fn: (...x: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const id: unknown = set(() => {
      timers.delete(id);
      fn(...rest);
    }, ms);
    timers.add(id);
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => {
    timers.delete(id);
    clear(id);
  }) as typeof clearTimeout;
  return {
    read: () => ({
      document: listeners.get(document) ?? 0,
      window: listeners.get(window) ?? 0,
      timers: timers.size,
    }),
    restore: () => {
      EventTarget.prototype.addEventListener = add;
      EventTarget.prototype.removeEventListener = remove;
      window.addEventListener = winAdd;
      window.removeEventListener = winRemove;
      globalThis.setTimeout = set;
      globalThis.clearTimeout = clear;
    },
  };
}

async function engine(): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "0",
      hasMore: false,
      serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    searchServer: async () => ({ items: [], total: 0, totalExact: true, ms: 3, tier: "exact" }),
  } as unknown as EngineAdapter;
  return new OhmailEngine({ adapter, store, now: () => NOW });
}

/** The keyboard registry, as a shell mounts it. */
function KeymapProvider({ children }: { children: ReactNode }) {
  return h(KeymapContext.Provider, { value: useKeymapStore() }, children);
}

const door: { type?: (q: string) => void; keys?: KeymapStore | null } = {};

function Live({ e }: { e: OhmailEngine }) {
  const [query, setQuery] = useState("");
  door.type = setQuery;
  door.keys = useContext(KeymapContext);
  const boxRef = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const m = useSearchList({
    engine: e,
    scope: "acct-1",
    query,
    onQuery: setQuery,
    onOpen: () => {},
    onExit: "none",
    boxRef,
    scrollerRef,
    t: (k) => k,
    searchBy: "words",
  });
  return h(
    "div",
    { ref: scrollerRef },
    h("input", {
      ref: boxRef,
      "aria-label": "Search",
      value: query,
      onChange: (x: { target: { value: string } }) => m.type(x.target.value),
    }),
    h("p", null, m.verdict.kind),
  );
}

let watch: ReturnType<typeof census>;
beforeEach(() => {
  watch = census();
});
afterEach(() => {
  cleanup();
  watch.restore();
});

describe("a search leaves nothing behind", () => {
  it("forty questions asked and cleared: listeners, bindings and timers stay where five left them", async () => {
    const e = await engine();
    render(h(KeymapProvider, null, h(Live, { e })));
    const ask = async (i: number) => {
      await act(async () => door.type!(`kiln ${i}`));
      await act(async () => sleep(140));
      await act(async () => door.type!(""));
      await act(async () => sleep(5));
    };
    for (let i = 0; i < 5; i++) await ask(i);
    await act(async () => sleep(700));
    const five = { ...watch.read(), bindings: door.keys!.snapshot().length };
    for (let i = 5; i < 40; i++) await ask(i);
    await act(async () => sleep(700));
    const forty = { ...watch.read(), bindings: door.keys!.snapshot().length };
    expect(five.bindings, "the list's keys are registered").toBeGreaterThan(0);
    expect(forty).toEqual(five);
  }, 20_000);
});
