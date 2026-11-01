/**
 * THE PHONE SAYS WHAT ITS SEARCH COVERED DURING A FIRST SYNC, by the browser's
 * rule: the one walker carries the route's `importing` (its route half is
 * `packages/client-engine/test/search-first-sync.test.ts`), the count line says "the mail synced
 * so far", the screen adds that the rest is not in and scopes the closest-words note. A store
 * that holds the whole mailbox reads as it always did.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type ServerSearchOpts,
  type SyncResponse,
} from "@ohmail/client-engine";
import { Copy } from "../src/copy";
import { storeSearchWalkerFor } from "../src/state/live";
import { searchCountLine } from "../src/state/search-count";

const NOW = new Date("2026-09-26T16:42:00.000Z");
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const web = JSON.parse(read("../../webapp/messages/en.json")) as { search: Record<string, string> };

async function phoneOver(importing: boolean): Promise<OhmailEngine> {
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: NOW.toISOString() }),
    mutate: async () => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    searchServer: async (_q: string, o: ServerSearchOpts) => ({
      items: [], total: o.parts === "page" ? 0 : 2526, totalExact: true, tier: "similar", ms: 50,
      ...(importing ? { importing: true } : {}),
    }),
  } as unknown as EngineAdapter;
  const store = new MemoryMirrorStore();
  await store.load();
  return new OhmailEngine({ adapter, store, now: () => NOW });
}

async function lineOver(importing: boolean) {
  const walker = storeSearchWalkerFor(await phoneOver(importing));
  walker.start({ query: "delivery window 2059" }, () => [], 0);
  await tick();
  return { info: walker.info()!, line: searchCountLine(walker.info()!) };
}

describe("the phone's count line during a first sync", () => {
  it("mid-import: the mail synced so far", async () => {
    const { info, line } = await lineOver(true);
    expect(info.importing).toBe(true);
    expect(line).toBe("Searched the mail synced so far — 2526 with a close word");
    expect(searchCountLine({ total: 50, totalExact: false, about: null, importing: true })).toBe("Searched the mail synced so far — at least 50 matched");
    expect(searchCountLine({ total: 50, totalExact: false, about: 900, importing: true })).toBe("Searched the mail synced so far — about 900 matched");
    expect(searchCountLine({ total: 0, totalExact: true, about: null, importing: true })).toBe("Searched the mail synced so far — nothing matched");
  });

  it("closest words are counted as near, never as matched, in both scopes", () => {
    expect(searchCountLine({ total: 27, totalExact: true, about: null, tier: "similar" })).toBe("Searched your whole mailbox — 27 with a close word");
    expect(searchCountLine({ total: 50, totalExact: false, about: null, tier: "similar" })).toBe("Searched your whole mailbox — at least 50 with a close word");
    expect(searchCountLine({ total: 3, totalExact: true, about: null, importing: true, tier: "similar" })).toBe("Searched the mail synced so far — 3 with a close word");
    expect(searchCountLine({ total: 27, totalExact: true, about: null, tier: "exact" })).toBe("Searched your whole mailbox — 27 matched");
  });

  it("the complete-store control: the whole mailbox, as before", async () => {
    const { info, line } = await lineOver(false);
    expect(info.importing).toBe(false);
    expect(line).toBe("Searched your whole mailbox — 2526 with a close word");
  });

  it("the screen says the rest is not in and scopes the closest-words note; the hook hands it the reading", () => {
    const screen = read("../app/search.tsx");
    expect(screen).toContain('store.verdict === "ready" && store.importing ? (');
    expect(screen).toContain("{Copy.searchSyncing}");
    expect(screen).toContain("store.ready && store.importing ? Copy.searchSimilarHintSynced : Copy.searchSimilarHint");
    expect(read("../src/state/store-views.ts")).toContain("importing: info?.importing === true");
  });

  it("the sentences are the browser's, word for word", () => {
    const s = web.search as Record<"syncing" | "similarHintSynced" | "scopeSynced" | "scopeSyncedAtLeast" | "scopeSyncedAbout", string>;
    expect(Copy.searchSyncing).toBe(s.syncing);
    expect(Copy.searchSimilarHintSynced).toBe(s.similarHintSynced);
    expect(Copy.searchSyncedAtLeast(7)).toBe(s.scopeSyncedAtLeast.replace("{total, number}", "7"));
    expect(Copy.searchSyncedAbout(7)).toBe(s.scopeSyncedAbout.replace("{total, number}", "7"));
    expect(Copy.searchSynced(7)).toBe(s.scopeSynced.replace(/\{total, plural.*\}\}$/, "7 matched"));
    expect(Copy.searchSynced(0)).toBe(s.scopeSynced.replace(/\{total, plural.*\}\}$/, "nothing matched"));
  });
});
