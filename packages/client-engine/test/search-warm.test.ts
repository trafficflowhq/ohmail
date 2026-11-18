/**
 * THE FIRST KEY OF A SEARCH WARMS THE WAY TO THE STORE: on the desktop window a
 * typed search sends one blank search while its debounce runs, so the sidecar's hop to a paired
 * account is open when the page leaves. Once per pause, never per key, and only where asked for.
 */
import type { MutationOutcome } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  StoreSearchWalker,
  type EngineAdapter,
  type SyncResponse,
} from "../src/index.js";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const DEBOUNCE_MS = 40;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function engineWith(warmSearch: boolean | undefined): Promise<{ engine: OhmailEngine; asked: Array<{ q: string; at: number }> }> {
  const asked: Array<{ q: string; at: number }> = [];
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: NOW.toISOString() }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    searchServer: async (q: string) => {
      asked.push({ q, at: performance.now() });
      return { items: [], total: 0, totalExact: true, ms: 1, tier: "exact" };
    },
  } as unknown as EngineAdapter;
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({ adapter, store, now: () => NOW, ...(warmSearch === undefined ? {} : { warmSearch }) });
  return { engine, asked };
}

describe("a search warms the way to the store on its first key", () => {
  it("one blank search leaves at once, the page after the debounce", async () => {
    const { engine, asked } = await engineWith(true);
    const walker = new StoreSearchWalker(engine);
    const t0 = performance.now();
    walker.start({ query: "invoice" }, () => [], DEBOUNCE_MS);
    await sleep(DEBOUNCE_MS * 3);
    expect(asked.map((a) => a.q).slice(0, 2)).toEqual(["", "invoice"]);
    expect(asked[0]!.at - t0, "the warm-up does not wait for the debounce").toBeLessThan(DEBOUNCE_MS);
  });

  it("not again while a search left inside the idle window: the next word asks its page alone", async () => {
    const { engine, asked } = await engineWith(true);
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "invoice" }, () => [], DEBOUNCE_MS);
    await sleep(DEBOUNCE_MS * 3);
    const before = asked.length;
    walker.start({ query: "invoices" }, () => [], DEBOUNCE_MS);
    await sleep(DEBOUNCE_MS * 3);
    expect(asked.slice(before).map((a) => a.q).filter((q) => q === "")).toEqual([]);
  });

  it("an engine not asked to warm sends no blank search (the browser's)", async () => {
    for (const option of [undefined, false]) {
      const { engine, asked } = await engineWith(option);
      const walker = new StoreSearchWalker(engine);
      walker.start({ query: "invoice" }, () => [], DEBOUNCE_MS);
      await sleep(DEBOUNCE_MS * 3);
      expect(asked.map((a) => a.q)).not.toContain("");
    }
  });
});
