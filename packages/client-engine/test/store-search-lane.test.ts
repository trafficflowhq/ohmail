/**
 * EACH QUESTION ASKS UNDER ITS WALKER'S LANE: one id per walker and one generation per question on
 * every request (pages, the estimate, the summary), a later question the same id with a higher
 * generation, so the desktop engine can drop the older one's requests. Off by default: the web and
 * the phone ask exactly what they asked before. The HTTP adapter carries it as one header.
 */
import { describe, expect, it } from "vitest";
import { HttpAdapter, OhmailEngine, StoreSearchWalker, type ServerSearchOpts } from "../src/index.js";
import { FakeStore, settle } from "./helpers/fake-store.js";

const CUT_ROWS = 74_000;
type Lane = { id: string; generation: number };
const laneOf = (o: ServerSearchOpts): Lane | undefined => (o as ServerSearchOpts & { lane?: Lane }).lane;

async function walkerOn(fake: FakeStore): Promise<StoreSearchWalker> {
  return new StoreSearchWalker(await fake.engine());
}

describe("a search's lane", () => {
  it("one id and one generation for every request of a question, its later pages too", async () => {
    const fake = new FakeStore(CUT_ROWS, { mirror: 20, engine: { searchSupersede: true } });
    const walker = await walkerOn(fake);
    walker.start({ query: "invoice" }, () => [], 0);
    await settle();
    walker.more();
    await settle();
    expect(fake.searched).toEqual(["page", "estimate", "summary", "page"]);
    const lanes = fake.searchedWith.map(laneOf);
    expect(lanes[0]).toMatchObject({ id: expect.stringMatching(/^[a-z0-9]{1,32}$/), generation: expect.any(Number) });
    expect(Number.isSafeInteger(lanes[0]!.generation)).toBe(true);
    for (const l of lanes) expect(l).toEqual(lanes[0]);
  });

  it("the next question: the same id, a higher generation", async () => {
    const fake = new FakeStore(CUT_ROWS, { mirror: 20, engine: { searchSupersede: true } });
    const walker = await walkerOn(fake);
    walker.start({ query: "invoice" }, () => [], 0);
    await settle();
    const a = laneOf(fake.searchedWith[0]!)!;
    walker.start({ query: "note" }, () => [], 0);
    await settle();
    const b = laneOf(fake.searchedWith[3]!)!;
    expect(fake.searched.slice(3)).toEqual(["page", "estimate", "summary"]);
    expect(b.id).toBe(a.id);
    expect(b.generation).toBeGreaterThan(a.generation);
  });

  it("two walkers ask under two ids", async () => {
    const fake = new FakeStore(CUT_ROWS, { mirror: 20, engine: { searchSupersede: true } });
    const engine = await fake.engine();
    new StoreSearchWalker(engine).start({ query: "invoice" }, () => [], 0);
    await settle();
    new StoreSearchWalker(engine).start({ query: "note" }, () => [], 0);
    await settle();
    expect(laneOf(fake.searchedWith[0]!)!.id).not.toBe(laneOf(fake.searchedWith[3]!)!.id);
  });

  it("CONTROL: the option off, no lane reaches the adapter", async () => {
    const fake = new FakeStore(CUT_ROWS, { mirror: 20 });
    const walker = await walkerOn(fake);
    walker.start({ query: "invoice" }, () => [], 0);
    await settle();
    expect(fake.searched).toEqual(["page", "estimate", "summary"]);
    for (const o of fake.searchedWith) expect(Object.hasOwn(o, "lane")).toBe(false);
  });
});

describe("the HTTP adapter's lane header", () => {
  const sent = async (opts: ServerSearchOpts & { lane?: Lane }): Promise<Headers> => {
    let headers = new Headers();
    const fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
      headers = new Headers(init?.headers);
      return new Response(JSON.stringify({ items: [], total: 0 }), { status: 200, headers: { "content-type": "application/json" } });
    };
    await new HttpAdapter({ baseUrl: "http://local", fetch }).searchServer("invoice", opts);
    return headers;
  };

  it("is set from the lane", async () => {
    expect((await sent({ parts: "page", lane: { id: "w1abc", generation: 7 } })).get("x-ohmail-search-lane")).toBe("w1abc.7");
  });

  it("CONTROL: is absent without one", async () => {
    expect((await sent({ parts: "page" })).has("x-ohmail-search-lane")).toBe(false);
  });
});
