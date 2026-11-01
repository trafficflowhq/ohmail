/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  OhmailEngine,
  SERVER_SEARCH_SORTS,
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

/**
 * THE ORDER CONTROL, AND THE HALF OF IT THAT IS NOT THE PARAMETER.
 *
 * Passing `sort` to `GET /search` is the easy half and the service tests already own it. What
 * this file watches is the thing a server-side test cannot see: this view renders TWO arms
 * merged — the device's own index first, the archive's extras appended — so a build that
 * forwarded the parameter faithfully and left the merge alone would put twelve
 * relevance-ranked local hits above the date-ordered ones. The reader picks "Newest first",
 * the top of the list does not move, and every server assertion is still green.
 *
 * So: the control exists, choosing an order re-asks the archive FOR that order, and the rows
 * on screen come back in it.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-04T12:00:00.000Z");
let seq = 0;

function msg(id: string, subject: string, date: string, from: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject, from: { name: null, address: from },
    to: [], cc: [], date, folder: "ohmail/News",
    snippet: "", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  };
}

/**
 * Three matches, three dates, three senders — and the three orderings are pairwise different,
 * so no assertion below can pass by coincidence.
 *
 *   id  date        sender
 *   old 2026-06-01  zoe@
 *   mid 2026-07-01  anna@
 *   new 2026-08-01  mike@
 */
const ROWS: EngineMessage[] = [
  msg("old", "Heron one", "2026-06-01T09:00:00.000Z", "zoe@late.test"),
  msg("mid", "Heron two", "2026-07-01T09:00:00.000Z", "anna@early.test"),
  msg("new", "Heron three", "2026-08-01T09:00:00.000Z", "mike@mid.test"),
];

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

async function engineWith(over: Partial<EngineAdapter> = {}): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    ROWS.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
  );
  return new OhmailEngine({ adapter: baseAdapter(over), store, now: () => NOW });
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // A device with no session cookie — `readOwner()` is null, so the preference lands under the
  // `local` key. Cleared per test so persistence is proven by a WRITE, never inherited.
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(engine: OhmailEngine, query: string): Promise<void> {
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(KeymapProvider, {
          children: h(SearchView, {
            engine, version: 1, now: NOW, query,
            onQuery: () => {}, onOpen: () => {},
          }),
        }),
      }),
    );
  });
}

/** Past the 250 ms archive debounce, plus the microtasks its promise resolves through. */
async function settleArchive(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 320));
  });
}

const control = (): HTMLSelectElement | null => host.querySelector<HTMLSelectElement>("#search-sort");
const hits = (): string[] => [...host.querySelectorAll(".hit .subj")].map((n) => n.textContent ?? "");

async function choose(value: string): Promise<void> {
  const el = control();
  if (!el) throw new Error("the sort control is not on screen");
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/* A store that has not answered yet: the device's first paint is what is on screen, and the
   local comparator is what orders it. Once a store answers, its page is in ITS order. */
const pendingStore = { searchServer: () => new Promise(() => {}) } as unknown as Partial<EngineAdapter>;
const pages = (asked: ServerSearchOpts[]) => asked.filter((o) => o.parts === "page");

describe("the search header offers an order", () => {
  it("renders exactly the five options, and only once there is a query", async () => {
    const engine = await engineWith({ searchServer: async () => ({ items: [], total: 0 }) } as unknown as Partial<EngineAdapter>);

    // Nothing to order when nothing has been asked.
    await render(engine, "");
    expect(control()).toBeNull();

    await render(engine, "heron");
    const el = control();
    expect(el).not.toBeNull();
    expect([...el!.options].map((o) => o.value)).toEqual([...SERVER_SEARCH_SORTS]);
    // The default is the behaviour that already existed.
    expect(el!.value).toBe("relevance");
    // Labelled, and by a real `for`/`id` pair rather than a floating caption.
    const label = host.querySelector<HTMLLabelElement>('label[for="search-sort"]');
    expect(label?.textContent).toBe("Sort by");
  });

  it("choosing an order RE-ASKS the archive for it", async () => {
    const asked: ServerSearchOpts[] = [];
    const engine = await engineWith({
      searchServer: async (_q: string, opts: ServerSearchOpts) => {
        asked.push(opts);
        return { items: [], total: 0 };
      },
    } as unknown as Partial<EngineAdapter>);

    await render(engine, "heron");
    await settleArchive();
    // The first pass carries the default explicitly; the HTTP adapter is what decides not to
    // put `relevance` on the wire, and that is asserted in the client-engine suite.
    expect(pages(asked).map((o) => o.sort)).toEqual(["relevance"]);

    await choose("date_desc");
    await settleArchive();

    // THE GUARD against a control that only re-sorts what is already in hand: the server holds
    // the whole corpus and decides WHICH rows come back for an order, so a new order is a new
    // question. Red if `sort` is missing from the archive effect's dependencies.
    expect(pages(asked).map((o) => o.sort)).toEqual(["relevance", "date_desc"]);
  });

  it("the ROWS come back in the chosen order — not just the request", async () => {
    const engine = await engineWith(pendingStore);
    await render(engine, "heron");
    await settleArchive();
    expect(hits().length).toBe(3);

    // THE GUARD this file exists for. These rows are the device's first paint — the store has
    // not answered — so a build that forwards `sort` to the server and leaves the paint in
    // relevance order passes every server-side test and fails here.
    await choose("date_desc");
    expect(hits()).toEqual(["Heron three", "Heron two", "Heron one"]);

    await choose("date_asc");
    expect(hits()).toEqual(["Heron one", "Heron two", "Heron three"]);

    // anna@ · mike@ · zoe@ — a third order, different from both date directions.
    await choose("sender");
    expect(hits()).toEqual(["Heron two", "Heron three", "Heron one"]);
  });

  it("relevance is the identity case — the merged order, untouched", async () => {
    const engine = await engineWith(pendingStore);
    await render(engine, "heron");
    await settleArchive();
    const before = hits();

    await choose("date_asc");
    await choose("relevance");
    // Back to exactly what the engine ranked, with no re-derivation of it.
    expect(hits()).toEqual(before);
  });

  it("the choice survives a reload", async () => {
    const engine = await engineWith(pendingStore);
    await render(engine, "heron");
    await choose("date_desc");

    // Written under the account-scoped key, so two people on one browser cannot inherit it.
    expect(window.localStorage.getItem(searchSortKey(null))).toBe("date_desc");

    // A reload: the whole tree goes away and comes back.
    await act(async () => root.unmount());
    root = createRoot(host);
    const fresh = await engineWith(pendingStore);
    await render(fresh, "heron");
    await settleArchive();

    expect(control()!.value).toBe("date_desc");
    expect(hits()).toEqual(["Heron three", "Heron two", "Heron one"]);
  });

  it("a stored value this build no longer offers is DISCARDED, not sent", async () => {
    // The upgrade case. A stale key naming a sort the server would refuse with a 400 must read
    // as "no preference" — otherwise every search a returning user runs fails, with nothing on
    // screen to say why and no way to clear it but wiping site data.
    window.localStorage.setItem(searchSortKey(null), "by_size");

    const asked: ServerSearchOpts[] = [];
    const engine = await engineWith({
      searchServer: async (_q: string, opts: ServerSearchOpts) => {
        asked.push(opts);
        return { items: [], total: 0 };
      },
    } as unknown as Partial<EngineAdapter>);

    await render(engine, "heron");
    await settleArchive();

    expect(control()!.value).toBe("relevance");
    expect(pages(asked).map((o) => o.sort)).toEqual(["relevance"]);
  });

  /**
   * The tester's shape: 28 'Berth plan' letters in the store, the newest `onDevice` of them on the
   * device, the store answering each order and the odd-numbered letters' sender facet.
   */
  async function berthRig(onDevice: number) {
    const berth = Array.from({ length: 28 }, (_, i) =>
      msg(`b${i}`, `Berth plan ${i}`, new Date(Date.UTC(2026, 5, 1 + i, 9)).toISOString(), i % 2 ? "odd@quay.test" : `crew${i}@quay.test`));
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges(berth.slice(28 - onDevice).map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })));
    const byDate = [...berth].sort((a, b) => a.date!.localeCompare(b.date!));
    const facets = {
      folder: {}, sender: [{ address: "odd@quay.test", count: 14 }],
      unread: { true: 0, false: 0 }, hasAttachments: { true: 0, false: 0 }, date: { today: 0, last7: 0, last30: 0, older: 0 },
    };
    const engine = new OhmailEngine({ adapter: baseAdapter({
      searchServer: async (_q: string, o: ServerSearchOpts & { filters?: { sender?: string } }) => {
        const all = o.sort === "date_asc" ? byDate : o.sort === "date_desc" ? [...byDate].reverse() : berth;
        const items = o.filters?.sender ? all.filter((m) => m.from.address === o.filters!.sender) : all;
        return { items, total: items.length, totalExact: true, nextCursor: null, ms: 3, facets };
      },
    } as unknown as Partial<EngineAdapter>), store, now: () => NOW });
    const opened: string[] = [];
    await act(async () => {
      root.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(KeymapProvider, { children: h(SearchView, {
          engine, version: 1, now: NOW, query: "berth plan", onQuery: () => {}, onOpen: (hit) => { opened.push(hit.message.id); },
        }) }),
      }));
    });
    const settle = () => act(async () => { await new Promise((r) => setTimeout(r, STORE_SEARCH_FOLLOWUP_HOLD_MS + 70)); });
    const press = (k: string) => act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    });
    const rows = (): string[] => [...host.querySelectorAll("[data-hit]")].map((el) => el.getAttribute("data-hit") ?? "");
    const cursorRow = (): number => rows().indexOf(host.querySelector('[data-hit][aria-current="true"]')?.getAttribute("data-hit") ?? "");
    const scrollTop = () => host.querySelector<HTMLElement>(".view-search .scroller")!.scrollTop;
    await settle();
    return { opened, settle, press, rows, cursorRow, scrollTop };
  }

  it("a new order starts the cursor at the top, also once the store answers it", async () => {
    const { opened, settle, press, rows, cursorRow, scrollTop } = await berthRig(28);
    const relTop = rows()[0];
    for (let i = 0; i < 3; i++) await press("ArrowDown");
    expect(cursorRow()).toBe(3);

    await choose("date_asc");
    await settle();
    expect(rows()[0], "the orders must differ at the top").not.toBe(relTop);
    expect(cursorRow(), `oldest first: ${rows().join(",")}`).toBe(0);

    await choose("relevance");
    await settle();
    expect(cursorRow(), `relevance: ${rows().join(",")}`).toBe(0);
    expect(scrollTop()).toBe(0);
    await press("Enter");
    expect(opened).toEqual([relTop]);
  });

  it("a new order starts at the top when the store holds letters the device does not", async () => {
    // The device's oldest match is not the store's: the cursor must not follow the device's top hit.
    const { opened, settle, press, rows, cursorRow, scrollTop } = await berthRig(10);
    for (let i = 0; i < 3; i++) await press("ArrowDown");

    await choose("date_asc");
    await settle();
    expect(rows()[0]).toBe("b0");
    expect(cursorRow(), `oldest first: ${rows().join(",")}`).toBe(0);
    expect(scrollTop()).toBe(0);
    await press("Enter");
    expect(opened).toEqual(["b0"]);
  });

  it("a question asked with a saved order starts at the top when the store holds more", async () => {
    window.localStorage.setItem(searchSortKey(null), "date_asc");
    const { opened, press, rows, cursorRow } = await berthRig(10);
    expect(rows()[0]).toBe("b0");
    expect(cursorRow(), `oldest first: ${rows().join(",")}`).toBe(0);
    await press("Enter");
    expect(opened).toEqual(["b0"]);
  });

  it("a pressed facet starts the cursor at the top", async () => {
    const { opened, settle, press, rows, cursorRow } = await berthRig(28);
    for (let i = 0; i < 4; i++) await press("ArrowDown");
    const held = rows()[cursorRow()];
    expect(held, "the cursor's letter must survive the filter").toBe("b23");

    const chip = [...host.querySelectorAll<HTMLElement>(".facets button")].find((b) => (b.textContent ?? "").includes("odd@"));
    expect(chip, "no sender facet to press").toBeTruthy();
    await act(async () => { chip!.click(); });
    await settle();
    const top = rows()[0];
    expect(rows()).toContain(held);
    expect(top).not.toBe(held);
    expect(cursorRow(), `odd@: ${rows().join(",")}`).toBe(0);
    await press("Enter");
    expect(opened).toEqual([top]);
  });
});
