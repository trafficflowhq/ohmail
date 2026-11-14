/** @vitest-environment jsdom */
import type {
  EngineMessage,
  MutationOutcome,
  ScreenerSenderDTO,
  TagEntity as TagDTO,
} from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";
import { render, cleanup, screen, within } from "@testing-library/react";
import { Frame } from "@ohmail/app/frame";
import { TextProvider } from "@ohmail/app/text";
import { FOLDERS_ON, LIST_WORDS, listFrame } from "../../../packages/app/test/places/list-seat.js";
import { mountStreamFrame } from "../../../packages/app/test/streams/registered-world.js";
import { modelOf, mountPlace } from "../../../packages/app/test/screener/screener-world.js";
import trashWords from "../../../packages/app/messages/trash.en.json";
import { enterSearchRoute, RegisteredSearch, typeSearch } from "./search-registered-fixture";
import { ESTIMATED_ROW_PX } from "@ohmail/app-logic/lists/list-window";
import { CONTAINERS, expectHeard, indexOfKey, scrollTo, walk } from "./_windowed-list-hearing.js";
import { FIXTURE_NOW, storeFixture, storeRows } from "./_store-fixture";

/**
 * A WINDOWED LIST TELLS ITS SIZE. Past 50 rows a list mounts a screenful, and a screen reader counts
 * what is mounted: a screenful's item count for a far longer Ohbox. Every list kind is rendered well past the window and
 * read as the accessibility tree reads it — an item's `aria-setsize`/`aria-posinset` where stated,
 * else its container's item count and its place there — while the whole list is scrolled. Each row
 * must be heard at one position, the positions must be 1..size, and the size must never move.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

const N = 600;
const ISO = FIXTURE_NOW.toISOString();
const NOW = FIXTURE_NOW;
const none = () => {};

const message = (i: number, over: Partial<EngineMessage> = {}): EngineMessage =>
  ({
    id: `m${i}`, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `subject of m${i}`, from: { name: `Sender ${i}`, address: `s${i}@x.invalid` },
    to: [], cc: [], date: new Date(NOW.getTime() - (i + 1) * 60_000).toISOString(), folder: "INBOX",
    snippet: `snippet ${i}`, unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: ISO, ...over,
  }) as unknown as EngineMessage;
const range = (from: number, n: number, over: Partial<EngineMessage> = {}) =>
  Array.from({ length: n }, (_, i) => message(from + i, over));

// ── what an assistive technology is told ────────────────────────────────────────────────────

// ── mounting ────────────────────────────────────────────────────────────────────────────────

let restoreRoute: (() => void) | undefined;
const hadCss = typeof (globalThis as unknown as { CSS?: unknown }).CSS !== "undefined";
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (q: string) => ({ matches: false, media: q, addEventListener: none, removeEventListener: none, addListener: none, removeListener: none, onchange: null, dispatchEvent: () => false }),
  });
  if (!hadCss) (globalThis as unknown as { CSS: unknown }).CSS = { escape: (s: string) => s.replace(/["\\]/g, "\\$&") };
  globalThis.fetch = (async () =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  window.localStorage.clear();
  vi.spyOn(console, "error").mockImplementation(none);
  vi.spyOn(console, "warn").mockImplementation(none);
});
afterEach(async () => {
  cleanup();
  restoreRoute?.();
  restoreRoute = undefined;
  document.body.innerHTML = "";
  if (!hadCss) (globalThis as unknown as { CSS?: unknown }).CSS = undefined;
  vi.restoreAllMocks();
});

function scrollerOf(host: HTMLElement, role: "listbox" | "list", name: string): HTMLElement {
  const list = within(host).getByRole(role, { name });
  const scroller = list.closest<HTMLElement>(".pl-scroll, .sr-scroll, .sc-scroll");
  expect(scroller, `no scroller for ${name}`).not.toBeNull();
  return scroller!;
}

function renderRegistered(options: Parameters<typeof listFrame>[0], engine?: OhmailEngine): HTMLElement {
  const { host } = listFrame(options);
  return render(
    <TextProvider locale="en" messages={{ ...LIST_WORDS, ...trashWords }} timeZone="UTC" now={NOW}>
      <Frame host={engine ? { ...host, engine } : host} />
    </TextProvider>,
  ).container;
}

async function engineOver(rows: EngineMessage[], extra: Partial<EngineAdapter> = {}): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  await store.applyChanges(rows.map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })));
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: ISO }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    ...extra,
  } as unknown as EngineAdapter;
  return new OhmailEngine({ adapter, store, now: () => NOW });
}

// ── the cases ───────────────────────────────────────────────────────────────────────────────

describe("a windowed list announces its true size and every row's true position", () => {
  /* The premise and the Ohbox's two cases moved to `ohbox/list-window-set-size-ohbox.test.tsx` (share ohbox-2): the
     Ohbox's own list, drawn from its model. Every case below still asserts its own window (`expectHeard`'s first line). */

  it("News with the line and the AI chip: both are in the index space and neither is an item", async () => {
    const letters = range(0, N, { folder: "ohmail/News" });
    mountStreamFrame({
      at: "#/reads",
      letters,
      rows: {
        "view_meta:reads_waterline": { newestSeenId: "m100", at: letters[100]!.date },
        "view_meta:reads_ai_chip": { afterId: "m10", label: "Filed here by ohmail", approvedLabel: "Kept", correctedLabel: "Moved" },
      },
    });
    const host = screen.getByRole("region", { name: "News" });
    const scroller = scrollerOf(host, "listbox", "News");
    expect(within(host).queryByText("Filed here by ohmail"), "the chip is not mounted — the case asks nothing about it").not.toBeNull();
    const h = await walk(host, scroller, N + 2);
    const line = within(host).queryByRole("separator");
    expectHeard(h, { News: 100, "Seen up to here": N - 100 },
      (label, k) => (label === "News" ? indexOfKey(k) + 1 : indexOfKey(k) - 100 + 1));
    expect(line === null || (line.getAttribute("role") === "separator" && line.closest(CONTAINERS) === null)).toBe(true);
  });


  it("a folder of hundreds of rows, its two groups in one listbox", async () => {
    const rows = [...range(0, 60, { unread: true, folder: "Projects" as never }), ...range(60, N - 60, { folder: "Projects" as never })];
    const folder = { id: "fd1", name: "Projects", mailboxId: "mb", mailbox: "a@x.invalid" };
    const host = renderRegistered({
      first: `#/folder/${folder.id}`, letters: rows, consent: FOLDERS_ON,
      more: { [`folder:${folder.id}`]: folder },
    });
    const first = await within(host).findByRole("listbox", { name: "New" });
    const m = { host, scroller: first.closest<HTMLElement>(".pl-scroll")! };
    expectHeard(await walk(m.host, m.scroller, N), { Projects: N }, (_, k) => indexOfKey(k) + 1);
  });

  it("a Trash of 600", async () => {
    const rows = range(0, N, { trashedAt: ISO, restoreTo: "INBOX" } as never);
    const host = renderRegistered({
      first: "#/trash",
      consent: FOLDERS_ON,
      letters: [],
      engine: () => ({
        trashAvailable: () => true,
        listTrash: async () => ({ state: "ready", items: rows, nextCursor: null }),
      }),
    });
    await within(host).findByRole("listbox", { name: "Trash" });
    const m = { host, scroller: scrollerOf(host, "listbox", "Trash") };
    expectHeard(await walk(m.host, m.scroller, N), { Trash: N }, (_, k) => indexOfKey(k) + 1);
  });


  it("History over a store of 600", async () => {
    const { engine } = await storeFixture(storeRows(N));
    const host = renderRegistered({ first: "#/history", letters: [] }, engine);
    await within(host).findByRole("listbox", { name: "History" });
    const m = { host, scroller: scrollerOf(host, "listbox", "History") };
    const slotOf = (id: string): number => 0xffffffff - parseInt(id.slice(-12), 16);
    /* The store answers a page at a time: walk until every slot has been heard or the walk stops moving. */
    let h = await walk(m.host, m.scroller, N);
    for (let i = 0; i < 4 && (h.at.get("History")?.size ?? 0) < N; i++) {
      await scrollTo(m.scroller, 0);
      const again = await walk(m.host, m.scroller, N);
      for (const [label, at] of again.at) for (const [k, p] of at) h.at.get(label)?.set(k, p);
      for (const [label, s] of again.sizes) for (const v of s) h.sizes.get(label)?.add(v);
      h = { ...h, conflicts: [...h.conflicts, ...again.conflicts], mountedMax: Math.max(h.mountedMax, again.mountedMax) };
    }
    expectHeard(h, { History: N }, (_, k) => slotOf(k) + 1);
  });

  it("Search, 600 hits from the store", async () => {
    const hits = range(0, N, { subject: "AXA letter" });
    const engine = await engineOver([], {
      searchServer: async (_q: string, o: { parts?: string; cursor?: string }) =>
        o.parts === "summary"
          ? { items: [], total: N, totalExact: true }
          : { items: hits, total: N, totalExact: true, nextCursor: null, ms: 5 },
    } as never);
    restoreRoute = enterSearchRoute();
    const { container: host } = render(<RegisteredSearch engine={engine} now={NOW} />);
    await act(async () => { typeSearch(host, "axa"); });
    await within(host).findByRole("list", { name: "Search" });
    const m = { host, scroller: scrollerOf(host, "list", "Search") };
    expectHeard(await walk(m.host, m.scroller, N), { Search: N }, (_, k) => indexOfKey(k) + 1);
  });

  it("an Answer Later pile of 600", async () => {
    const all = range(0, N);
    const host = renderRegistered({ first: "#/triage", letters: all.map((letter) => ({
      ...letter,
      triage: { messageId: letter.id, state: "reply_later", bubbleUpAt: null, setAt: ISO, updatedAt: ISO },
    })) });
    const m = { host, scroller: scrollerOf(host, "listbox", "Answer Later") };
    expectHeard(await walk(m.host, m.scroller, N), { "Answer Later": N }, (_, k) => indexOfKey(k) + 1);
  });

  it("a tag of 600", async () => {
    const tag = { id: "t1", name: "Studio" } as TagDTO;
    const host = renderRegistered({ first: "#/tag/t1", letters: range(0, N, { labels: ["t1"] }),
      more: { "tag:t1": tag },
    });
    const m = { host, scroller: scrollerOf(host, "listbox", "Studio") };
    expectHeard(await walk(m.host, m.scroller, N), { Studio: N }, (_, k) => indexOfKey(k) + 1);
  });

  it("the Screener, hundreds of senders waiting", async () => {
    const held = Array.from({ length: N }, (_, i) =>
      message(i, { folder: "ohmail/Screener" as never, unread: true, from: { name: null, address: `w${i}@gate${i}.invalid` } }));
    mountStreamFrame({ at: "#/screener", letters: held });
    const list = await screen.findByRole("listbox", { name: "Screener" });
    const m = { host: list.parentElement!.parentElement!, scroller: list.closest<HTMLElement>(".sc-scroll")! };
    expectHeard(await walk(m.host, m.scroller, N), { Screener: N });
  });

  it("the Screener with decided senders: queue and decided rows are one set, their heading no item", async () => {
    const QUEUE = 100;
    const sender = (id: string): ScreenerSenderDTO => ({
      id, from: { name: `Sender ${id}`, address: `${id}@gate.invalid` }, initial: "S", derived: true,
      scope: "sender" as const, segment: "waiting" as const, updatedAt: ISO, ai: null, time: "09:00",
      held: [{
        id: `h-${id}`, subject: `Subject ${id}`, time: "09:00", body: "body", html: null, bodyState: "full" as const,
        unsubscribe: "no_header" as const, unsubscribeUrl: null,
      }],
    });
    const decided = Array.from({ length: N - QUEUE }, (_, i) => ({
      sender: sender(`d${i}`),
      decision: { subject: `d${i}@gate.invalid`, scope: "sender" as const, decidedAt: ISO, holder: "ohmail Cloud", state: "sent" as const },
    }));
    /* The view's own double, shaped as `organizer-notice.test.tsx` shapes it: a reader install whose
       organizer is elsewhere, so a decided sender stays on screen under "pending" until it lands. */
    mountPlace(modelOf({ flushes: 0 }, {
      role: { mode: "pending", name: "ohmail Cloud", reason: null, oauthOnly: false },
      pending: decided.map((d) => d.decision),
      waiting: Array.from({ length: QUEUE }, (_, i) => sender(`w${i}`)), waitingCount: QUEUE,
      decided, notApplied: [],
    }));
    const list = screen.getByRole("listbox", { name: "Screener" });
    const m = { host: list.parentElement!.parentElement!, scroller: list.closest<HTMLElement>(".sc-scroll")! };
    const h = await walk(m.host, m.scroller, N + 1);
    expectHeard(h, { Screener: N });
    await scrollTo(m.scroller, (QUEUE - 4) * ESTIMATED_ROW_PX);
    const heading = within(m.host).queryByRole("heading", { name: /Waiting for the organizer/ });
    expect(heading, "the decided heading is not mounted at its slot — the case asks nothing about it").not.toBeNull();
    expect(heading!.closest('[role="option"]')).toBeNull();
    const off = [...(h.at.get("Screener") ?? [])]
      .filter(([k, p]) => k.startsWith("d") && p !== QUEUE + Number(k.slice(1)) + 1);
    expect(off.slice(0, 5), "a decided sender heard away from its place after the queue").toEqual([]);
  });
});
