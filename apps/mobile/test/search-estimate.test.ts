/**
 * THE PHONE'S COUNT FOLLOWS ITS FIRST PAGE, BY THE BROWSER'S RULE: the phone's Search walker is
 * the one walker, so it asks the page, then the estimate,
 * then the exact summary only when the estimate was cut, and the count line reads "about N" from
 * the estimate until the exact count replaces it. Against a store answering the parts' contract.
 */
import type { EngineMessage } from "@ohmail/wire";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type ServerSearchOpts,
  type SyncResponse,
} from "@ohmail/client-engine";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { storeSearchWalkerFor } from "../src/state/live";
import { searchCountLine } from "../src/state/search-count";
import { useStoreSearch, type PhoneStoreSearch } from "../src/state/store-views";

/** The world the phone's Search hook reads: only the store's doors it uses. */
const world = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../src/state/world", () => ({ useWorld: () => world.current }));

const NOW = new Date("2026-09-23T12:00:00.000Z");
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

function msg(i: number): EngineMessage {
  return {
    id: `m${i}`, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: `Invoice ${i}`,
    from: { name: null, address: "billing@example.test" }, to: [], cc: [], date: NOW.toISOString(), folder: "INBOX",
    snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  };
}

/** A store of `matches` hits whose arms keep 200 candidates; the summary waits on `release`. */
async function phoneWith(matches: number): Promise<{ engine: OhmailEngine; asked: string[]; release: () => void }> {
  const asked: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const kept = Math.min(matches, 200);
  const cut = matches > kept;
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: NOW.toISOString() }),
    mutate: async () => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    searchServer: async (_q: string, o: ServerSearchOpts) => {
      asked.push(o.parts ?? "both");
      if (o.parts === "summary") {
        await held;
        return { items: [], total: matches, totalExact: true, ms: 40 };
      }
      if (o.parts === "estimate") {
        return { items: [], total: kept, totalExact: !cut, ...(cut ? { totalEstimate: Math.round(matches * 0.9) } : {}), ms: 3 };
      }
      return { items: Array.from({ length: Math.min(50, kept) }, (_, i) => msg(i)), total: kept, totalExact: !cut, ms: 6 };
    },
  } as unknown as EngineAdapter;
  const store = new MemoryMirrorStore();
  await store.load();
  return { engine: new OhmailEngine({ adapter, store, now: () => NOW }), asked, release };
}

describe("the phone's Search count", () => {
  it("a cut search: page, estimate, summary — about N, then the exact N", async () => {
    const { engine, asked, release } = await phoneWith(7_874);
    const walker = storeSearchWalkerFor(engine);
    walker.start({ query: "invoice" }, () => [], 0);
    await tick();
    expect(asked).toEqual(["page", "estimate", "summary"]);
    expect(walker.length(), "the page is on screen while the summary is out").toBe(50);
    expect(searchCountLine(walker.info()!)).toBe("Searched your whole mailbox — about 7087 matched");
    release();
    await tick();
    expect(searchCountLine(walker.info()!)).toBe("Searched your whole mailbox — 7874 matched");
    expect(asked).toEqual(["page", "estimate", "summary"]);
  });

  it("an uncut search: page and estimate, the exact count, no summary", async () => {
    const { engine, asked } = await phoneWith(38);
    const walker = storeSearchWalkerFor(engine);
    walker.start({ query: "invoice" }, () => [], 0);
    await tick();
    await tick();
    expect(asked).toEqual(["page", "estimate"]);
    expect(searchCountLine(walker.info()!)).toBe("Searched your whole mailbox — 38 matched");
  });

  it("before the estimate says, the page's lower bound", () => {
    expect(searchCountLine({ total: 200, totalExact: false, about: null })).toBe("Searched your whole mailbox — at least 200 matched");
  });

  it("the screen's count line is that rule, and the hook hands it the estimate", () => {
    expect(read("../app/search.tsx")).toContain("searchCountLine(store)");
    expect(read("../src/state/store-views.ts")).toContain("about: info?.about ?? null");
  });
});

describe("the phone's Search past the walk's bound of empty pages", () => {
  it("five empty pages with cursors: the verdict is unfinished, never nothing matched; loadMore looks further", async () => {
    const asked: string[] = [];
    const adapter = {
      sync: async (): Promise<SyncResponse> => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: NOW.toISOString() }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async () => null,
      searchServer: async (_q: string, o: ServerSearchOpts) => {
        if (o.parts === "estimate" || o.parts === "summary") return { items: [], total: 1, totalExact: true, ms: 3 };
        const n = o.cursor ? Number(o.cursor) : 0;
        asked.push(String(n));
        return n < 6 ? { items: [], total: 0, totalExact: false, nextCursor: String(n + 1), ms: 3 }
          : { items: [msg(n)], total: 1, totalExact: false, nextCursor: null, ms: 3 };
      },
    } as unknown as EngineAdapter;
    const store = new MemoryMirrorStore();
    await store.load();
    const walker = storeSearchWalkerFor(new OhmailEngine({ adapter, store, now: () => NOW }));
    world.current = { store: { searchWalker: walker, searchAvailable: true, renewal: null, rowOf: (m: unknown) => m } };
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const result: { current: PhoneStoreSearch | null } = { current: null };
    const Probe = (): null => { result.current = useStoreSearch("old letters", []); return null; };
    let root!: ReturnType<typeof create>;
    await act(async () => { root = create(createElement(Probe)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); await tick(); });
    expect(asked).toEqual(["0", "1", "2", "3", "4"]);
    expect(result.current!.verdict).toBe("unfinished");
    expect(result.current!.ready, "the device's paint stands").toBe(false);
    await act(async () => { result.current!.loadMore(); await tick(); });
    expect(asked).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
    expect(result.current!.verdict).toBe("ready");
    expect(result.current!.length).toBe(1);
    await act(async () => root.unmount());
  });

  it("a followed page one, walked past the page cache: back at the top, page one is asked by its followed cursor", async () => {
    const asked: string[] = [];
    const adapter = {
      sync: async (): Promise<SyncResponse> => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: NOW.toISOString() }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async () => null,
      searchServer: async (_q: string, o: ServerSearchOpts) => {
        if (o.parts === "estimate" || o.parts === "summary") return { items: [], total: 400, totalExact: true, ms: 3 };
        asked.push(o.cursor ?? "-");
        if (!o.cursor) return { items: [], total: 0, totalExact: false, nextCursor: "p0", ms: 3 };
        const k = Number(o.cursor.slice(1));
        return { items: Array.from({ length: 50 }, (_, i) => msg(k * 50 + i)), total: 400, totalExact: false, nextCursor: k < 7 ? `p${k + 1}` : null, ms: 3 };
      },
    } as unknown as EngineAdapter;
    const store = new MemoryMirrorStore();
    await store.load();
    const walker = storeSearchWalkerFor(new OhmailEngine({ adapter, store, now: () => NOW }));
    world.current = { store: { searchWalker: walker, searchAvailable: true, renewal: null, rowOf: (m: unknown) => m } };
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const result: { current: PhoneStoreSearch | null } = { current: null };
    const Probe = (): null => { result.current = useStoreSearch("old letters", []); return null; };
    let root!: ReturnType<typeof create>;
    await act(async () => { root = create(createElement(Probe)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); await tick(); });
    expect(result.current!.length).toBe(50);
    for (let i = 0; i < 7; i++) {
      await act(async () => {
        const s = result.current!;
        s.want(Math.max(0, s.length - 20), s.length);
        s.loadMore();
        await tick(6);
      });
    }
    expect(result.current!.length).toBe(400);
    expect(result.current!.rowAt(0), "evicted off screen").toBeNull();
    const before = asked.length;
    // The reader scrolls back to the top: the screen asks its window on each scroll event.
    for (let i = 0; i < 5; i++) await act(async () => { result.current!.want(0, 20); await tick(6); });
    expect(asked.slice(before)).toEqual(["p0"]);
    expect(result.current!.sourceAt(0)?.id).toBe("m0");
    await act(async () => root.unmount());
  });
});

describe("the phone's Search: a followed position below page one", () => {
  it("rows, two empty pages with cursors, rows: past the page cache, to the top, down again — row 55 is back, asked once by its followed cursor", async () => {
    const asked: string[] = [];
    const adapter = {
      sync: async (): Promise<SyncResponse> => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: NOW.toISOString() }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async () => null,
      searchServer: async (_q: string, o: ServerSearchOpts) => {
        if (o.parts === "estimate" || o.parts === "summary") return { items: [], total: 400, totalExact: true, ms: 3 };
        const cur = o.cursor ?? "p0";
        asked.push(cur);
        if (cur === "e1" || cur === "e2") return { items: [], total: 0, totalExact: false, nextCursor: cur === "e1" ? "e2" : "p1", ms: 3 };
        const k = Number(cur.slice(1));
        return { items: Array.from({ length: 50 }, (_, i) => msg(k * 50 + i)), total: 400, totalExact: false, nextCursor: k === 0 ? "e1" : k < 7 ? `p${k + 1}` : null, ms: 3 };
      },
    } as unknown as EngineAdapter;
    const store = new MemoryMirrorStore();
    await store.load();
    const walker = storeSearchWalkerFor(new OhmailEngine({ adapter, store, now: () => NOW }));
    world.current = { store: { searchWalker: walker, searchAvailable: true, renewal: null, rowOf: (m: unknown) => m } };
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const result: { current: PhoneStoreSearch | null } = { current: null };
    const Probe = (): null => { result.current = useStoreSearch("old letters", []); return null; };
    let root!: ReturnType<typeof create>;
    await act(async () => { root = create(createElement(Probe)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); await tick(); });
    expect(result.current!.length).toBe(50);
    for (let i = 0; i < 7; i++) {
      await act(async () => {
        const s = result.current!;
        s.want(Math.max(0, s.length - 20), s.length);
        s.loadMore();
        await tick(6);
      });
    }
    expect(result.current!.length).toBe(400);
    // The status bar's tap: the top; then the reader scrolls down, the screen asking its window on each scroll event.
    for (let i = 0; i < 3; i++) await act(async () => { result.current!.want(0, 20); await tick(6); });
    expect(result.current!.sourceAt(0)?.id).toBe("m0");
    const before = asked.length;
    for (let i = 0; i < 5; i++) await act(async () => { result.current!.want(45, 70); await tick(6); });
    expect(asked.slice(before)).toEqual(["p1"]);
    expect(result.current!.sourceAt(55)?.id).toBe("m55");
    await act(async () => root.unmount());
  });

  // The page above the gap as the store answers it when the top is read again. A page holds fifty rows at most.
  // Pushed: the same number of rows and another next (a new letter at the top; m49 is the page after's first row now).
  for (const change of ["fewer", "more", "empty", "pushed"] as const) {
    it(`the page above the gap read again with ${change === "pushed" ? "the same number of rows and another next" : "another number of rows"} (${change}): to the end, the top, then down again — every row in its slot`, async () => {
      const asked: string[] = [];
      let again = false;
      const adapter = {
        sync: async (): Promise<SyncResponse> => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: NOW.toISOString() }),
        mutate: async () => ({ changes: [], seq: null }),
        fetchBody: async () => null,
        searchServer: async (_q: string, o: ServerSearchOpts) => {
          if (o.parts === "estimate" || o.parts === "summary") return { items: [], total: 400, totalExact: true, ms: 3 };
          const cur = o.cursor ?? "p0";
          asked.push(cur);
          // Empty now, with a cursor: page one's letters are behind one more empty page.
          if (cur === "p0" && again && change === "empty") return { items: [], total: 0, totalExact: false, nextCursor: "y0", ms: 3 };
          if (cur === "y0") return { items: Array.from({ length: 50 }, (_, i) => msg(i)), total: 400, totalExact: false, nextCursor: "e1", ms: 3 };
          if (cur === "e1" || cur === "e2") return { items: [], total: 0, totalExact: false, nextCursor: cur === "e1" ? "e2" : "p1", ms: 3 };
          if (cur === "p0" && again && change === "pushed") return { items: [msg(900), ...Array.from({ length: 49 }, (_, i) => msg(i))], total: 400, totalExact: false, nextCursor: "x1", ms: 3 };
          if (cur === "x1") return { items: [msg(49)], total: 400, totalExact: false, nextCursor: "e2", ms: 3 };
          const k = Number(cur.slice(1));
          let items = Array.from({ length: 50 }, (_, i) => msg(k * 50 + i));
          // Fewer: m49 stopped matching. More: 49 rows the first time, a new letter above them the second.
          if (k === 0 && (change === "more" || (again && change === "fewer"))) items = items.slice(0, 49);
          if (k === 0 && again && change === "more") items = [msg(900), ...items];
          return { items, total: 400, totalExact: false, nextCursor: k === 0 ? "e1" : k < 7 ? `p${k + 1}` : null, ms: 3 };
        },
      } as unknown as EngineAdapter;
      const store = new MemoryMirrorStore();
      await store.load();
      const walker = storeSearchWalkerFor(new OhmailEngine({ adapter, store, now: () => NOW }));
      world.current = { store: { searchWalker: walker, searchAvailable: true, renewal: null, rowOf: (m: unknown) => m } };
      (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const result: { current: PhoneStoreSearch | null } = { current: null };
      const Probe = (): null => { result.current = useStoreSearch("old letters", []); return null; };
      let root!: ReturnType<typeof create>;
      await act(async () => { root = create(createElement(Probe)); });
      await act(async () => { await new Promise((r) => setTimeout(r, 300)); await tick(); });
      for (let i = 0; i < 7; i++) {
        await act(async () => {
          const s = result.current!;
          s.want(Math.max(0, s.length - 20), s.length);
          s.loadMore();
          await tick(6);
        });
      }
      expect(result.current!.length).toBe(change === "more" ? 399 : 400);
      again = true;
      for (let i = 0; i < 3; i++) await act(async () => { result.current!.want(0, 20); await tick(6); });
      // The reader scrolls down: the screen asks its window on each scroll event, and the next page at the list's end.
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          const s = result.current!;
          s.want(45, 70);
          if (s.length < 80) s.loadMore();
          await tick(6);
        });
      }
      const s = result.current!;
      const ids = [0, 48, 49, 50, 51, 55].map((i) => s.sourceAt(i)?.id ?? (s.rowAt(i) === "gone" ? "gone" : "blank"));
      expect(ids).toEqual(change === "fewer" ? ["m0", "m48", "m50", "m51", "m52", "m56"]
        : change === "more" ? ["m900", "m47", "m48", "m50", "m51", "m55"]
        : change === "pushed" ? ["m900", "m47", "m48", "m49", "m50", "m54"] : ["m0", "m48", "m49", "m50", "m51", "m55"]);
      await act(async () => root.unmount());
    });
  }
});
