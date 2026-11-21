/** @vitest-environment jsdom */
import type { EngineMessage, MutationOutcome } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/react";
import messages from "../messages/en.json";
import { enterSearchRoute, searchField, RegisteredSearch, typeSearch } from "./search-registered-fixture";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
  STORE_SEARCH_FOLLOWUP_HOLD_MS,
} from "@ohmail/client-engine";
import { ARCHIVE_TIMEOUT_MS } from "@ohmail/app-logic/search";

/**
 * THE WHOLE-MAILBOX PASS ENDS IN EXACTLY ONE OF THREE VERDICTS, on every outcome: matched,
 * nothing matched, or the server did not answer. It once read "Searching the whole archive…" with
 * no completion. Each case drives one way the pass can end and reads the sentence; `verdicts()`
 * counts the three plus the in-progress sentence, so two on screen at once is a failure too.
 */

(globalThis as unknown as { React: unknown }).React = React;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-23T12:00:00.000Z");
let seq = 0;

function msg(id: string, subject: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject, from: { name: null, address: "portal@insure.example" },
    to: [], cc: [], date: "2026-09-01T09:00:00.000Z", folder: "INBOX",
    snippet: "", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  };
}

function adapter(over: Partial<EngineAdapter>): EngineAdapter {
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

const create = (m: EngineMessage): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m });

async function engineWith(rows: EngineMessage[], over: Record<string, unknown>): Promise<{ engine: OhmailEngine; store: MemoryMirrorStore }> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(rows.map(create));
  return { engine: new OhmailEngine({ adapter: adapter(over as Partial<EngineAdapter>), store, now: () => NOW }), store };
}

let host: HTMLDivElement;
let root: Root;
let leaveSearch: () => void;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  window.localStorage.clear();
  leaveSearch = enterSearchRoute();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  leaveSearch();
  warn.mockRestore();
  vi.useRealTimers();
});

async function render(engine: OhmailEngine, query: string): Promise<void> {
  await act(async () => { root.render(<RegisteredSearch engine={engine} now={NOW} />); });
  await vi.waitFor(() => searchField(host), { timeout: 5000 });
  await act(async () => { typeSearch(host, query); });
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** Past a typed question's hold: its page, then its count. */
const SETTLED = STORE_SEARCH_FOLLOWUP_HOLD_MS + 50;
const text = (): string => host.textContent ?? "";

const SENTENCES = {
  searching: "Searching your whole mailbox…",
  matched: /Searched your whole mailbox — [\d,]+ matched|(At least|About) [\d,]+ matched in your whole mailbox\./,
  nothing: "Searched your whole mailbox — nothing matched",
  unanswered: "Your server did not answer — showing the recent mail this device holds.",
  failed: "Your server could not run this search — showing the recent mail this device holds.",
} as const;
/** Which of the four sentences are on screen — exactly one is the invariant. */
function verdicts(): string[] {
  const t = text();
  return Object.entries(SENTENCES)
    .filter(([, s]) => (typeof s === "string" ? t.includes(s) : s.test(t)))
    .map(([k]) => k);
}
const logged = (): string[] => warn.mock.calls.map((c: unknown[]) => c.join(" ")).filter((l: string) => l.startsWith("[search]"));

const CORPUS = [msg("local", "myAXA Portal")];

describe("the whole-mailbox verdict always renders", () => {
  it("a REJECTED pass says the server did not answer at once — not at the ceiling", async () => {
    const { engine } = await engineWith(CORPUS, { searchServer: async () => ({ items: [], total: 0 }) });
    (engine as unknown as { searchServer: () => Promise<never> }).searchServer = () =>
      Promise.reject(new TypeError("the words somebody typed"));
    await render(engine, "axa");
    await advance(300);
    expect(verdicts()).toEqual(["unanswered"]);
    expect(logged()).toEqual(["[search] the whole-mailbox pass did not answer: TypeError"]);
  });

  it("a REFUSED pass (the transport throws) is the same verdict, logged by class and status", async () => {
    const refusal = Object.assign(new Error("a sentence about the account"), { name: "MutationRejectedError", status: 504, code: "server_error" });
    const { engine } = await engineWith(CORPUS, { searchServer: async () => { throw refusal; } });
    await render(engine, "axa");
    await advance(300);
    expect(verdicts()).toEqual(["unanswered"]);
    expect(text()).not.toContain("a sentence about the account");
    expect(logged()).toEqual(["[search] the whole-mailbox pass did not answer: MutationRejectedError 504 server_error"]);
  });

  it("a pass the server ANSWERED with a fault (500) says it could not run the search, and keeps the retry", async () => {
    const refusal = Object.assign(new Error("a sentence about the account"), { name: "MutationRejectedError", status: 500, code: "internal" });
    const { engine } = await engineWith(CORPUS, { searchServer: async () => { throw refusal; } });
    await render(engine, "axa");
    await advance(300);
    expect(verdicts()).toEqual(["failed"]);
    expect(text()).not.toContain("a sentence about the account");
    expect(within(host).queryByRole("button", { name: "Search again" })).not.toBeNull();
  });

  it("a transport that throws SYNCHRONOUSLY is a failed outcome, never a rejection of the engine", async () => {
    const { engine } = await engineWith(CORPUS, { searchServer: () => { throw new RangeError("sync"); } });
    await expect(engine.searchServer("axa")).resolves.toMatchObject({ state: "failed", errorClass: "RangeError" });
    await render(engine, "axa");
    await advance(300);
    expect(verdicts()).toEqual(["unanswered"]);
  });

  it("an EMPTY answer says nothing matched, and the empty state says the whole mailbox", async () => {
    const { engine } = await engineWith(CORPUS, { searchServer: async () => ({ items: [], total: 0 }) });
    await render(engine, "zzqx");
    expect(verdicts()).toEqual(["searching"]);
    await advance(300);
    expect(verdicts()).toEqual(["nothing"]);
    // Said once: the verdict, no title beside it.
    expect(text()).not.toContain("Nothing matched.");
  });

  it("a LATE answer, after the device arm re-rendered, still lands its count", async () => {
    let settle: ((v: { items: EngineMessage[]; total: number; tier: "exact" }) => void) | null = null;
    const { engine, store } = await engineWith(CORPUS, {
      searchServer: () => new Promise((res) => { settle = res as typeof settle; }),
    });
    await render(engine, "axa");
    await advance(300);
    expect(verdicts()).toEqual(["searching"]);
    // The device arm re-renders over a changed mirror while the pass is out.
    await act(async () => {
      await store.applyChanges([create(msg("new", "AXA claim update"))]);
      await engine.warmSearchIndex();
    });
    expect(text()).toContain("AXA claim update");
    await advance(2_000);
    expect(verdicts()).toEqual(["searching"]);
    await act(async () => { settle!({ items: [msg("wire", "Quarterly letter")], total: 3, tier: "exact" }); });
    expect(verdicts()).toEqual(["matched"]);
    expect(text()).toContain("Searched your whole mailbox — 3 matched");
  });

  it("a CUT page says at least N, the estimate about N, and the exact count replaces it in place", async () => {
    const asked: string[] = [];
    type Wire = { items: EngineMessage[]; total: number; totalExact: boolean; totalEstimate?: number; ms: number };
    let estimate: ((v: Wire) => void) | null = null;
    let count: ((v: Wire) => void) | null = null;
    const { engine } = await engineWith(CORPUS, {
      searchServer: (_q: string, opts: { parts?: string }) => {
        asked.push(opts.parts ?? "both");
        if (opts.parts === "estimate") return new Promise((res) => { estimate = res as typeof estimate; });
        if (opts.parts === "summary") return new Promise((res) => { count = res as typeof count; });
        return Promise.resolve({ items: [msg("wire", "Quarterly letter")], total: 212, totalExact: false, ms: 12 });
      },
    });
    await render(engine, "axa");
    await advance(SETTLED);
    expect(asked).toEqual(["page", "estimate"]);
    expect(text()).toContain(messages.search.saidAtLeast.replace("{total}", "212"));
    await act(async () => { estimate!({ items: [], total: 212, totalExact: false, totalEstimate: 7_874, ms: 9 }); });
    expect(asked).toEqual(["page", "estimate", "summary"]);
    expect(text()).toContain(messages.search.saidAbout.replace("{total}", "7,874"));
    expect(verdicts()).toEqual(["matched"]);
    await act(async () => { count!({ items: [], total: 7_901, totalExact: true, ms: 40 }); });
    expect(text()).toContain("Searched your whole mailbox — 7,901 matched · ");
    expect(text()).not.toContain("about 7,874");
    expect(verdicts()).toEqual(["matched"]);
  });

  it("the estimate is its own outcome: no rows and no cursor, so it cannot be read as a page", async () => {
    const { engine } = await engineWith(CORPUS, { searchServer: async () => ({ items: [], total: 3, totalExact: false, totalEstimate: 9 }) });
    const est = await engine.searchServer("axa", { parts: "estimate" });
    if (est.state !== "ready") throw new Error(est.state);
    // @ts-expect-error — an estimate carries no rows; this line compiles only if it grew them.
    expect(est.items).toBeUndefined();
    expect(est).toMatchObject({ total: 3, totalExact: false, totalEstimate: 9 });
  });

  it("an UNCUT search takes its exact count from the estimate and asks no summary", async () => {
    const asked: string[] = [];
    const { engine } = await engineWith(CORPUS, {
      searchServer: async (_q: string, opts: { parts?: string }) => {
        asked.push(opts.parts ?? "both");
        if (opts.parts === "estimate") return { items: [], total: 38, totalExact: true, ms: 4 };
        return { items: [msg("wire", "Quarterly letter")], total: 38, totalExact: true, ms: 12 };
      },
    });
    await render(engine, "axa");
    await advance(SETTLED);
    await advance(SETTLED);
    expect(asked).toEqual(["page", "estimate"]);
    expect(text()).toContain("Searched your whole mailbox — 38 matched · ");
  });

  it("an exact estimate asks no summary, and a count that fails leaves the lower bound", async () => {
    const asked: string[] = [];
    const { engine } = await engineWith(CORPUS, {
      searchServer: async (q: string, opts: { parts?: string }) => {
        asked.push(`${q}:${opts.parts ?? "both"}`);
        if (q === "exact") return { items: [], total: 4, totalExact: true, ms: 3 };
        if (opts.parts === "summary") throw new Error("count refused");
        return { items: [], total: 250, totalExact: false, ms: 9 };
      },
    });
    await render(engine, "exact");
    await advance(SETTLED);
    // The estimate is always the second response — it carries the facets; exact, it is the last.
    expect(asked).toEqual(["exact:page", "exact:estimate"]);
    expect(text()).toContain("Searched your whole mailbox — 4 matched · ");
    await render(engine, "cut");
    await advance(SETTLED);
    // An estimate with no `totalEstimate` says nothing about how many: the lower bound stands.
    expect(asked).toEqual(["exact:page", "exact:estimate", "cut:page", "cut:estimate", "cut:summary"]);
    expect(text()).toContain(messages.search.saidAtLeast.replace("{total}", "250"));
  });

  it("a pass that NEVER settles ends at the ceiling in the not-answered verdict", async () => {
    const { engine } = await engineWith(CORPUS, { searchServer: () => new Promise<never>(() => {}) });
    await render(engine, "axa");
    await advance(ARCHIVE_TIMEOUT_MS - 1);
    expect(verdicts()).toEqual(["searching"]);
    await advance(2);
    expect(verdicts()).toEqual(["unanswered"]);
    expect(logged()).toEqual(["[search] the whole-mailbox pass did not answer: timeout"]);
    expect(within(host).queryByRole("button", { name: "Search again" })).not.toBeNull();
  });

  it("a one-character query asks nothing and never claims to be searching", async () => {
    const asked: string[] = [];
    const { engine } = await engineWith(CORPUS, { searchServer: async (q: string) => { asked.push(q); return { items: [], total: 0 }; } });
    await render(engine, "m");
    await advance(ARCHIVE_TIMEOUT_MS * 2);
    expect(asked).toEqual([]);
    expect(verdicts()).toEqual([]);
    // The positive control: two characters are a question, and it is answered.
    await render(engine, "my");
    await advance(SETTLED);
    expect(asked).toEqual(["my", "my"]); // the page, then its estimate — exact, so no summary
    expect(verdicts()).toEqual(["nothing"]);
  });
  it("an empty page WITH a cursor is followed: the rows behind it are the verdict, never nothing matched", async () => {
    const asked: string[] = [];
    const { engine } = await engineWith(CORPUS, {
      searchServer: async (_q: string, o: { parts?: string; cursor?: string }) => {
        if (o.parts === "estimate" || o.parts === "summary") return { items: [], total: 1, totalExact: true, ms: 1 };
        asked.push(o.cursor ?? "-");
        return o.cursor === "c2" ? { items: [msg("wire", "Quarterly letter")], total: 1, totalExact: false, nextCursor: null, ms: 1 }
          : { items: [], total: 0, totalExact: false, nextCursor: o.cursor === "c1" ? "c2" : "c1", ms: 1 };
      },
    });
    await render(engine, "unread");
    await advance(SETTLED);
    expect(asked).toEqual(["-", "c1", "c2"]);
    expect(verdicts()).toEqual(["matched"]);
    expect(text()).toContain("Quarterly letter");
    expect(text()).not.toContain("Nothing matched.");
  });

  it("five empty pages with cursors: no verdict says nothing matched or that the server did not answer", async () => {
    const asked: string[] = [];
    const { engine } = await engineWith([], {
      searchServer: async (_q: string, o: { parts?: string; cursor?: string }) => {
        asked.push(o.cursor ?? "-");
        return { items: [], total: 0, totalExact: false, nextCursor: `${o.cursor ?? "c"}+`, ms: 1 };
      },
    });
    await render(engine, "unread");
    await advance(SETTLED);
    expect(asked).toHaveLength(5);
    expect(verdicts()).toEqual([]);
    expect(text()).not.toContain("Nothing matched.");
    expect(within(host).queryByRole("button", { name: "Search again" })).toBeNull();
    await advance(ARCHIVE_TIMEOUT_MS);
    expect(verdicts(), "not a timeout either").toEqual([]);
  });

  it("past the bound with rows on screen, the end of the list scrolled to looks further", async () => {
    const asked: string[] = [];
    const { engine } = await engineWith(CORPUS, {
      searchServer: async (_q: string, o: { parts?: string; cursor?: string }) => {
        if (o.parts === "estimate" || o.parts === "summary") return { items: [], total: 2, totalExact: true, ms: 1 };
        const n = o.cursor ? Number(o.cursor) : 0;
        asked.push(String(n));
        if (n === 0) return { items: [msg("first", "Quarterly letter")], total: 2, totalExact: false, nextCursor: "1", ms: 1 };
        if (n === 6) return { items: [msg("deep", "Old pension statement")], total: 2, totalExact: false, nextCursor: null, ms: 1 };
        return { items: [], total: 0, totalExact: false, nextCursor: String(n + 1), ms: 1 };
      },
    });
    await render(engine, "letter");
    await advance(SETTLED);
    expect(text()).toContain("Quarterly letter");
    const scroller = host.querySelector(".sr-scroll") as HTMLElement;
    const scroll = () => act(async () => { scroller.dispatchEvent(new Event("scroll")); await vi.advanceTimersByTimeAsync(10); });
    await scroll();
    expect(asked).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(text()).not.toContain("Old pension statement");
    await scroll();
    expect(asked).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
    expect(text()).toContain("Old pension statement");
  });

  it("a followed page one, the list walked past the page cache: the top of the list is read again, with no loop of page asks", async () => {
    let pageAsks = 0;
    const { engine } = await engineWith([], {
      searchServer: async (_q: string, o: { parts?: string; cursor?: string }) => {
        if (o.parts === "estimate" || o.parts === "summary") return { items: [], total: 400, totalExact: true, ms: 1 };
        if (!o.cursor) return { items: [], total: 0, totalExact: false, nextCursor: "p0", ms: 1 };
        const k = Number(o.cursor.slice(1));
        return {
          items: Array.from({ length: 50 }, (_, i) => msg(`r${k * 50 + i}`, `Letter ${k * 50 + i} of the run`)),
          total: 400, totalExact: false, nextCursor: k < 7 ? `p${k + 1}` : null, ms: 1,
        };
      },
    });
    const inner = engine.pageSearch.bind(engine);
    (engine as unknown as { pageSearch: typeof engine.pageSearch }).pageSearch = (key, o) => {
      pageAsks += 1;
      // The test's own stop: a loop of asks would otherwise never let it return.
      return pageAsks > 400 ? new Promise(() => undefined) : inner(key, o);
    };
    await render(engine, "letter");
    await advance(SETTLED);
    expect(text()).toContain("Letter 0 of the run");
    const scroller = host.querySelector(".sr-scroll") as HTMLElement;
    for (let i = 0; i < 5; i++) {
      await act(async () => { scroller.dispatchEvent(new Event("scroll")); await vi.advanceTimersByTimeAsync(50); });
    }
    await advance(500);
    expect(pageAsks, "the walk past the cache and the way back, not a loop").toBeLessThan(40);
    expect(text()).toContain("Letter 0 of the run");
  });
});

describe("a followed position below page one, after the top is read again", () => {
  it("rows, two empty pages with cursors, rows: past the page cache, to the top, down a screen — the rows below the gap are drawn, with no loop of page asks", async () => {
    let pageAsks = 0;
    const wire: string[] = [];
    const { engine } = await engineWith([], {
      searchServer: async (_q: string, o: { parts?: string; cursor?: string }) => {
        if (o.parts === "estimate" || o.parts === "summary") return { items: [], total: 400, totalExact: true, ms: 1 };
        const c = o.cursor ?? "p0";
        wire.push(c);
        if (c === "e1" || c === "e2") return { items: [], total: 0, totalExact: false, nextCursor: c === "e1" ? "e2" : "p1", ms: 1 };
        const k = Number(c.slice(1));
        return {
          items: Array.from({ length: 50 }, (_, i) => msg(`r${k * 50 + i}`, `Letter ${k * 50 + i} of the run`)),
          total: 400, totalExact: false, nextCursor: k === 0 ? "e1" : k < 7 ? `p${k + 1}` : null, ms: 1,
        };
      },
    });
    const inner = engine.pageSearch.bind(engine);
    (engine as unknown as { pageSearch: typeof engine.pageSearch }).pageSearch = (key, o) => {
      pageAsks += 1;
      // The test's own stop: a loop of asks would otherwise never let it return.
      return pageAsks > 400 ? new Promise(() => undefined) : inner(key, o);
    };
    await render(engine, "letter");
    await advance(SETTLED);
    expect(text()).toContain("Letter 0 of the run");
    const scroller = host.querySelector(".sr-scroll") as HTMLElement;
    const scrollTo = async (slot: number): Promise<void> => {
      scroller.scrollTop = slot * 80;
      await act(async () => { scroller.dispatchEvent(new Event("scroll")); await vi.advanceTimersByTimeAsync(50); });
      await advance(200);
    };
    // The reader scrolls to the end of the list: the walk passes the page cache.
    for (let i = 1; i <= 8; i++) await scrollTo(i * 50 - 16);
    expect(text()).toContain("Letter 399 of the run");
    expect(text(), "the top is long off screen").not.toContain("Letter 0 of the run");
    // Home, then down a screen: slots 50 and on come into the window again.
    await scrollTo(0);
    expect(text(), "the top is read again").toContain("Letter 0 of the run");
    const before = pageAsks;
    const sent = wire.length;
    await scrollTo(52);
    await advance(500);
    expect(pageAsks - before, "the page asks for that screen: no loop").toBeLessThan(10);
    expect(wire.slice(sent), "the rows below the gap by their followed cursor, no empty page").toEqual(["p1"]);
    expect(text()).toMatch(/Letter 6\d of the run/);
  });

  // The page above the gap as the store answers it when the top is read again. A page holds fifty rows at most.
  // Pushed: the same number of rows and another next (a new letter at the top; Letter 49 is the page after's first row now).
  for (const change of ["fewer", "more", "empty", "pushed"] as const) {
    it(`the page above the gap read again with ${change === "pushed" ? "the same number of rows and another next" : "another number of rows"} (${change}): the top, then down a screen — every row drawn once, no loop of page asks`, async () => {
      let pageAsks = 0;
      let again = false;
      const row = (n: number) => msg(`r${n}`, `Letter ${n} of the run`);
      const { engine } = await engineWith([], {
        searchServer: async (_q: string, o: { parts?: string; cursor?: string }) => {
          if (o.parts === "estimate" || o.parts === "summary") return { items: [], total: 400, totalExact: true, ms: 1 };
          const c = o.cursor ?? "p0";
          // Empty now, with a cursor: page one's letters are behind one more empty page.
          if (c === "p0" && again && change === "empty") return { items: [], total: 0, totalExact: false, nextCursor: "y0", ms: 1 };
          if (c === "y0") return { items: Array.from({ length: 50 }, (_, i) => row(i)), total: 400, totalExact: false, nextCursor: "e1", ms: 1 };
          if (c === "e1" || c === "e2") return { items: [], total: 0, totalExact: false, nextCursor: c === "e1" ? "e2" : "p1", ms: 1 };
          if (c === "p0" && again && change === "pushed") return { items: [row(900), ...Array.from({ length: 49 }, (_, i) => row(i))], total: 400, totalExact: false, nextCursor: "x1", ms: 1 };
          if (c === "x1") return { items: [row(49)], total: 400, totalExact: false, nextCursor: "e2", ms: 1 };
          const k = Number(c.slice(1));
          let items = Array.from({ length: 50 }, (_, i) => row(k * 50 + i));
          // Fewer: Letter 49 stopped matching. More: 49 rows the first time, a new letter above them the second.
          if (k === 0 && (change === "more" || (again && change === "fewer"))) items = items.slice(0, 49);
          if (k === 0 && again && change === "more") items = [row(900), ...items];
          return { items, total: 400, totalExact: false, nextCursor: k === 0 ? "e1" : k < 7 ? `p${k + 1}` : null, ms: 1 };
        },
      });
      const inner = engine.pageSearch.bind(engine);
      (engine as unknown as { pageSearch: typeof engine.pageSearch }).pageSearch = (key, o) => {
        pageAsks += 1;
        // The test's own stop: a loop of asks would otherwise never let it return.
        return pageAsks > 400 ? new Promise(() => undefined) : inner(key, o);
      };
      await render(engine, "letter");
      await advance(SETTLED);
      expect(text()).toContain("Letter 0 of the run");
      const scroller = host.querySelector(".sr-scroll") as HTMLElement;
      const scrollTo = async (slot: number): Promise<void> => {
        scroller.scrollTop = slot * 80;
        await act(async () => { scroller.dispatchEvent(new Event("scroll")); await vi.advanceTimersByTimeAsync(50); });
        await advance(200);
      };
      for (let i = 1; i <= 8; i++) await scrollTo(i * 50 - 16);
      expect(text()).toContain("Letter 399 of the run");
      again = true;
      await scrollTo(0);
      expect(text(), "the top of the list is drawn").toContain(change === "more" || change === "pushed" ? "Letter 900 of the run" : "Letter 0 of the run");
      const before = pageAsks;
      // …and down a screen, as a reader's scroll does it: a few scroll events.
      for (let i = 0; i < 3; i++) await scrollTo(52);
      await advance(500);
      expect(pageAsks - before, "the page asks for that screen: no loop").toBeLessThan(40);
      const shown = [48, 49, 50, 51, 60, 70].filter((k) => text().includes(`Letter ${k} of the run`));
      expect(shown, "every row the store answered is drawn").toEqual(change === "empty" || change === "pushed" ? [48, 49, 50, 51, 60, 70] : [48, 50, 51, 60, 70]);
      const twice = [48, 49, 50, 51, 60].filter((k) => text().split(`Letter ${k} of the run`).length > 2);
      expect(twice, "no row drawn twice").toEqual([]);
    });
  }
});
