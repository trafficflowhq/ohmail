/**
 * THE COUNT RIGHT BEHIND THE PAGE: the walker asks the page,
 * then `parts=estimate`, then the exact summary only when the estimate was cut — three requests at
 * most, the page never waiting for either. "About N" is the estimate's, the exact count replaces
 * it, and the exact facets take the estimate's places. Against the fake store's contract.
 */
import type { EngineMessage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  HISTORY_PAGE_ROWS,
  HttpAdapter,
  MemoryMirrorStore,
  OhmailEngine,
  StoreSearchWalker,
  type ServerSearchFacets,
} from "../src/index.js";
import { facetsInPlace } from "../src/store-timeline.js";
import { FAKE_ARM_PAGES, FakeStore, fakeFacets, settle } from "./helpers/fake-store.js";

const CUT_ROWS = 74_000;
/** 100 matches for "invoice": under four pages' worth of candidates, so no arm is cut. */
const UNCUT_ROWS = 2_000;

describe("a search's count follows its first page", () => {
  it("a CUT search asks page, estimate, summary — about N from the estimate, then the exact N in place", async () => {
    const fake = new FakeStore(CUT_ROWS, { mirror: 20 });
    const engine = await fake.engine();
    const hits = fake.rows.filter((m) => m.subject.includes("invoice"));
    expect(hits.length, "a cut set: more matches than the arms keep").toBeGreaterThan(FAKE_ARM_PAGES * 50);
    const estimate = fake.holdSearch("estimate");
    const summary = fake.holdSearch("summary");
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "invoice" }, () => [], 0);
    await settle();

    // The page is on screen while the estimate is still out.
    expect(fake.searched).toEqual(["page", "estimate"]);
    expect(walker.state()).toBe("ready");
    expect((walker.rowAt(0) as EngineMessage).id).toBe(hits[0]!.id);
    expect(walker.info()).toMatchObject({ totalExact: false, about: null, facets: null });

    estimate();
    await settle();
    expect(fake.searched).toEqual(["page", "estimate", "summary"]);
    const about = Math.round(hits.length * 0.9);
    expect(walker.info()).toMatchObject({ totalExact: false, about, total: FAKE_ARM_PAGES * 50 });
    const drawn = walker.info()!.facets!;
    expect(drawn).toEqual(fakeFacets(hits.slice(0, FAKE_ARM_PAGES * 50)));

    summary();
    await settle();
    expect(walker.info()).toMatchObject({ totalExact: true, about: null, total: hits.length });
    const exact = walker.info()!.facets!;
    expect(exact.sender.map((x) => x.address), "the chips keep their places").toEqual(drawn.sender.map((x) => x.address));
    expect(exact.sender, "and take the exact counts").toEqual(
      drawn.sender.map((x) => fakeFacets(hits).sender.find((y) => y.address === x.address)),
    );
    expect(Object.keys(exact.folder)).toEqual(Object.keys(drawn.folder));
    expect(exact.folder).toEqual(fakeFacets(hits).folder);
    expect(fake.searched, "three requests, no more").toEqual(["page", "estimate", "summary"]);
  });

  it("the estimate asks with the page's limit and filters, never its sort or cursor", async () => {
    const fake = new FakeStore(CUT_ROWS, { mirror: 20 });
    const engine = await fake.engine();
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "invoice", sort: "date_desc", filters: { folder: "INBOX" } }, () => [], 0);
    await settle();
    const [page, estimate, summary] = fake.searchedWith;
    expect(page).toMatchObject({ parts: "page", limit: HISTORY_PAGE_ROWS, sort: "date_desc", filters: { folder: "INBOX" } });
    expect(estimate).toEqual({ parts: "estimate", limit: HISTORY_PAGE_ROWS, filters: { folder: "INBOX" } });
    expect(summary).toEqual({ parts: "summary", filters: { folder: "INBOX" } });
  });

  it("an UNCUT search asks page and estimate — the count exact from the estimate, no summary", async () => {
    const fake = new FakeStore(UNCUT_ROWS, { mirror: 20 });
    const engine = await fake.engine();
    const hits = fake.rows.filter((m) => m.subject.includes("invoice"));
    expect(hits.length).toBeLessThanOrEqual(FAKE_ARM_PAGES * 50);
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "invoice" }, () => [], 0);
    await settle();
    await settle();
    expect(fake.searched).toEqual(["page", "estimate"]);
    expect(walker.info()).toMatchObject({ totalExact: true, about: null, total: hits.length });
    expect(walker.info()!.facets).toEqual(fakeFacets(hits));
  });

  it("an estimate the store refuses is not exact: the summary follows, as before the estimate", async () => {
    const fake = new FakeStore(CUT_ROWS, { mirror: 20 });
    const inner = fake.adapter.searchServer!.bind(fake.adapter);
    fake.adapter.searchServer = async (q, o) => {
      if (o.parts === "estimate") {
        fake.searched.push("estimate");
        throw Object.assign(new Error("parts must be one of both, page, summary"), { status: 400 });
      }
      return inner(q, o);
    };
    const engine = await fake.engine();
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "invoice" }, () => [], 0);
    await settle();
    await settle();
    expect(fake.searched).toEqual(["page", "estimate", "summary"]);
    expect(walker.info()).toMatchObject({ totalExact: true, about: null });
  });

  it("a new question drops the old one's late estimate and asks its own", async () => {
    const fake = new FakeStore(CUT_ROWS, { mirror: 20 });
    const engine = await fake.engine();
    const late = fake.holdSearch("estimate");
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "invoice" }, () => [], 0);
    await settle();
    walker.start({ query: "note 1" }, () => [], 0);
    await settle();
    late();
    await settle();
    const hits = fake.rows.filter((m) => m.subject.includes("note 1"));
    expect(walker.info()).toMatchObject({ totalExact: true, total: hits.length });
    expect(fake.searched, "the old question's estimate asks no summary").toEqual(
      ["page", "estimate", "page", "estimate", "summary"],
    );
  });
});

describe("the engine reads the estimate as its own outcome", () => {
  const NOW = new Date("2026-09-23T12:00:00.000Z");
  async function over(body: Record<string, unknown>): Promise<{ engine: OhmailEngine; urls: string[] }> {
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    const store = new MemoryMirrorStore();
    await store.load();
    return { engine: new OhmailEngine({ adapter: new HttpAdapter({ baseUrl: "https://api.test", fetch }), store, now: () => NOW }), urls };
  }

  it("over the wire: `parts=estimate` with the limit, and `totalEstimate` read — no rows, no cursor", async () => {
    const { engine, urls } = await over({ items: [], total: 200, totalExact: false, totalEstimate: 7_874, tier: "exact", ms: 9, nextCursor: null, bounded: false });
    const out = await engine.searchServer("invoice", { parts: "estimate", limit: 50 });
    expect(new URL(urls[0]!).searchParams.get("parts")).toBe("estimate");
    expect(new URL(urls[0]!).searchParams.get("limit")).toBe("50");
    expect(out).toEqual({
      state: "ready", total: 200, totalExact: false, totalEstimate: 7_874, tier: "exact", ms: 9, indexed: null, facets: null,
    });
  });

  it("an estimate under the candidates reads as the candidates; an exact answer carries none", async () => {
    const low = await over({ items: [], total: 200, totalExact: false, totalEstimate: 150 });
    expect(await low.engine.searchServer("invoice", { parts: "estimate" })).toMatchObject({ totalEstimate: 200 });
    const exact = await over({ items: [], total: 38, totalExact: true, totalEstimate: 40 });
    expect(await exact.engine.searchServer("invoice", { parts: "estimate" })).toMatchObject({ total: 38, totalExact: true, totalEstimate: null });
    const none = await over({ items: [], total: 200, totalExact: false });
    expect(await none.engine.searchServer("invoice", { parts: "estimate" })).toMatchObject({ totalEstimate: null });
  });
});

describe("the exact facets take the estimate's places", () => {
  const f = (sender: Array<[string, number]>, folder: Record<string, number>): ServerSearchFacets => ({
    folder, sender: sender.map(([address, count]) => ({ address, count })),
    hasAttachments: { true: 0, false: 0 }, unread: { true: 0, false: 0 },
  });

  it("same order, exact counts; a newcomer follows, one the exact set lacks goes", () => {
    const drawn = f([["a", 10], ["b", 8], ["c", 5]], { INBOX: 20, News: 3 });
    const exact = f([["b", 30], ["a", 20], ["d", 9]], { News: 40, INBOX: 21, Receipts: 2 });
    const out = facetsInPlace(drawn, exact);
    expect(out.sender).toEqual([{ address: "a", count: 20 }, { address: "b", count: 30 }, { address: "d", count: 9 }]);
    expect(Object.entries(out.folder)).toEqual([["INBOX", 21], ["News", 40], ["Receipts", 2]]);
  });

  it("with nothing drawn the exact set is taken as it is", () => {
    const exact = f([["b", 30], ["a", 20]], { News: 40, INBOX: 21 });
    expect(facetsInPlace(null, exact)).toBe(exact);
  });
});
