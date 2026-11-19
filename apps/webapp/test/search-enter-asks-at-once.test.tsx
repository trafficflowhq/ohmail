/** @vitest-environment jsdom */
import type { MutationOutcome } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type SyncResponse,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { SearchView } from "../app/views/SearchView";
import { KeymapProvider } from "../../../test/support/keymap-provider";

/**
 * ENTER ASKS THE STORE AT ONCE (SEARCH-DEBOUNCE). Typing waits the 100 ms debounce so a request goes
 * per settled question; Enter settles the question itself. Measured on the shipped web before this:
 * Enter restarted the debounce, 251 ms from the key to the request. The device holds no row for the
 * word, so Enter re-asks (a row under the cursor would be opened). A TYPED question's count and
 * facets wait until it has stood 600 ms (PERF-026: the store's one connection cannot cancel a
 * prefix's summary); an Enter'd one asks them with its page.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
const h = React.createElement;
const NOW = new Date("2026-09-26T12:00:00.000Z");
const WORD = "kestrelwing";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let host: HTMLDivElement;
let root: Root;
let asked: Array<{ at: number; parts: string; q: string }> = [];

async function engine(): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: NOW.toISOString() }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    searchServer: async (q: string, opts: { parts?: string }) => {
      asked.push({ at: performance.now(), parts: opts.parts ?? "both", q });
      return { items: [], total: 0, totalExact: true, ms: 5, tier: "exact" };
    },
  } as unknown as EngineAdapter;
  return new OhmailEngine({ adapter, store, now: () => NOW });
}

function Live({ e, door }: { e: OhmailEngine; door: { type?: (q: string) => void } }) {
  const [query, setQuery] = React.useState("");
  door.type = setQuery;
  return h(SearchView, { engine: e, version: 1, indexRev: 0, now: NOW, query, onQuery: setQuery, onOpen: () => {} });
}

async function mounted() {
  const door: { type?: (q: string) => void } = {};
  root.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW, children: h(KeymapProvider, { children: h(Live, { e: await engine(), door }) }) }));
  for (let i = 0; i < 100 && (door.type === undefined || host.querySelector(".search-box input") === null); i++) await sleep(10);
  return door;
}
const pages = () => asked.filter((a) => a.parts === "page");
const counts = () => asked.filter((a) => a.parts === "estimate");
const enter = () => host.querySelector(".search-box input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

beforeEach(() => {
  asked = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  root.unmount();
  host.remove();
});

describe("the store is asked once per settled question", () => {
  it("typed and then Enter: the page is asked at the key, not a debounce after it", async () => {
    const door = await mounted();
    door.type!(WORD);
    await sleep(40);
    const t0 = performance.now();
    enter();
    for (let i = 0; i < 60 && pages().length === 0; i++) await sleep(5);
    expect(pages(), "one page request").toHaveLength(1);
    expect(pages()[0]!.at - t0, "Enter to the request").toBeLessThan(120);
    await sleep(400);
    expect(pages(), "the typed question's debounce was cancelled, not added").toHaveLength(1);
  });

  it("the control: typing alone still waits the debounce before it asks", async () => {
    const door = await mounted();
    const t0 = performance.now();
    door.type!(WORD);
    for (let i = 0; i < 120 && pages().length === 0; i++) await sleep(5);
    expect(pages()).toHaveLength(1);
    expect(pages()[0]!.at - t0, "typed to the request").toBeGreaterThanOrEqual(90);
    expect(pages()[0]!.at - t0, "the typing debounce is 100 ms").toBeLessThan(240);
  });
});

describe("a typed question's count and facets wait until it has stood", () => {
  it("typed: the page at the debounce, the count not before 600 ms", async () => {
    const door = await mounted();
    const t0 = performance.now();
    door.type!(WORD);
    for (let i = 0; i < 120 && pages().length === 0; i++) await sleep(5);
    expect(pages()).toHaveLength(1);
    await sleep(150);
    expect(counts(), "the count was asked while the question could still change").toHaveLength(0);
    for (let i = 0; i < 200 && counts().length === 0; i++) await sleep(5);
    expect(counts()).toHaveLength(1);
    expect(counts()[0]!.at - t0, "typed to the count").toBeGreaterThanOrEqual(590);
  });

  it("a question changed inside the hold never has its count asked", async () => {
    const door = await mounted();
    door.type!(WORD);
    for (let i = 0; i < 120 && pages().length === 0; i++) await sleep(5);
    await sleep(100);
    door.type!(WORD + "s");
    await sleep(1_000);
    expect(pages().map((p) => p.q), "both questions had their page").toEqual([WORD, WORD + "s"]);
    expect(counts().map((c) => c.q), "the abandoned question's count was asked").toEqual([WORD + "s"]);
  });

  it("Enter: the count follows the page at once", async () => {
    const door = await mounted();
    door.type!(WORD);
    await sleep(40);
    const t0 = performance.now();
    enter();
    for (let i = 0; i < 100 && counts().length === 0; i++) await sleep(5);
    expect(counts()).toHaveLength(1);
    expect(counts()[0]!.at - t0, "Enter to the count").toBeLessThan(300);
  });
});
