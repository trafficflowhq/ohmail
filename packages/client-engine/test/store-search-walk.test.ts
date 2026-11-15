/**
 * SEARCH TAKES HISTORY'S WINDOW — one question's matches walked
 * a page at a time by the store's own cursor, on the walk History uses: at most
 * `HISTORY_PAGE_CACHE_ROWS` rows held however far it goes, a page evicted off screen asked again
 * by the cursor that first asked it, and the device's first paint kept in place under relevance.
 */
import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_PAGES_FOLLOWED,
  HISTORY_PAGE_CACHE_ROWS,
  HISTORY_PAGE_ROWS,
  PagedWalk,
  STORE_ANSWER_TIMEOUT_MS,
  STORE_PAGE_RETRY_MS,
  StoreSearchWalker,
  type EngineMessage,
  type OhmailEngine,
  type PageAnswer,
} from "../src/index.js";
import { FakeStore, idOf, settle, storeMessage } from "./helpers/fake-store.js";

const STORE_ROWS = 74_000;

/** Every message object reachable from the walker's own fields — it may hold positions only. */
function rowsHeldBy(walker: StoreSearchWalker): number {
  const seen = new Set<unknown>();
  let rows = 0;
  const walk = (v: unknown, depth: number): void => {
    if (v === null || typeof v !== "object" || seen.has(v) || depth > 6) return;
    seen.add(v);
    if ("subject" in (v as object) && "folder" in (v as object)) { rows += 1; return; }
    for (const [k, x] of Object.entries(v as object)) {
      if (k === "engine" || k === "source" || k === "hooks" || k === "heldRows") continue;
      walk(x, depth + 1);
    }
  };
  walk(walker, 0);
  return rows;
}

describe("a Search walked through thousands of matches", () => {
  it("holds no more than the page cache's ceiling, re-asks by cursor on the way back, and knows its end", async () => {
    const fake = new FakeStore(STORE_ROWS, { mirror: 20 });
    const engine = await fake.engine();
    const matches = fake.rows.filter((m) => m.subject.includes("invoice"));
    expect(matches.length).toBeGreaterThanOrEqual(3_000);
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "invoice", sort: "date_desc" }, () => [], 0);
    await settle();
    expect(walker.state()).toBe("ready");
    let peak = 0;
    for (let guard = 0; guard < 200 && !walker.atEnd(); guard++) {
      const end = walker.length();
      walker.want(Math.max(0, end - 20), end);
      walker.more();
      await settle(4);
      peak = Math.max(peak, engine.storePageCacheRows());
      expect(rowsHeldBy(walker), "the walker holds positions, never rows").toBe(0);
    }
    expect(walker.atEnd()).toBe(true);
    expect(walker.length()).toBe(matches.length);
    expect(peak, "the one bound, however far the list went").toBeLessThanOrEqual(HISTORY_PAGE_CACHE_ROWS);
    const cursorAt = (slot: number) => `search:${slot === 0 ? "-" : String(slot)}`;
    const firstWalk = fake.asked.filter((a) => a.startsWith("search:"));
    expect(new Set(firstWalk).size, "one request per page, none repeated").toBe(firstWalk.length);

    // Back to a page the cache evicted: asked again, by the cursor that asked it first.
    expect(walker.rowAt(1_500), "evicted off screen").toBeNull();
    const before = fake.asked.length;
    walker.want(1_500, 1_520);
    await settle();
    expect(fake.asked.slice(before)).toEqual([cursorAt(1_500)]);
    expect((walker.rowAt(1_500) as EngineMessage).id).toBe(matches[1_500]!.id);

    // And to the top: page one by no cursor at all.
    const top = fake.asked.length;
    walker.want(0, 20);
    await settle();
    expect(fake.asked.slice(top)).toEqual([cursorAt(0)]);
    expect((walker.rowAt(0) as EngineMessage).id).toBe(matches[0]!.id);
    expect(engine.storePageCacheRows()).toBeLessThanOrEqual(HISTORY_PAGE_CACHE_ROWS);
  });

  it("under relevance the device's rows keep their places in page one, and the store's follow", async () => {
    const fake = new FakeStore(STORE_ROWS, { mirror: 20 });
    const engine = await fake.engine();
    const matches = fake.rows.filter((m) => m.subject.includes("invoice"));
    const device = [matches[7]!.id, matches[3]!.id, idOf(1)];
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "invoice" }, () => device, 0);
    await settle();
    const firstPage = Array.from({ length: HISTORY_PAGE_ROWS }, (_, i) => (walker.rowAt(i) as EngineMessage).id);
    expect(firstPage.slice(0, 2), "the device's rows the store also found, where the device put them")
      .toEqual([matches[7]!.id, matches[3]!.id]);
    expect(new Set(firstPage).size).toBe(HISTORY_PAGE_ROWS);
    expect(firstPage.slice(2)).toEqual(matches.slice(0, HISTORY_PAGE_ROWS).map((m) => m.id).filter((id) => !device.includes(id)));
  });

  it("a verb on a Search row goes through the one door: the row leaves at the press", async () => {
    const fake = new FakeStore(STORE_ROWS, { mirror: 20 });
    const engine = await fake.engine();
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "invoice" }, () => [], 0);
    await settle();
    const row = walker.rowAt(10) as EngineMessage;
    expect(engine.read().get("message", row.id)).toBeUndefined();
    const pending = engine.mutate({ kind: "message_delete", messageId: row.id });
    expect(walker.rowAt(10), "gone within one paint").toBe("gone");
    expect((await pending).status).toBe("confirmed");
    expect(walker.rowAt(10)).toBe("gone");
  });
});

/** One scripted page: its rows and the cursor after it; `fail` throws on the wire. */
type Scripted = { rows: number[]; next: string | null } | "fail";

/**
 * A STORE THAT ANSWERS AS SCRIPTED, by `question:cursor` (`-` for page one). A filter without words
 * walks a bounded number of letters a page, so it may rightly answer an empty page with a cursor.
 */
async function scripted(pages: Record<string, Scripted>, held: Record<string, Promise<void>> = {}): Promise<{
  engine: OhmailEngine; asked: string[]; parts: string[];
}> {
  const fake = new FakeStore(0);
  const asked: string[] = [];
  const parts: string[] = [];
  fake.adapter.searchServer = async (q, o) => {
    parts.push(o.parts ?? "both");
    const total = Object.entries(pages).reduce((n, [k, p]) => n + (k.startsWith(`${q}:`) && p !== "fail" ? p.rows.length : 0), 0);
    if (o.parts === "estimate" || o.parts === "summary") return { items: [], total, totalExact: true, tier: "exact", ms: 1 };
    const key = `${q}:${o.cursor ?? "-"}`;
    asked.push(key);
    await held[key];
    const page = pages[key];
    if (page === undefined || page === "fail") throw new Error("store down");
    return { items: page.rows.map((n) => storeMessage(n)), total, totalExact: false, tier: "exact", ms: 1, nextCursor: page.next };
  };
  return { engine: await fake.engine(), asked, parts };
}

const empty = (next: string | null): Scripted => ({ rows: [], next });

describe("an empty page with a cursor is not an answer: the list follows it", () => {
  it("two empty pages with cursors, then rows: the rows after one ask, each page once and in order, searching throughout", async () => {
    const { engine, asked, parts } = await scripted({
      "unread:-": empty("c1"), "unread:c1": empty("c2"), "unread:c2": { rows: [40, 41, 42], next: null },
    });
    const walker = new StoreSearchWalker(engine);
    const seen: string[] = [];
    walker.subscribe(() => seen.push(`${walker.state()}:${walker.length()}`));
    walker.start({ query: "unread" }, () => [], 0);
    await settle();
    expect(asked).toEqual(["unread:-", "unread:c1", "unread:c2"]);
    expect(walker.state()).toBe("ready");
    expect(walker.length()).toBe(3);
    expect((walker.rowAt(0) as EngineMessage).id).toBe(idOf(40));
    expect(walker.atEnd()).toBe(true);
    expect(new Set(seen), "never an empty answer on the way").toEqual(new Set(["searching:0", "ready:3"]));
    expect(parts, "the count follows the page that settled the question, once").toEqual(["page", "page", "page", "estimate"]);
    walker.more();
    await settle();
    expect(asked, "the end is the end").toHaveLength(3);
  });

  it(`after ${EMPTY_PAGES_FOLLOWED} empty pages in a row the walk waits in a state of its own; "look further" asks the next ones`, async () => {
    expect(EMPTY_PAGES_FOLLOWED, "the ruling's bound").toBe(5);
    const pages: Record<string, Scripted> = {};
    for (let i = 0; i < 12; i++) pages[`old:${i === 0 ? "-" : `c${i}`}`] = empty(`c${i + 1}`);
    pages["old:c6"] = { rows: [7, 8], next: "c7" };
    const { engine, asked } = await scripted(pages);
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "old" }, () => [], 0);
    await settle();
    expect(asked).toEqual(["old:-", "old:c1", "old:c2", "old:c3", "old:c4"]);
    expect(walker.state()).toBe("unfinished");
    expect(walker.atBound()).toBe(true);
    expect(walker.atEnd()).toBe(false);
    expect(walker.info(), "no reading of a match set that was not found").toBeNull();
    expect(walker.length()).toBe(0);
    walker.more();
    await settle();
    expect(asked, "nothing more by itself").toHaveLength(EMPTY_PAGES_FOLLOWED);

    walker.further();
    expect(walker.state(), "looking further is searching").toBe("searching");
    await settle();
    expect(asked.slice(5)).toEqual(["old:c5", "old:c6"]);
    expect(walker.state()).toBe("ready");
    expect(walker.atBound()).toBe(false);
    expect(walker.length()).toBe(2);
    expect((walker.rowAt(1) as EngineMessage).id).toBe(idOf(8));

    // Deeper, the same bound with the rows kept on screen; "look further" asks the next five.
    walker.more();
    await settle();
    expect(asked.slice(7)).toEqual(["old:c7", "old:c8", "old:c9", "old:c10", "old:c11"]);
    expect(walker.state(), "the rows stay").toBe("ready");
    expect(walker.length()).toBe(2);
    expect(walker.atBound()).toBe(true);
    walker.more();
    await settle();
    expect(asked).toHaveLength(12);
    walker.further();
    await settle();
    expect(asked.slice(12), "the next one; the script fails past it").toEqual(["old:c12"]);
  });

  it("an empty page WITHOUT a cursor is nothing found, at once", async () => {
    const { engine, asked } = await scripted({ "none:-": empty(null) });
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "none" }, () => [], 0);
    await settle();
    expect(asked).toEqual(["none:-"]);
    expect(walker.state()).toBe("ready");
    expect(walker.length()).toBe(0);
    expect(walker.atEnd()).toBe(true);
    expect(walker.atBound()).toBe(false);
  });

  it("a page with rows and a cursor: as before, the next page on more()", async () => {
    const { engine, asked } = await scripted({ "inv:-": { rows: [1, 2], next: "c1" }, "inv:c1": { rows: [3], next: null } });
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "inv" }, () => [], 0);
    await settle();
    expect(asked).toEqual(["inv:-"]);
    expect(walker.length()).toBe(2);
    walker.more();
    await settle();
    expect(asked).toEqual(["inv:-", "inv:c1"]);
    expect(walker.length()).toBe(3);
    expect(walker.atEnd()).toBe(true);
  });

  it("a question typed while the walk follows: the old walk's pages never land in the new list", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { engine, asked } = await scripted({
      "aa:-": empty("c1"), "aa:c1": { rows: [1, 2, 3], next: "c2" }, "aa:c2": { rows: [4], next: null },
      "bb:-": { rows: [9], next: null },
    }, { "aa:c1": gate });
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "aa" }, () => [], 0);
    await settle();
    expect(asked, "the old walk is following").toEqual(["aa:-", "aa:c1"]);
    expect(walker.state()).toBe("searching");
    walker.start({ query: "bb" }, () => [], 0);
    await settle();
    release();
    await settle();
    expect(asked).toEqual(["aa:-", "aa:c1", "bb:-"]);
    expect(walker.state()).toBe("ready");
    expect(walker.length()).toBe(1);
    expect((walker.rowAt(0) as EngineMessage).id).toBe(idOf(9));
    expect(walker.rowAt(1)).toBeNull();
  });

  it("a store that fails mid-follow: the question unanswered on page one, and deeper the reach kept for the retry", async () => {
    const first = await scripted({ "x:-": empty("c1"), "x:c1": "fail" });
    const one = new StoreSearchWalker(first.engine);
    one.start({ query: "x" }, () => [], 0);
    await settle();
    expect(first.asked).toEqual(["x:-", "x:c1"]);
    expect(one.state()).toBe("unanswered");
    expect(one.failureCause()).not.toBeNull();
    expect(one.info()).toBeNull();

    let now = 0;
    const pages: Record<string, Scripted> = {
      "y:-": { rows: [1], next: "c1" }, "y:c1": empty("c2"), "y:c2": "fail",
    };
    const deep = await scripted(pages);
    const walker = new StoreSearchWalker(deep.engine, () => now);
    walker.start({ query: "y" }, () => [], 0);
    await settle();
    walker.more();
    await settle();
    expect(deep.asked).toEqual(["y:-", "y:c1", "y:c2"]);
    expect(walker.state(), "the rows stay on screen").toBe("ready");
    expect(walker.length()).toBe(1);
    walker.more();
    await settle();
    expect(deep.asked, "not again before the retry's wait").toHaveLength(3);
    pages["y:c2"] = { rows: [2, 3], next: null };
    now += STORE_PAGE_RETRY_MS;
    walker.more();
    await settle();
    expect(deep.asked.slice(3), "the followed page, not the empty one before it").toEqual(["y:c2"]);
    expect(walker.length()).toBe(3);
    expect(walker.atEnd()).toBe(true);
  });

  it("a followed page one, walked past the page cache: on the way back the top is asked by its followed cursor, once", async () => {
    const pages: Record<string, Scripted> = { "old:-": empty("p0") };
    for (let k = 0; k < 8; k++) {
      pages[`old:p${k}`] = { rows: Array.from({ length: 50 }, (_, i) => k * 50 + i), next: k < 7 ? `p${k + 1}` : null };
    }
    const { engine, asked } = await scripted(pages);
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "old", sort: "date_desc" }, () => [], 0);
    await settle();
    expect(asked).toEqual(["old:-", "old:p0"]);
    expect((walker.rowAt(0) as EngineMessage).id).toBe(idOf(0));
    for (let guard = 0; guard < 40 && !walker.atEnd(); guard++) {
      const end = walker.length();
      walker.want(Math.max(0, end - 20), end);
      walker.more();
      await settle(4);
    }
    expect(walker.length()).toBe(400);
    expect(walker.rowAt(0), "evicted off screen").toBeNull();

    // The way back: a view asks its window again on every revision, as the web's does.
    const before = asked.length;
    let revisions = 0;
    const off = walker.subscribe(() => { revisions += 1; if (revisions < 50) walker.want(0, 20); });
    walker.want(0, 20);
    await settle(60);
    off();
    expect(asked.slice(before), "page one by the cursor the walk followed, not the empty page before it").toEqual(["old:p0"]);
    expect((walker.rowAt(0) as EngineMessage).id).toBe(idOf(0));
    expect(revisions, "one revision, no loop").toBe(1);
  });
});

/** Five empty pages with cursors, then (unless `hang`) one row at `c5`; a hung page never answers. */
function fiveEmptyThen(hang: boolean): { pages: Record<string, Scripted>; held: Record<string, Promise<void>> } {
  const pages: Record<string, Scripted> = {};
  for (let i = 0; i < EMPTY_PAGES_FOLLOWED; i++) pages[`late:${i === 0 ? "-" : `c${i}`}`] = empty(`c${i + 1}`);
  pages["late:c5"] = { rows: [1], next: null };
  return { pages, held: hang ? { "late:c5": new Promise<void>(() => undefined) } : {} };
}

describe("look further is a wait of its own", () => {
  it("the time said after a pause at the bound is the press's own wait, not the time spent reading", async () => {
    const { pages } = fiveEmptyThen(false);
    const { engine } = await scripted(pages);
    const said: number[] = [];
    (engine as unknown as { reportSearchPhases: (p: { roundTripMs: number }) => void }).reportSearchPhases = (p) => said.push(p.roundTripMs);
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "late" }, () => [], 0);
    await settle(30);
    expect(walker.state()).toBe("unfinished");
    walker.painted();
    await new Promise((r) => setTimeout(r, 400)); // the person reads the screen at the bound
    walker.further();
    await settle(30);
    expect(walker.state()).toBe("ready");
    walker.painted();
    expect(walker.info()!.waitedMs!, "the press's wait").toBeLessThan(200);
    expect(said).toHaveLength(1);
    expect(said[0]!, "the round trip the log reads").toBeLessThan(200);
  });

  it("a press inside the question's first ceiling is not cut short: the ceiling counts from the press", async () => {
    const { pages, held } = fiveEmptyThen(true);
    const { engine } = await scripted(pages, held);
    vi.useFakeTimers();
    try {
      const walker = new StoreSearchWalker(engine);
      walker.start({ query: "late" }, () => [], 0);
      await vi.advanceTimersByTimeAsync(50);
      expect(walker.state()).toBe("unfinished");
      await vi.advanceTimersByTimeAsync(10_000 - 50);
      walker.further();
      expect(walker.state()).toBe("searching");
      await vi.advanceTimersByTimeAsync(STORE_ANSWER_TIMEOUT_MS - 1);
      expect(walker.state(), "the question's own ceiling has passed, the press's has not").toBe("searching");
      await vi.advanceTimersByTimeAsync(2);
      expect(walker.state()).toBe("unanswered");
      expect(walker.failureCause()).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a press after the question's ceiling into a store that hangs ends unanswered at its own ceiling", async () => {
    const { pages, held } = fiveEmptyThen(true);
    const { engine } = await scripted(pages, held);
    vi.useFakeTimers();
    try {
      const walker = new StoreSearchWalker(engine);
      walker.start({ query: "late" }, () => [], 0);
      await vi.advanceTimersByTimeAsync(STORE_ANSWER_TIMEOUT_MS + 1_000);
      expect(walker.state()).toBe("unfinished");
      walker.further();
      await vi.advanceTimersByTimeAsync(STORE_ANSWER_TIMEOUT_MS - 1);
      expect(walker.state()).toBe("searching");
      await vi.advanceTimersByTimeAsync(2);
      expect(walker.state(), "said, never searching for ever").toBe("unanswered");
      expect(walker.failureCause(), "the state the screen's retry reads").toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Eight pages of fifty rows (`p0` … `p7`) behind question `q`. After each page `gapAfter` names, its
 * cursor leads through two EMPTY pages with cursors before the next page of rows; `emptyFirst` puts
 * one empty page with a cursor before page one.
 */
function gappedPages(gapAfter: number[], emptyFirst = false): Record<string, Scripted> {
  const pages: Record<string, Scripted> = {};
  for (let k = 0; k < 8; k++) {
    pages[`q:p${k}`] = { rows: Array.from({ length: 50 }, (_, i) => k * 50 + i), next: k === 7 ? null : gapAfter.includes(k) ? `e${k}a` : `p${k + 1}` };
    pages[`q:e${k}a`] = empty(`e${k}b`);
    pages[`q:e${k}b`] = empty(`p${k + 1}`);
  }
  pages["q:-"] = emptyFirst ? empty("p0") : pages["q:p0"]!;
  return pages;
}

/** Walk the whole list as a reader at its end does: past the page cache. */
async function walkToEnd(walker: StoreSearchWalker): Promise<void> {
  for (let guard = 0; guard < 60 && !walker.atEnd(); guard++) {
    const end = walker.length();
    walker.want(Math.max(0, end - 20), end);
    if (walker.atBound()) walker.further(); else walker.more();
    await settle(4);
  }
}

/** A view that asks its window again on every revision, as the web's does; returns how many it saw. */
async function look(walker: StoreSearchWalker, a: number, b: number): Promise<number> {
  let revisions = 0;
  const off = walker.subscribe(() => { revisions += 1; if (revisions < 100) walker.want(a, b); });
  walker.want(a, b);
  await settle(40);
  off();
  return revisions;
}

const idAt = (walker: StoreSearchWalker, i: number): string => {
  const r = walker.rowAt(i);
  return r === null || r === "gone" ? String(r) : r.id;
};

/** To the end, a jump to the top, then down through the list again: every screen drawn, no empty page asked. */
async function downAgainFromTheTop(gapAfter: number[], emptyFirst: boolean): Promise<void> {
  const { engine, asked } = await scripted(gappedPages(gapAfter, emptyFirst));
  const walker = new StoreSearchWalker(engine);
  walker.start({ query: "q", sort: "date_desc" }, () => [], 0);
  await settle();
  await walkToEnd(walker);
  expect(walker.length()).toBe(400);
  expect(walker.rowAt(0), "evicted off screen").toBeNull();
  expect(walker.rowAt(60), "evicted off screen").toBeNull();
  const before = asked.length;
  for (const [a, b] of [[0, 20], [20, 40], [40, 60], [60, 80], [90, 110], [140, 160], [160, 180], [190, 210]] as const) {
    const revisions = await look(walker, a, b);
    const blank = Array.from({ length: b - a }, (_, k) => a + k).filter((i) => idAt(walker, i) !== idOf(i));
    expect(blank, `rows [${a}, ${b}) drawn`).toEqual([]);
    expect(revisions, `rows [${a}, ${b}): no loop of asks`).toBeLessThan(10);
  }
  expect(asked.slice(before).filter((k) => /^q:e/.test(k)), "no empty page is asked on the way back").toEqual([]);
}

describe("a followed position below page one survives the page above it landing again", () => {
  it("rows, two empty pages with cursors, rows: past the page cache, to the top, down again — the rows below the gap come back, asked once by the followed cursor", async () => {
    await downAgainFromTheTop([0], false);
    // …and exactly how: the way back to slot 50 asks `p1` once, never the first empty page's cursor.
    const { engine, asked } = await scripted(gappedPages([0]));
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "q", sort: "date_desc" }, () => [], 0);
    await settle();
    await walkToEnd(walker);
    await look(walker, 0, 20);
    expect(idAt(walker, 0)).toBe(idOf(0));
    const before = asked.length;
    await look(walker, 50, 70);
    expect(asked.slice(before)).toEqual(["q:p1"]);
    expect(idAt(walker, 55)).toBe(idOf(55));
  });

  it("two followed slots (page one and slot 50; slots 50 and 150): each keeps its position", async () => {
    await downAgainFromTheTop([0], true);
    await downAgainFromTheTop([0, 2], false);
  });

  it("the page above lands again with the same rows and another next: the followed slot's cursor goes with everything below, and the new next is followed", async () => {
    const pages = gappedPages([0]);
    const { engine, asked } = await scripted(pages);
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "q", sort: "date_desc" }, () => [], 0);
    await settle();
    await walkToEnd(walker);
    expect(walker.rowAt(0), "evicted off screen").toBeNull();
    // Read again, page one ends on another empty page's cursor than the first time.
    pages["q:-"] = { rows: Array.from({ length: 50 }, (_, i) => i), next: "x0" };
    pages["q:x0"] = empty("p1");
    const before = asked.length;
    await scrollTo(walker, 0);
    expect([walker.length(), walker.atEnd()], "the list ends at the page that leads elsewhere now").toEqual([50, false]);
    const list = range(0, 400);
    expect(await readAs(walker, 20, 80, list)).toEqual([]);
    expect(asked.slice(before), "the new next is walked; the old one's place is not kept").toEqual(["q:-", "q:x0", "q:p1"]);
    expect(await readAs(walker, 80, list.length, list)).toEqual([]);
    expect([walker.length(), walker.atEnd()]).toEqual([400, true]);
  });

  it("a new question forgets the old one's followed slots: its own slot 50 takes its own page's next", async () => {
    const pages = gappedPages([0]);
    for (let k = 0; k < 3; k++) pages[`b:${k === 0 ? "-" : `b${k}`}`] = { rows: Array.from({ length: 50 }, (_, i) => 1000 + k * 50 + i), next: k < 2 ? `b${k + 1}` : null };
    const { engine, asked } = await scripted(pages);
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "q", sort: "date_desc" }, () => [], 0);
    await settle();
    walker.want(30, 50);
    walker.more();
    await settle(20);
    expect(asked).toEqual(["q:-", "q:e0a", "q:e0b", "q:p1"]);
    walker.start({ query: "b", sort: "date_desc" }, () => [], 0);
    await settle();
    const before = asked.length;
    for (const end of [50, 100]) {
      walker.want(end - 20, end);
      walker.more();
      await settle(20);
    }
    expect(asked.slice(before)).toEqual(["b:b1", "b:b2"]);
    expect(walker.length()).toBe(150);
    expect(walker.atEnd()).toBe(true);
  });

  it("look further goes on from where it stood after a trip to the top: the third press asks the next five pages, not the first five again", async () => {
    // Four pages of rows, then empty pages with cursors (e1, e2, …).
    const pages: Record<string, Scripted> = {};
    for (let k = 0; k < 4; k++) pages[`q:${k === 0 ? "-" : `p${k}`}`] = { rows: Array.from({ length: 50 }, (_, i) => k * 50 + i), next: k < 3 ? `p${k + 1}` : "e1" };
    pages["q:p0"] = pages["q:-"]!;
    for (let n = 1; n <= 30; n++) pages[`q:e${n}`] = empty(`e${n + 1}`);
    const { engine, asked } = await scripted(pages);
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "q", sort: "date_desc" }, () => [], 0);
    await settle();
    for (let guard = 0; guard < 20 && !walker.atBound(); guard++) {
      const end = walker.length();
      walker.want(Math.max(0, end - 20), end);
      walker.more();
      await settle(6);
    }
    expect(walker.length()).toBe(200);
    expect(walker.atBound()).toBe(true);
    for (let press = 0; press < 2; press++) { walker.further(); await settle(20); }
    expect(asked.filter((k) => k.startsWith("q:e"))).toEqual(Array.from({ length: 15 }, (_, i) => `q:e${i + 1}`));
    // To the top (page one was evicted on the way down) and back to the end of the list.
    await look(walker, 0, 20);
    expect(idAt(walker, 0)).toBe(idOf(0));
    await look(walker, 180, 200);
    expect(idAt(walker, 199)).toBe(idOf(199));
    expect(walker.atBound()).toBe(true);
    const before = asked.length;
    walker.further();
    await settle(20);
    expect(asked.slice(before)).toEqual(["q:e16", "q:e17", "q:e18", "q:e19", "q:e20"]);
  });
});

const range = (a: number, b: number): number[] => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);

/**
 * ONE SCROLL EVENT AT SLOT `a`, as the web's view makes it: the window asked again on every
 * revision, and near the end of the list the next page (or look further). Returns the revisions seen.
 */
async function scrollTo(walker: StoreSearchWalker, a: number): Promise<number> {
  let revisions = 0;
  const b = a + 20;
  const off = walker.subscribe(() => { revisions += 1; if (revisions < 300) walker.want(a, b); });
  walker.want(a, b);
  if (b >= walker.length() - 10) { if (walker.atBound()) walker.further(); else walker.more(); }
  await settle(40);
  off();
  return revisions;
}

/** Screen by screen over `[from, to)` (or up, with a negative `step`): every row the store's `list` holds, no loop. */
async function readAs(walker: StoreSearchWalker, from: number, to: number, list: number[], step = 20): Promise<string[]> {
  const wrong: string[] = [];
  for (let a = from; step > 0 ? a < to : a >= to; a += step) {
    let revisions = await scrollTo(walker, a);
    // A second scroll event where the first one's page grew the list under the window.
    if (range(a, Math.min(a + 20, walker.length())).some((i) => walker.rowAt(i) === null)) revisions = Math.max(revisions, await scrollTo(walker, a));
    const bad = range(a, Math.min(a + 20, list.length)).filter((i) => idAt(walker, i) !== idOf(list[i]!));
    if (bad.length > 0) wrong.push(`[${a}, ${a + 20}): ${bad.length} rows wrong from slot ${bad[0]}, ${walker.rowAt(bad[0]!) === null ? "blank" : "another row"}`);
    if (revisions >= 20) wrong.push(`[${a}, ${a + 20}): ${revisions} revisions, a loop`);
  }
  return wrong;
}

/** Page one (`-`) as the store answers it the second time, the pages that change brings, and the store's whole list then. */
const PAGE_ONE_AGAIN: Record<string, { first?: Scripted; page: Scripted; extra?: Record<string, Scripted>; list: number[] }> = {
  "one row fewer, the same next (a letter stopped matching)": {
    page: { rows: range(0, 49), next: "e0a" }, list: [...range(0, 49), ...range(50, 400)],
  },
  "one row fewer, its row now in the page after (new mail moved the page's edge)": {
    page: { rows: range(0, 49), next: "x0a" }, extra: { "q:x0a": { rows: [49], next: "e0b" } }, list: range(0, 400),
  },
  "several rows fewer": {
    page: { rows: range(0, 45), next: "e0a" }, list: [...range(0, 45), ...range(50, 400)],
  },
  // A page holds fifty rows at most: one row more is a page of 49 rows the first time.
  "one row more (a new letter at the top)": {
    first: { rows: range(0, 49), next: "e0a" },
    page: { rows: [900, ...range(0, 49)], next: "e0a" }, list: [900, ...range(0, 49), ...range(50, 400)],
  },
  "empty now, with a cursor (its rows behind one more empty page)": {
    page: empty("y0"), extra: { "q:y0": { rows: range(0, 50), next: "e0a" } }, list: range(0, 400),
  },
  "empty now, with no cursor (nothing matches any more)": {
    page: empty(null), list: [],
  },
  "one row fewer, and the last page now": {
    page: { rows: range(0, 49), next: null }, list: range(0, 49),
  },
  "the same rows in another order": {
    page: { rows: range(0, 50).reverse(), next: "e0a" }, list: [...range(0, 50).reverse(), ...range(50, 400)],
  },
};

/** Rows, two empty pages with cursors, rows (`gapAfter`): walked to the end, past the page cache. */
async function walkedPast(gapAfter: number[], held: Record<string, Promise<void>> = {}, first?: Scripted, sort: "date_desc" | "relevance" = "date_desc"): Promise<{
  walker: StoreSearchWalker; pages: Record<string, Scripted>; asked: string[];
}> {
  const pages = gappedPages(gapAfter);
  if (first !== undefined) pages["q:-"] = first;
  const { engine, asked } = await scripted(pages, held);
  const walker = new StoreSearchWalker(engine);
  walker.start({ query: "q", sort }, () => [], 0);
  await settle();
  return { walker, pages, asked };
}

describe("a page of a cursor's walk that lands again with another number of rows", () => {
  for (const [shape, change] of Object.entries(PAGE_ONE_AGAIN)) {
    it(`the page above a gap, read again on the way back: ${shape} — the store's list row for row, no blank, no loop`, async () => {
      const { walker, pages } = await walkedPast([0], {}, change.first);
      await walkToEnd(walker);
      expect(walker.length()).toBe(change.first === undefined ? 400 : 399);
      expect(walker.rowAt(0), "evicted off screen").toBeNull();
      pages["q:-"] = change.page;
      Object.assign(pages, change.extra ?? {});
      const list = change.list;
      expect(await readAs(walker, 0, Math.max(list.length, 1), list)).toEqual([]);
      expect(walker.length()).toBe(list.length);
      expect(walker.atEnd()).toBe(true);
    });
  }

  it("a page in the middle, above a gap, read again one row shorter on the way UP; then down to the end", async () => {
    const { walker, pages } = await walkedPast([3]);
    await walkToEnd(walker);
    pages["q:p3"] = { rows: range(150, 199), next: "e3a" };
    const list = [...range(0, 199), ...range(200, 400)];
    // Up from the end: every screen above the changed page is as it was.
    expect(await readAs(walker, 380, 0, range(0, 199), -20)).toEqual([]);
    expect(await readAs(walker, 0, list.length, list)).toEqual([]);
    expect(walker.length()).toBe(list.length);
  });

  it("at the bound, two presses deep, then the top read again one row shorter: the list ends there, not at the bound, and look further still goes on", async () => {
    const pages: Record<string, Scripted> = {};
    for (let k = 0; k < 4; k++) pages[`q:${k === 0 ? "-" : `p${k}`}`] = { rows: range(k * 50, k * 50 + 50), next: k < 3 ? `p${k + 1}` : "e1" };
    for (let n = 1; n <= 40; n++) pages[`q:e${n}`] = empty(`e${n + 1}`);
    const { engine } = await scripted(pages);
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "q", sort: "date_desc" }, () => [], 0);
    await settle();
    for (let guard = 0; guard < 20 && !walker.atBound(); guard++) {
      const end = walker.length();
      walker.want(Math.max(0, end - 20), end);
      walker.more();
      await settle(6);
    }
    expect(walker.atBound()).toBe(true);
    walker.further();
    await settle(20);
    expect(walker.atBound()).toBe(true);
    pages["q:-"] = { rows: range(0, 49), next: "p1" };
    await scrollTo(walker, 0);
    expect([walker.length(), walker.atBound(), walker.atEnd()], "the list ends at the short page, with rows: not the bound").toEqual([49, false, false]);
    const list = [...range(0, 49), ...range(50, 200)];
    expect(await readAs(walker, 0, list.length, list)).toEqual([]);
    expect(walker.length()).toBe(list.length);
    expect(walker.atBound(), "the walk is at its bound again, below the rows").toBe(true);
  });

  it("a page below in the air while a page above lands one row shorter: the late answer is not placed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { walker, pages, asked } = await walkedPast([2], { "q:p7": gate });
    for (let guard = 0; guard < 60 && walker.length() < 350; guard++) {
      const end = walker.length();
      walker.want(Math.max(0, end - 20), end);
      walker.more();
      await settle(4);
    }
    expect(walker.length()).toBe(350);
    walker.more(); // the last page, in the air in the down lane
    await settle(4);
    expect(asked.at(-1)).toBe("q:p7");
    pages["q:p3"] = { rows: range(150, 199), next: "p4" };
    walker.want(180, 220); // rows 200 on are held: the up lane asks the page at the followed slot 150
    await settle(20);
    release();
    await settle(20);
    const list = [...range(0, 199), ...range(200, 400)];
    expect(await readAs(walker, 160, list.length, list)).toEqual([]);
    expect(walker.length()).toBe(list.length);
  });
});

/** A keyset store's pages over `rows`: a page is the fifty rows after its cursor, and its cursor names its last row. */
function keysetPages(rows: number[]): Record<string, Scripted> {
  const page = (from: number): Scripted => ({ rows: rows.slice(from, from + 50), next: from + 50 < rows.length ? `k${rows[from + 49]}` : null });
  return Object.fromEntries([["q:-", page(0)], ...rows.map((r, i): [string, Scripted] => [`q:k${r}`, page(i + 1)])]);
}

describe("a page of a cursor's walk that lands again with the same number of rows and another next", () => {
  for (const sort of ["date_desc", "relevance"] as const) {
    it(`a new letter at the top pushed page one's last row into the page after (${sort}): every row the store answers, none left out`, async () => {
      const { walker, pages } = await walkedPast([0], {}, undefined, sort);
      await walkToEnd(walker);
      expect(walker.rowAt(0), "evicted off screen").toBeNull();
      pages["q:-"] = { rows: [900, ...range(0, 49)], next: "x0a" };
      pages["q:x0a"] = { rows: [49], next: "e0b" };
      const list = [900, ...range(0, 400)];
      expect(await readAs(walker, 0, list.length, list)).toEqual([]);
      expect([walker.length(), walker.atEnd()]).toEqual([list.length, true]);
    });
  }

  it("no empty page anywhere: the row pushed out of page one is the next page's first, and the list is one row longer at its end", async () => {
    const pages = keysetPages(range(0, 400));
    const { engine } = await scripted(pages);
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "q", sort: "date_desc" }, () => [], 0);
    await settle();
    await walkToEnd(walker);
    expect([walker.length(), walker.atEnd()]).toEqual([400, true]);
    const list = [900, ...range(0, 400)];
    Object.assign(pages, keysetPages(list));
    expect(await readAs(walker, 0, list.length, list)).toEqual([]);
    expect([walker.length(), walker.atEnd()]).toEqual([401, true]);
  });

  it("the same rows and no cursor now: the store says the list ends at that page, and it does", async () => {
    const { walker, pages } = await walkedPast([0]);
    await walkToEnd(walker);
    pages["q:-"] = { rows: range(0, 50), next: null };
    expect(await readAs(walker, 0, 50, range(0, 50))).toEqual([]);
    expect([walker.length(), walker.atEnd()]).toEqual([50, true]);
  });

  it("the last page read again with the same rows and a cursor now: the list grows again", async () => {
    const { walker, pages } = await walkedPast([]);
    await walkToEnd(walker);
    expect(walker.atEnd()).toBe(true);
    await scrollTo(walker, 0);
    expect(walker.rowAt(399), "evicted off screen").toBeNull();
    pages["q:p7"] = { rows: range(350, 400), next: "p8" };
    pages["q:p8"] = { rows: range(400, 430), next: null };
    const list = range(0, 430);
    expect(await readAs(walker, 0, list.length, list)).toEqual([]);
    expect([walker.length(), walker.atEnd()]).toEqual([430, true]);
  });

  it("the same number of rows and the same next (one row out, one in): nothing below is taken back, and no empty page is asked again", async () => {
    const { walker, pages, asked } = await walkedPast([0, 3]);
    await walkToEnd(walker);
    pages["q:-"] = { rows: [900, ...range(0, 20), ...range(21, 50)], next: "e0a" };
    const list = [900, ...range(0, 20), ...range(21, 400)];
    const before = asked.length;
    expect(await readAs(walker, 0, list.length, list)).toEqual([]);
    expect(asked.slice(before)).toEqual(["q:-", "q:p1", "q:p2", "q:p3", "q:p4", "q:p5", "q:p6", "q:p7"]);
  });
});

describe("after a page took back what was below it, the walk is as on the first way down", () => {
  it("past the page cache and back: every page below is asked from where it stands now, not from where it stood", async () => {
    const { walker, pages } = await walkedPast([0]);
    await walkToEnd(walker);
    pages["q:-"] = { rows: range(0, 49), next: "e0a" };
    const list = [...range(0, 49), ...range(50, 400)];
    expect(await readAs(walker, 0, list.length, list)).toEqual([]);
    const wrong: string[] = [];
    for (const a of [100, 40, 140, 190, 90, 240, 60, 290, 110, 340, 0, 150, 200]) wrong.push(...await readAs(walker, a, a + 20, list));
    expect(wrong).toEqual([]);
    expect(walker.length()).toBe(list.length);
  });

  it(`the page right above the bound's empty pages, read again one row shorter: the walk follows ${EMPTY_PAGES_FOLLOWED} empty pages again before it waits`, async () => {
    const pages: Record<string, Scripted> = {};
    for (let k = 0; k < 6; k++) pages[`q:${k === 0 ? "-" : `p${k}`}`] = { rows: range(k * 50, k * 50 + 50), next: k < 5 ? `p${k + 1}` : "e1" };
    for (let n = 1; n <= 40; n++) pages[`q:e${n}`] = empty(`e${n + 1}`);
    const { engine, asked } = await scripted(pages);
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "q", sort: "date_desc" }, () => [], 0);
    await settle();
    for (let guard = 0; guard < 20 && !walker.atBound(); guard++) {
      const end = walker.length();
      walker.want(Math.max(0, end - 20), end);
      walker.more();
      await settle(6);
    }
    expect([walker.length(), walker.atBound()]).toEqual([300, true]);
    // To the top and three pages down: the last page leaves the page cache.
    for (const a of [0, 50, 100]) await look(walker, a, a + 20);
    expect(walker.rowAt(299), "evicted off screen").toBeNull();
    pages["q:p5"] = { rows: range(250, 299), next: "e1" };
    const before = asked.length;
    await look(walker, 270, 290);
    walker.more();
    await settle(20);
    expect(asked.slice(before)).toEqual(["q:p5", ...Array.from({ length: EMPTY_PAGES_FOLLOWED }, (_, i) => `q:e${i + 1}`)]);
    expect([walker.length(), walker.atBound()]).toEqual([299, true]);
  });
});

describe("under best match, page one read again with other rows: the store's order stands", () => {
  it("no empty page anywhere: page one read again one row shorter — every row the store answered on screen once", async () => {
    const { walker, pages } = await walkedPast([], {}, undefined, "relevance");
    await walkToEnd(walker);
    expect(walker.rowAt(0), "evicted off screen").toBeNull();
    pages["q:-"] = { rows: range(0, 49), next: "p1" };
    const list = [...range(0, 49), ...range(50, 400)];
    expect(await readAs(walker, 0, list.length, list)).toEqual([]);
    expect(walker.length()).toBe(list.length);
  });

  for (const [shape, change] of Object.entries(PAGE_ONE_AGAIN)) {
    it(`the page above a gap, read again: ${shape}`, async () => {
      const { walker, pages } = await walkedPast([0], {}, change.first, "relevance");
      await walkToEnd(walker);
      pages["q:-"] = change.page;
      Object.assign(pages, change.extra ?? {});
      // The same rows again: the order of the first paint stands, so no row moves under the reader.
      const list = shape === "the same rows in another order" ? range(0, 400) : change.list;
      expect(await readAs(walker, 0, Math.max(list.length, 1), list)).toEqual([]);
      expect(walker.length()).toBe(list.length);
    });
  }
});

/** A cursor's walk of its own, pages of thirty rows by cursor (`-` for page one), over a page cache the test holds. */
function cursorWalk(pages: Record<string, { rows: number[]; next: string | null }>): {
  walk: PagedWalk<string>; asked: string[]; evict: (cursor: string) => void;
} {
  const cache = new Map<string, EngineMessage[]>();
  let cacheRev = 0;
  let rev = 0;
  const asked: string[] = [];
  const engine = { storePagesRevision: () => cacheRev, storePageRow: (m: EngineMessage) => m } as unknown as OhmailEngine;
  const walk = new PagedWalk<string>(engine, {
    ask: async (a): Promise<PageAnswer<string>> => {
      const c = a ?? "-";
      asked.push(c);
      const items = pages[c]!.rows.map((n) => storeMessage(n));
      cache.set(c, items);
      cacheRev += 1;
      return { state: "ready", items, next: pages[c]!.next };
    },
    peek: (a) => cache.get(a ?? "-"),
    dedupe: true,
  }, { clock: Date.now, rev: () => rev, changed: () => { rev += 1; } });
  return { walk, asked, evict: (c) => { cache.delete(c); cacheRev += 1; } };
}

describe("rows placed above a walk that followed (Search never places, History never follows: the walk holds both)", () => {
  it("the followed slot moves down with its rows and is asked again by the cursor its follow taught", async () => {
    const pages: Record<string, { rows: number[]; next: string | null }> = {
      "-": { rows: range(0, 30), next: "e1" }, e1: { rows: [], next: "e2" }, e2: { rows: [], next: "p1" },
      p1: { rows: range(30, 60), next: "p2" }, p2: { rows: range(60, 90), next: null },
    };
    const { walk, asked, evict } = cursorWalk(pages);
    walk.fetch(0, null, "down");
    await settle();
    walk.more();
    await settle();
    expect(asked).toEqual(["-", "e1", "e2", "p1"]);
    expect(walkIdAt(walk, 30)).toBe(idOf(30));
    // Three rows arrive above, placed with a fresh page one: 33 rows, its next the first empty page's again.
    pages["-"] = { rows: [900, 901, 902, ...range(0, 30)], next: "e1" };
    walk.place(3, { state: "ready", items: pages["-"].rows.map((n) => storeMessage(n)), next: "e1" });
    evict("p1");
    const before = asked.length;
    for (let i = 0; i < 30 && walk.rowAt(40) === null; i++) { walk.want(33, 53); await settle(2); }
    expect(asked.slice(before), "slot 33 by the followed cursor, never the empty page").toEqual(["p1"]);
    expect(walkIdAt(walk, 33)).toBe(idOf(30));
  });
});

function walkIdAt(walk: PagedWalk<string>, i: number): string {
  const r = walk.rowAt(i);
  return r === null || r === "gone" ? String(r) : r.id;
}
