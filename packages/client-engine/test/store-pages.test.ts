import type { EngineMessage, MutationOutcome } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  HISTORY_PAGE_CACHE_ROWS,
  HISTORY_PAGE_ROWS,
  HttpAdapter,
  MemoryMirrorStore,
  OhmailEngine,
  StorePageCache,
  UUID_MAX,
  readTimelineWire,
  segmentAt,
  timelineSegments,
  uuidSuccessor,
  type EngineAdapter,
  type ListOlderFn,
  type StoreTimeline,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * History and Search read the STORE, never the mirror: a page of `GET /messages?view=all` is held
 * in the engine's bounded cache and never written into the mirror, whatever it reaches. The
 * no-mirror-write case below is the census the ruling names.
 */

const NOW = new Date("2026-09-23T12:00:00.000Z");

function msg(id: string, date: string | null, over: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: "sender@example.test" },
    to: [], cc: [], date, folder: "INBOX", snippet: "s", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date ?? NOW.toISOString(), ...over,
  };
}

/** Ids that sort like their index, newest first: id(0) > id(1) > … in uuid order. */
function id(n: number): string {
  const h = (0xffffff - n).toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${h}`;
}

/** A store of `n` messages, one per hour going back, answering the strict keyset like the route. */
function storeOf(n: number): EngineMessage[] {
  return Array.from({ length: n }, (_, i) => msg(id(i), new Date(NOW.getTime() - i * 3_600_000).toISOString()));
}

function below(rows: EngineMessage[], before?: { date: string | null; id: string }): EngineMessage[] {
  if (!before) return rows;
  return rows.filter((m) => {
    if (before.date === null) return m.date === null && m.id < before.id;
    if (m.date === null) return true;
    return m.date < before.date || (m.date === before.date && m.id < before.id);
  });
}

function adapterOf(rows: EngineMessage[], calls: string[] = [], changes: SyncChange[] = []): EngineAdapter {
  const listMessages: ListOlderFn = async (view, opts) => {
    calls.push(JSON.stringify([view, opts.startBelow ?? null]));
    const page = below(rows, opts.startBelow).slice(0, opts.limit ?? HISTORY_PAGE_ROWS);
    return { items: page, nextCursor: null };
  };
  let served = false;
  return {
    sync: async (): Promise<SyncResponse> => {
      const out = served ? [] : changes;
      served = true;
      return { changes: { creates: out, updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: NOW.toISOString() };
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    listMessages,
    timeline: async (): Promise<StoreTimeline> => ({ total: rows.length, months: [], undated: 0 }),
  } as unknown as EngineAdapter;
}

describe("uuidSuccessor — a strict keyset that starts AT a row", () => {
  it("adds one in hex order, with the carry", () => {
    expect(uuidSuccessor("00000000-0000-4000-8000-00000000000a")).toBe("00000000-0000-4000-8000-00000000000b");
    expect(uuidSuccessor("00000000-0000-4000-8000-0000000000ff")).toBe("00000000-0000-4000-8000-000000000100");
    expect(uuidSuccessor("0000000f-ffff-ffff-ffff-ffffffffffff")).toBe("00000010-0000-0000-0000-000000000000");
  });

  it("is the smallest id above the row, so the row itself is the page's first", () => {
    const rows = storeOf(5);
    const anchor = rows[2]!;
    const page = below(rows, { date: anchor.date, id: uuidSuccessor(anchor.id) });
    expect(page[0]!.id).toBe(anchor.id);
  });
});

describe("the timeline as index ranges", () => {
  const t: StoreTimeline = {
    total: 7,
    months: [
      { month: "2026-09", count: 3, first: { date: "2026-09-20T00:00:00.000Z", id: id(0) } },
      { month: "2026-08", count: 0, first: { date: "2026-08-20T00:00:00.000Z", id: id(9) } },
      { month: "2026-07", count: 2, first: { date: "2026-07-20T00:00:00.000Z", id: id(3) } },
    ],
    undated: 2,
  };

  it("starts each month where the one above it ends; the undated tail comes last", () => {
    const segs = timelineSegments(t);
    expect(segs.map((s) => [s.month, s.start, s.count])).toEqual([
      ["2026-09", 0, 3], ["2026-07", 3, 2], [null, 5, 2],
    ]);
    expect(segs[0]!.before).toEqual({ date: "2026-09-20T00:00:00.000Z", id: uuidSuccessor(id(0)) });
    expect(segs[2]!.before).toEqual({ date: null, id: UUID_MAX });
    // The list's length is the store's total when the timeline is consistent.
    expect(segs.reduce((n, s) => n + s.count, 0)).toBe(t.total);
  });

  it("finds the segment of any index, and none past the end", () => {
    const segs = timelineSegments(t);
    expect(segmentAt(segs, 0)?.month).toBe("2026-09");
    expect(segmentAt(segs, 2)?.month).toBe("2026-09");
    expect(segmentAt(segs, 3)?.month).toBe("2026-07");
    expect(segmentAt(segs, 6)?.month).toBe(null);
    expect(segmentAt(segs, 7)).toBeNull();
  });

  it("reads the wire defensively — a malformed month is dropped, not trusted", () => {
    expect(readTimelineWire({ total: 3, months: [
      { month: "2026-09", count: 3, first: { date: "2026-09-01T00:00:00.000Z", id: id(0) } },
      { month: "Sept", count: 1, first: { date: null, id: id(1) } },
    ] })).toEqual({ total: 3, undated: 0, months: [
      { month: "2026-09", count: 3, first: { date: "2026-09-01T00:00:00.000Z", id: id(0) } },
    ] });
    expect(readTimelineWire({ months: [] })).toBeNull();
  });
});

describe("the page cache is the one bound on page rows", () => {
  it("evicts the page farthest in time from the one just put, never that one", () => {
    const cache = new StorePageCache(100);
    const page = (from: number) => ({ items: storeOf(from + 50).slice(from, from + 50), nextCursor: null });
    cache.put("a", page(0));
    cache.put("b", page(50));
    cache.put("c", page(100));
    expect(cache.rows()).toBe(100);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
  });

  it("another list's pages go first — Search walking does not evict its own page for History's", () => {
    const cache = new StorePageCache(150);
    const page = (from: number) => ({ items: storeOf(from + 50).slice(from, from + 50), nextCursor: null });
    cache.put("s0", page(0), 0, "search");
    cache.put("s1", page(50), 50, "search");
    cache.put("h0", page(0), 0, "all");
    cache.put("s2", page(100), 100, "search");
    expect(cache.rows()).toBe(150);
    expect(cache.get("h0"), "History's page, off screen while Search walks").toBeUndefined();
    expect(cache.get("s0")).toBeDefined();
    expect(cache.get("s1")).toBeDefined();
  });

  it("a delta for a held row replaces it in its page; a delete is left to the mirror's tombstone", () => {
    const cache = new StorePageCache(150);
    const rows = storeOf(50);
    cache.put("p", { items: rows, nextCursor: null });
    const rev = cache.revision();
    const moved = { ...rows[3]!, folder: "ohmail/Receipts" };
    expect(cache.adopt([{ type: "message", op: "update", id: moved.id, seq: 9, updatedAt: moved.updatedAt, entity: moved }])).toBe(true);
    expect(cache.find(moved.id)?.folder).toBe("ohmail/Receipts");
    expect(cache.revision()).toBeGreaterThan(rev);
    expect(cache.adopt([{ type: "message", op: "delete", id: rows[4]!.id, seq: 10, updatedAt: moved.updatedAt, entity: null }])).toBe(false);
    expect(cache.find(rows[4]!.id)).toBeDefined();
  });
});

describe("engine.pageStore — the store's pages, never the mirror", () => {
  it("THE CENSUS: paging the whole store leaves the mirror's message count where it was", async () => {
    const rows = storeOf(400);
    const seeded = [msg("m-live", NOW.toISOString())];
    const store = new MemoryMirrorStore();
    await store.load();
    const engine = new OhmailEngine({
      adapter: adapterOf(rows, [], seeded.map((m, i) => ({ type: "message", op: "create", id: m.id, seq: i + 1, updatedAt: m.updatedAt, entity: m }))),
      store, now: () => NOW,
    });
    await engine.syncOnce();
    const before = engine.read().list("message").length;
    let at: { date: string | null; id: string } | undefined;
    for (let p = 0; p < 8; p++) {
      const out = await engine.pageStore("all", at ? { before: at } : {});
      expect(out.state).toBe("ready");
      if (out.state !== "ready") return;
      const last = out.items[out.items.length - 1]!;
      at = { date: last.date, id: last.id };
      // The bound holds at every step, not only at the end.
      expect(engine.storePageCacheRows()).toBeLessThanOrEqual(HISTORY_PAGE_CACHE_ROWS);
    }
    expect(at?.id).toBe(rows[399]!.id);
    expect(engine.read().list("message").length).toBe(before);
    expect(store.entries("message").length).toBe(before);
  });

  it("answers a cached page without a request, and one request per page in flight", async () => {
    const calls: string[] = [];
    const engine = new OhmailEngine({ adapter: adapterOf(storeOf(60), calls), now: () => NOW });
    const [a, b] = await Promise.all([engine.pageStore("all"), engine.pageStore("all")]);
    expect(a).toEqual(b);
    expect(calls.length).toBe(1);
    await engine.pageStore("all");
    expect(calls.length).toBe(1);
    engine.resetStorePages();
    await engine.pageStore("all");
    expect(calls.length).toBe(2);
  });

  it("a transport that throws is a failed outcome, never a rejection", async () => {
    const adapter = { ...adapterOf([]), listMessages: () => { throw new Error("boom"); } } as unknown as EngineAdapter;
    const engine = new OhmailEngine({ adapter, now: () => NOW });
    expect(await engine.pageStore("all")).toEqual({ state: "failed", errorClass: "Error" });
  });

  it("no doors, no store reads: the demo and an older adapter answer unavailable", async () => {
    const bare = {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: NOW.toISOString() }),
      mutate: async () => ({ changes: [], seq: null }), fetchBody: async () => null,
    } as unknown as EngineAdapter;
    const engine = new OhmailEngine({ adapter: bare });
    expect(engine.storePagesAvailable()).toBe(false);
    expect(await engine.pageStore("all")).toEqual({ state: "unavailable" });
    expect(await engine.timeline()).toEqual({ state: "unavailable" });
  });
});

describe("a page row takes the mirror's row where it has one", () => {
  it("the live row wins; a tombstone reads as gone; an unknown id keeps the page's row", async () => {
    const live = msg(id(0), NOW.toISOString(), { unread: true });
    const gone = msg(id(1), NOW.toISOString());
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([
      { type: "message", op: "create", id: live.id, seq: 1, updatedAt: live.updatedAt, entity: live },
      { type: "message", op: "create", id: gone.id, seq: 2, updatedAt: gone.updatedAt, entity: gone },
      { type: "message", op: "delete", id: gone.id, seq: 3, updatedAt: gone.updatedAt, entity: null },
    ]);
    const engine = new OhmailEngine({ adapter: adapterOf([]), store, now: () => NOW });
    expect(engine.storePageRow({ ...live, unread: false })?.unread).toBe(true);
    expect(engine.storePageRow(gone)).toBeNull();
    const other = msg(id(2), NOW.toISOString());
    expect(engine.storePageRow(other)).toBe(other);
  });
});

describe("the HTTP door", () => {
  function http(seen: string[], body: unknown): HttpAdapter {
    return new HttpAdapter({
      baseUrl: "https://api.test",
      fetch: (async (url: string) => {
        seen.push(String(url));
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
    });
  }

  it("asks `view=all` with the strict keyset, and reads the timeline", async () => {
    const seen: string[] = [];
    const a = http(seen, { items: [], nextCursor: null });
    await a.listMessages("all", { startBelow: { date: "2026-09-01T00:00:00.000Z", id: id(3) }, limit: 50 });
    await a.listMessages("all", { startBelow: { date: null, id: UUID_MAX } });
    const q1 = new URL(seen[0]!).searchParams;
    expect([q1.get("view"), q1.get("beforeDate"), q1.get("beforeId"), q1.get("limit")])
      .toEqual(["all", "2026-09-01T00:00:00.000Z", id(3), "50"]);
    const q2 = new URL(seen[1]!).searchParams;
    expect([q2.get("beforeDate"), q2.get("beforeId")]).toEqual([null, UUID_MAX]);

    const t = await http(seen, { total: 1, months: [{ month: "2026-09", count: 1, first: { date: null, id: id(0) } }] }).timeline();
    expect(new URL(seen[2]!).pathname).toBe("/messages/timeline");
    expect(t?.total).toBe(1);
  });

  it("asks the timeline in the reader's zone, so its months are the ones the rows read in", async () => {
    const seen: string[] = [];
    const a = new HttpAdapter({
      baseUrl: "https://api.test",
      readerZone: () => "Europe/Zurich",
      fetch: (async (url: string) => {
        seen.push(String(url));
        return new Response(JSON.stringify({ total: 0, months: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await a.timeline();
    expect(new URL(seen[0]!).searchParams.get("zone")).toBe("Europe/Zurich");
    // A runtime that names no zone asks without one, and the store counts in UTC.
    const b = new HttpAdapter({
      baseUrl: "https://api.test",
      readerZone: () => null,
      fetch: (async (url: string) => {
        seen.push(String(url));
        return new Response(JSON.stringify({ total: 0, months: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await b.timeline();
    expect(new URL(seen[1]!).search).toBe("");
  });

  it("passes the search cursor and reads nextCursor, bounded and indexed", async () => {
    const seen: string[] = [];
    const wire = await http(seen, {
      items: [], total: 0, nextCursor: "c2", bounded: true, indexed: { done: 3, total: 10 }, ms: 7,
    }).searchServer("axa", { cursor: "c1", parts: "page" });
    expect(new URL(seen[0]!).searchParams.get("cursor")).toBe("c1");
    expect(wire).toMatchObject({ nextCursor: "c2", bounded: true, indexed: { done: 3, total: 10 }, ms: 7 });
  });
});
