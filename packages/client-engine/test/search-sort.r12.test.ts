import type { MutationOutcome } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  HttpAdapter,
  MemoryMirrorStore,
  OhmailEngine,
  SERVER_SEARCH_SORTS,
  type EngineAdapter,
  type ServerSearchOpts,
  type ServerSearchWire,
  type SyncResponse,
} from "@ohmail/client-engine";

/**
 * ENGINE SIDE — what goes on the wire, and what the single-flight cache is keyed by.
 *
 * Two claims, and the second is the one that would have shipped broken.
 */

const NOW = new Date("2026-08-04T12:00:00.000Z");

function baseAdapter(over: Partial<EngineAdapter> = {}): EngineAdapter {
  return {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "0", hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    ...over,
  };
}

async function engineWith(over: Partial<EngineAdapter>): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  return new OhmailEngine({ adapter: baseAdapter(over), store, now: () => NOW });
}

describe("the sort on the wire", () => {
  it("`relevance` is NOT sent — an older deploy is asked exactly what it was asked before", async () => {
    const urls: string[] = [];
    const adapter = new HttpAdapter({
      baseUrl: "https://api.test",
      fetch: async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ items: [], total: 0 }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      },
    });

    await adapter.searchServer("heron", { sort: "relevance" });
    await adapter.searchServer("heron", {});
    // Both forms leave the parameter OFF. This is what makes the client safe to deploy ahead of
    // the API: a server that has never heard of `?sort=` sees the request it always saw, rather
    // than a 400 on every search.
    expect(urls.every((u) => !u.includes("sort="))).toBe(true);

    await adapter.searchServer("heron", { sort: "date_desc" });
    expect(urls[2]).toContain("sort=date_desc");
    // …and the query itself is still there and still encoded.
    expect(urls[2]).toContain("q=heron");
  });

  it("every non-default order reaches the wire under its own name", async () => {
    const urls: string[] = [];
    const adapter = new HttpAdapter({
      baseUrl: "https://api.test",
      fetch: async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ items: [], total: 0 }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      },
    });

    for (const sort of SERVER_SEARCH_SORTS) await adapter.searchServer("heron", { sort });

    // Index 0 is `relevance` and carries nothing; the rest are named verbatim, because the route
    // refuses anything it does not recognise and a renamed value would 400 rather than degrade.
    expect(urls[0]).not.toContain("sort=");
    for (let i = 1; i < SERVER_SEARCH_SORTS.length; i++) {
      expect(urls[i], SERVER_SEARCH_SORTS[i]).toContain(`sort=${SERVER_SEARCH_SORTS[i]}`);
    }
  });

  it("SINGLE-FLIGHT IS KEYED BY THE SORT — two orders are two requests", async () => {
    const asked: ServerSearchOpts[] = [];
    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => { release = r; });

    const engine = await engineWith({
      searchServer: async (_q: string, opts: ServerSearchOpts): Promise<ServerSearchWire> => {
        asked.push({ ...opts });
        await held;          // keep BOTH passes in flight at once — the whole point
        return { items: [], total: 0 };
      },
    } as unknown as Partial<EngineAdapter>);

    // THE GUARD. Concurrent callers for the same query JOIN one request, so with the sort
    // missing from the key the second call would be handed the first's answer: the user changes
    // the order inside the 250 ms debounce window and the list does not move. Intermittent by
    // construction, which is how it would have been filed as flakiness and never reproduced.
    const a = engine.searchServer("heron", { sort: "relevance" });
    const b = engine.searchServer("heron", { sort: "date_desc" });
    release!();
    await Promise.all([a, b]);

    expect(asked.map((o) => o.sort)).toEqual(["relevance", "date_desc"]);
  });

  it("the same query AND the same sort still joins one request", async () => {
    // The behaviour that must NOT be lost while fixing the above: widening the key until it is
    // unique per call would turn a debounced view into a request per render.
    let calls = 0;
    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => { release = r; });

    const engine = await engineWith({
      searchServer: async (): Promise<ServerSearchWire> => {
        calls++;
        await held;
        return { items: [], total: 0 };
      },
    } as unknown as Partial<EngineAdapter>);

    const a = engine.searchServer("heron", { sort: "date_desc" });
    const b = engine.searchServer("heron", { sort: "date_desc" });
    release!();
    await Promise.all([a, b]);

    expect(calls).toBe(1);
  });
});
