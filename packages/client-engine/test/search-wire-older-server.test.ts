import { describe, expect, it } from "vitest";
import {
  HttpAdapter,
  MemoryMirrorStore,
  OhmailEngine,
  storeSearchList,
  type EngineAdapter,
  type MutationOutcome,
  type ServerSearchFilters,
  type ServerSearchOpts,
  type SyncResponse,
} from "@ohmail/client-engine";

/**
 * A PERSON, UNREAD AND THE DAYS ON THE WIRE, and an older server asked what it always was. With no new filter set,
 * every request is byte for byte today's; each new parameter is sent only when set; two questions that differ only
 * in a new filter never share a flight or a cached page; a search with no words is asked only with a filter.
 */
const NOW = new Date("2026-11-16T12:00:00.000Z");

function recorder() {
  const urls: string[] = [];
  const adapter = new HttpAdapter({
    baseUrl: "https://api.test",
    fetch: async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ items: [], total: 0 }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return { adapter, urls };
}

/** Today's request shapes, as this build sent them before the new filters: one row per shape. */
const TODAY: readonly [ServerSearchOpts, string][] = [
  [{}, "https://api.test/search?q=kiln"],
  [{ limit: 50, parts: "page" }, "https://api.test/search?q=kiln&limit=50&parts=page"],
  [{ sort: "date_desc", parts: "estimate" }, "https://api.test/search?q=kiln&sort=date_desc&parts=estimate"],
  [{ cursor: "c1", limit: 50 }, "https://api.test/search?q=kiln&limit=50&cursor=c1"],
  [{ filters: { folder: "INBOX" } }, "https://api.test/search?q=kiln&folder=INBOX"],
  [{ filters: { sender: "ben@example.test" } }, "https://api.test/search?q=kiln&sender=ben%40example.test"],
  [{ filters: { hasAttachments: true } }, "https://api.test/search?q=kiln&hasAttachments=true"],
  [
    { filters: { folder: "Archive", sender: "ben@example.test", hasAttachments: false }, sort: "sender" },
    "https://api.test/search?q=kiln&sort=sender&folder=Archive&sender=ben%40example.test&hasAttachments=false",
  ],
];

describe("an older server is asked what it always was", () => {
  it.each(TODAY)("%j is today's request, byte for byte", async (opts, url) => {
    const { adapter, urls } = recorder();
    await adapter.searchServer("kiln", opts);
    expect(urls).toEqual([url]);
  });
});

describe("each new filter reaches the wire only when set", () => {
  const NEW: readonly [ServerSearchFilters, string][] = [
    [{ to: "ben@example.test" }, "to=ben%40example.test"],
    [{ party: "ben@example.test" }, "party=ben%40example.test"],
    [{ unread: true }, "unread=true"],
    [{ unread: false }, "unread=false"],
    [{ dateFrom: "2026-11-01T00:00:00.000Z" }, "dateFrom=2026-11-01T00%3A00%3A00.000Z"],
    [{ dateTo: "2026-11-02T23:59:59.999Z" }, "dateTo=2026-11-02T23%3A59%3A59.999Z"],
  ];
  it.each(NEW)("%j", async (filters, part) => {
    const { adapter, urls } = recorder();
    await adapter.searchServer("kiln", { filters });
    expect(urls).toEqual([`https://api.test/search?q=kiln&${part}`]);
  });
});

async function engineCounting(): Promise<{ engine: OhmailEngine; asked: { q: string; o: ServerSearchOpts }[] }> {
  const asked: { q: string; o: ServerSearchOpts }[] = [];
  const store = new MemoryMirrorStore();
  await store.load();
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: NOW.toISOString() }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    searchServer: async (q: string, o: ServerSearchOpts) => {
      asked.push({ q, o });
      await new Promise((r) => setTimeout(r, 5));
      return { items: [], total: 0 };
    },
  } as unknown as EngineAdapter;
  return { engine: new OhmailEngine({ adapter, store, now: () => NOW }), asked };
}

describe("a new filter is part of the question", () => {
  const PAIRS: readonly ServerSearchFilters[] = [
    { to: "ben@example.test" },
    { party: "ben@example.test" },
    { unread: true },
    { dateFrom: "2026-11-01T00:00:00.000Z" },
    { dateTo: "2026-11-02T23:59:59.999Z" },
  ];

  it.each(PAIRS)("two questions differing only in %j never share a flight", async (filters) => {
    const { engine, asked } = await engineCounting();
    await Promise.all([
      engine.searchServer("kiln", { filters: { folder: "INBOX" } }),
      engine.searchServer("kiln", { filters: { folder: "INBOX", ...filters } }),
    ]);
    expect(asked).toHaveLength(2);
  });

  it.each(PAIRS)("two questions differing only in %j never share a cached page", (filters) => {
    expect(storeSearchList({ query: "kiln", filters: { folder: "INBOX", ...filters } })).not.toBe(
      storeSearchList({ query: "kiln", filters: { folder: "INBOX" } }),
    );
  });
});

describe("a search with no words", () => {
  it("is asked with a filter", async () => {
    const { engine, asked } = await engineCounting();
    const out = await engine.searchServer("  ", { filters: { party: "ben@example.test" } });
    expect(out.state).toBe("ready");
    expect(asked).toEqual([{ q: "", o: { filters: { party: "ben@example.test" } } }]);
  });

  it("is answered empty without asking when no filter is set", async () => {
    const { engine, asked } = await engineCounting();
    expect((await engine.searchServer("", {})).state).toBe("ready");
    expect((await engine.searchServer(" ", { filters: {} })).state).toBe("ready");
    expect(asked).toEqual([]);
  });

  it("counts a filter as set only where the wire carries it: a blank string is none, a false is one", async () => {
    const { engine, asked } = await engineCounting();
    const blank: ServerSearchFilters = { folder: "", sender: "", to: "", party: "", dateFrom: "", dateTo: "" };
    expect((await engine.searchServer("", { filters: blank })).state).toBe("ready");
    expect(asked).toEqual([]);
    await engine.searchServer("", { filters: { unread: false } });
    expect(asked).toEqual([{ q: "", o: { filters: { unread: false } } }]);
  });
});
