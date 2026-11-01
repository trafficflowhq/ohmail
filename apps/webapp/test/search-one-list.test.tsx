/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type EngineMessage,
  type MutationOutcome,
  type ServerSearchOpts,
  type SyncChange,
  type SyncResponse,
  STORE_SEARCH_FOLLOWUP_HOLD_MS,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { SearchView } from "../app/views/SearchView";
import { KeymapProvider } from "../app/shell/keymap";
import { searchSortKey } from "../app/shell/persisted-ui";
import { ESTIMATED_ROW_PX } from "../app/shell/list-window";

/**
 * SEARCH IS ONE LIST OVER THE STORE (ARCHIVE-024): the store's first page replaces the device's
 * paint, scrolling asks the store's `nextCursor`, the facets and the count are the store's over
 * the whole match set, and the verdict line carries the store's progress and its own ms.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-23T12:00:00.000Z");
let seq = 0;

function msg(id: string, subject: string, from = "portal@insure.example", date = "2026-09-01T09:00:00.000Z"): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject, from: { name: null, address: from }, to: [], cc: [], date, folder: "INBOX",
    snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  };
}

type Answer = Record<string, unknown>;
async function engineWith(rows: EngineMessage[], searchServer: (q: string, o: ServerSearchOpts) => Promise<Answer>): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(rows.map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })));
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: NOW.toISOString() }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    searchServer,
  } as unknown as EngineAdapter;
  return new OhmailEngine({ adapter, store, now: () => NOW });
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

async function render(engine: OhmailEngine, query: string): Promise<void> {
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(KeymapProvider, { children: h(SearchView, { engine, version: 1, now: NOW, query, onQuery: () => {}, onOpen: () => {} }) }),
    }));
  });
}
// A typed question settles when its count is asked: the page at the debounce, the count at the hold.
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, STORE_SEARCH_FOLLOWUP_HOLD_MS + 70)); });
const text = (): string => host.textContent ?? "";
const hits = (): string[] => [...host.querySelectorAll(".hit .subj")].map((n) => n.textContent ?? "");
const scrollEnd = () => act(async () => {
  host.querySelector(".view-search .scroller")!.dispatchEvent(new Event("scroll"));
  await new Promise((r) => setTimeout(r, 20));
});

const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => msg(`s${from + i}`, `AXA letter ${from + i}`));
const subjects = (from: number, n: number) => page(from, n).map((m) => m.subject);
/** Every subject the window shows on its way from the top to `rows` rows down, and any repeat on one screen. */
const walkHits = async (rows: number): Promise<{ seen: Set<string>; repeated: boolean }> => {
  const scroller = host.querySelector(".view-search .scroller") as HTMLElement;
  const seen = new Set<string>();
  let repeated = false;
  for (let top = 0; top <= rows * ESTIMATED_ROW_PX; top += 10 * ESTIMATED_ROW_PX) {
    scroller.scrollTop = top;
    await scrollEnd();
    const shown = hits();
    if (new Set(shown).size !== shown.length) repeated = true;
    for (const s of shown) seen.add(s);
  }
  return { seen, repeated };
};

describe("Search pages the store", () => {
  it("scrolling near the end asks the store's next page, appended by id", async () => {
    const asked: ServerSearchOpts[] = [];
    const engine = await engineWith([], async (_q, o) => {
      asked.push(o);
      if (o.parts === "summary") return { items: [], total: 75, totalExact: true };
      if (!o.cursor) return { items: page(0, 50), total: 50, totalExact: false, nextCursor: "c2", ms: 7 };
      return { items: [...page(49, 1), ...page(50, 25)], total: 75, nextCursor: null, ms: 5 };
    });
    await render(engine, "axa");
    await settle();
    expect(hits().length).toBe(50);
    await scrollEnd();
    await settle();
    expect(asked.filter((o) => o.parts === "page").map((o) => o.cursor ?? null)).toEqual([null, "c2"]);
    // Seventy-five rows, the overlap at the seam rendered once: walked top to bottom, the window
    // shows every one of them and never one twice on a screen.
    const walked = await walkHits(75);
    expect(walked.repeated).toBe(false);
    expect([...walked.seen].sort()).toEqual(subjects(0, 75).sort());
    // The last page came back: the next scroll asks nothing.
    await scrollEnd();
    await settle();
    expect(asked.filter((o) => o.parts === "page").length).toBe(2);
  });

  it("the facets are the store's, over the whole match set, and a press re-asks the store", async () => {
    const asked: ServerSearchOpts[] = [];
    const engine = await engineWith([msg("d1", "AXA on the device", "local@device.example")], async (_q, o) => {
      asked.push(o);
      // An uncut set: the estimate's facets are the whole match set's, and no summary is asked.
      if (o.parts === "estimate") {
        return { items: [], total: 40, totalExact: true, facets: {
          folder: { INBOX: 30, "ohmail/News": 10 },
          sender: [{ address: "news@axa.example", count: 28 }, { address: "portal@insure.example", count: 12 }],
          hasAttachments: { true: 3, false: 37 }, unread: { true: 1, false: 39 },
        } };
      }
      return { items: o.filters?.sender ? page(0, 2) : page(0, 5), total: 5, nextCursor: null, ms: 4 };
    });
    await render(engine, "axa");
    // Before the store answers, the device's own facets — its one sender.
    expect(text()).toContain("local@device.example");
    await settle();
    // The store's counts, not the page's five rows.
    expect(text()).toContain("news@axa.example");
    expect(text()).toContain("×28");
    expect(text()).not.toContain("local@device.example");
    const facet = [...host.querySelectorAll(".facets button")].find((b) => (b.textContent ?? "").includes("news@axa.example")) as HTMLElement;
    await act(async () => { facet.click(); });
    await settle();
    expect(asked.filter((o) => o.parts === "page").map((o) => o.filters?.sender ?? null)).toEqual([null, "news@axa.example"]);
    expect(hits().length).toBe(2);
  });

  it("a cut search draws its chips from the estimate with no numbers, and the exact set numbers them in place", async () => {
    const asked: string[] = [];
    const facetsOf = (sender: Array<[string, number]>, folder: Record<string, number>) => ({
      folder, sender: sender.map(([address, count]) => ({ address, count })),
      hasAttachments: { true: 0, false: 1 }, unread: { true: 0, false: 1 },
    });
    let estimate: ((v: Answer) => void) | null = null;
    let summary: ((v: Answer) => void) | null = null;
    const engine = await engineWith([], (_q, o) => {
      asked.push(o.parts ?? "both");
      if (o.parts === "estimate") return new Promise((res) => { estimate = res; });
      if (o.parts === "summary") return new Promise((res) => { summary = res; });
      return Promise.resolve({ items: page(0, 50), total: 200, totalExact: false, nextCursor: "c2", ms: 7 });
    });
    await render(engine, "axa");
    await settle();
    expect(asked).toEqual(["page", "estimate"]);
    expect(hits().length, "the page is on screen before any count").toBe(50);
    await act(async () => {
      estimate!({ items: [], total: 200, totalExact: false, totalEstimate: 690, facets: facetsOf(
        [["news@axa.example", 28], ["portal@insure.example", 12], ["claims@axa.example", 5]], { INBOX: 30, "ohmail/News": 10 },
      ) });
    });
    const chips = () => [...host.querySelectorAll(".facets li")] as HTMLElement[];
    const drawn = chips();
    const read = () => chips().map((li) => li.textContent);
    expect(asked).toEqual(["page", "estimate", "summary"]);
    expect(text()).toContain("Searched your whole mailbox — about 690 matched");
    const before = read();
    // The candidates' counts are no count of the match set: the chips stand without them.
    expect(before.slice(0, 3)).toEqual(["news@axa.example", "portal@insure.example", "claims@axa.example"]);
    expect(before.join(" ")).not.toContain("×");
    await act(async () => {
      summary!({ items: [], total: 712, totalExact: true, facets: facetsOf(
        [["portal@insure.example", 400], ["news@axa.example", 300], ["claims@axa.example", 12]], { "ohmail/News": 350, INBOX: 362 },
      ) });
    });
    expect(text()).toContain("Searched your whole mailbox — 712 matched");
    expect(read().slice(0, 3), "same order, the exact counts").toEqual(
      ["news@axa.example×300", "portal@insure.example×400", "claims@axa.example×12"],
    );
    expect(read().length).toBe(before.length);
    expect(chips().every((li, i) => li === drawn[i]), "the same chips, replaced in place").toBe(true);
    expect(asked, "three requests, no more").toEqual(["page", "estimate", "summary"]);
  });

  it("past the store's cap the summary raises the lower bound, and its chips carry no numbers", async () => {
    const facets = {
      folder: { INBOX: 40 }, sender: [{ address: "news@axa.example", count: 31 }],
      hasAttachments: { true: 0, false: 40 }, unread: { true: 0, false: 40 },
    };
    const engine = await engineWith([], async (_q, o) => (o.parts === "estimate" ? { items: [], total: 200, totalExact: false, facets }
      : o.parts === "summary" ? { items: [], total: 2_000, totalExact: false, facets }
      : { items: page(0, 50), total: 200, totalExact: false, nextCursor: "c2", ms: 7 }));
    await render(engine, "axa");
    await settle();
    expect(text()).toMatch(/Searched your whole mailbox — at least 2[,’ ]?000 matched/);
    const chips = [...host.querySelectorAll(".facets li")].map((li) => li.textContent);
    expect(chips).toContain("news@axa.example");
    expect(chips.join(" ")).not.toContain("×");
  });

  it("while the store is still indexing it says how far; a cut relevance set says where the rest is", async () => {
    const engine = await engineWith([], async (_q, o) => (o.parts === "estimate"
      ? { items: [], total: 9, totalExact: true, indexed: { done: 30, total: 120 } }
      : { items: page(0, 9), total: 9, nextCursor: null, bounded: true, ms: 11 }));
    await render(engine, "axa");
    await settle();
    expect(text()).toContain("Older mail is still being indexed — 25 % done.");
    expect(text()).toContain("Showing the 9 best matches — sort by date to walk them all.");
  });

  it("a cut exact page with no row whose count lands as 0 says nothing matched, and no best matches", async () => {
    // The store's shape for `kai survey -samples` when every newest letter with both words holds
    // `samples`: the page is the exact tier, cut and empty; the estimate counts the set whole.
    const asked: string[] = [];
    const engine = await engineWith([], async (_q, o) => {
      asked.push(o.parts ?? "both");
      return o.parts === "estimate" ? { items: [], total: 0, totalExact: true }
        : { items: [], total: 0, totalExact: false, nextCursor: null, bounded: true, ms: 11 };
    });
    await render(engine, "kai survey -samples");
    await settle();
    expect(text()).toContain("Searched your whole mailbox — nothing matched");
    expect(host.querySelector('[data-testid="search-bounded"]'), "no best matches to show").toBeNull();
    expect(asked).toEqual(["page", "estimate"]);
  });

  it("…and says neither once the store is indexed and the set is whole", async () => {
    const engine = await engineWith([], async (_q, o) => (o.parts === "summary"
      ? { items: [], total: 9, totalExact: true }
      : { items: page(0, 9), total: 9, nextCursor: null, ms: 11 }));
    await render(engine, "axa");
    await settle();
    expect(host.querySelector('[data-testid="search-indexing"]')).toBeNull();
    expect(host.querySelector('[data-testid="search-bounded"]')).toBeNull();
  });

  it("the verdict carries the measured wait once it answered, and says the numbers once", async () => {
    /* DESIGN-FOLD-WIDTHS "1 result · 62 ms" above "Searched your whole mailbox — 1 matched · 62 ms"
       was the same numbers twice. The verdict stays (the scope and the time are the claim); the bare
       line goes while the verdict carries a count. Mutation: render the bare line unconditionally —
       `.results-head.num` reads "1 result · 62 ms" again. */
    const engine = await engineWith([msg("d1", "AXA on the device")], async (_q, o) => (o.parts === "summary"
      ? { items: [], total: 1, totalExact: true }
      : { items: [msg("d1", "AXA on the device")], total: 1, nextCursor: null, ms: 62 }));
    await render(engine, "axa");
    await settle();
    expect(host.querySelector(".results-head.num"), "the count is said twice").toBeNull();
    expect(text()).toMatch(/Searched your whole mailbox — 1 matched · \d+ ms/);
    // The store's own 62 ms is never the time said: the line states the wait.
    expect(text()).not.toMatch(/\b62 ms/);
    expect(text().match(/ · \d+ ms/g)).toHaveLength(1);
    /* The count with its word and the time with its unit are one unbreakable span (`.nobr`). */
    expect(host.querySelector(".view-search .nobr")?.textContent).toMatch(/^1 matched · \d+ ms$/);
  });

  it("the bare count line stands where the verdict has no count — the archive did not answer", async () => {
    const engine = await engineWith([msg("d1", "AXA on the device")], async () => { throw new Error("unreachable"); });
    await render(engine, "axa");
    await settle();
    const line = host.querySelector(".results-head.num")?.textContent ?? "";
    expect(line, "with no count in the verdict the result count must stay").toMatch(/^1 result · \d+ ms$/);
    /* The count with its word and the time with its unit hold together on this line too. */
    expect(host.querySelector(".results-head.num .nobr")?.textContent).toMatch(/^1 result · \d+ ms$/);
  });

  it("a store that answered with no time still leaves a time on screen — the device's own", async () => {
    /* REVIEW LOW 2: `ms: null` hid the bare line (the verdict carries the count) and took its
       fallback time with it, so no time was said at all. Mutation: drop `?? tookMs` from the
       verdict's time — "1 matched" stands alone. */
    const engine = await engineWith([msg("d1", "AXA on the device")], async (_q, o) => (o.parts === "summary"
      ? { items: [], total: 1, totalExact: true }
      : { items: [msg("d1", "AXA on the device")], total: 1, nextCursor: null, ms: null }));
    await render(engine, "axa");
    await settle();
    expect(host.querySelector(".results-head.num"), "the count is said twice").toBeNull();
    expect(host.querySelector(".view-search .nobr")?.textContent).toMatch(/^1 matched · \d+ ms$/);
  });

  it("the store's order is the order: a date sort's page is rendered as the store sent it", async () => {
    const older = msg("old", "AXA old", "a@x.example", "2019-01-01T00:00:00.000Z");
    const newer = msg("new", "AXA new", "b@x.example", "2026-01-01T00:00:00.000Z");
    const engine = await engineWith([newer, older], async (_q, o) => (o.parts === "summary"
      ? { items: [], total: 2, totalExact: true }
      : { items: o.sort === "date_asc" ? [older, newer] : [newer, older], total: 2, nextCursor: null, ms: 3 }));
    window.localStorage.setItem(searchSortKey(null), "date_asc");
    await render(engine, "axa");
    await settle();
    expect(hits()).toEqual(["AXA old", "AXA new"]);
  });
});
