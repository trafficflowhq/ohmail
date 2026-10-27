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
  type FeedPartition,
  type MutationOutcome,
  type RuleDTO,
  type SyncChange,
  type SyncResponse,
  type TagDTO,
} from "@ohmail/client-engine";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { OhboxView } from "../app/views/OhboxView";
import { ReadsView } from "../app/views/ReadsView";
import { ReceiptsView } from "../app/views/ReceiptsView";
import { FolderView } from "../app/views/FolderView";
import { TrashView } from "../app/views/TrashView";
import { RulesView } from "../app/views/RulesView";
import { HistoryView } from "../app/views/HistoryView";
import { SearchView } from "../app/views/SearchView";
import { TriageView } from "../app/views/TriageView";
import { TagView } from "../app/views/TagView";
import { ScreenerView } from "../app/views/ScreenerView";
import { useScreenerState } from "../app/shell/screener-state";
import { KeymapProvider } from "../app/shell/keymap";
import { WithListGone } from "./_list-gone";
import { ESTIMATED_ROW_PX, MEASURED_FULL_RANGE_MAX_ROWS } from "../app/shell/list-window";
import { settleFirstPaint } from "./_first-paint.js";
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
const tags: TagDTO[] = [];
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

interface Box {
  label: string;
  items: { key: string; size: number; position: number }[];
}
const ITEM_ROLE: Record<string, string> = { listbox: "option", list: "listitem" };
const CONTAINERS = '[role="listbox"], [role="list"]';
const hidden = (n: Element): boolean => n.closest('[aria-hidden="true"]') !== null;
const num = (v: string | null): number | null => (v === null ? null : Number(v));

/** Every list container on screen, and each of its items as the tree states it. */
function hear(root: Element): Box[] {
  const boxes: Box[] = [];
  for (const box of root.querySelectorAll<HTMLElement>(CONTAINERS)) {
    if (hidden(box)) continue;
    const role = ITEM_ROLE[box.getAttribute("role")!]!;
    const items = [...box.querySelectorAll<HTMLElement>(`[role="${role}"]`)].filter(
      (n) => !hidden(n) && n.parentElement?.closest(CONTAINERS) === box,
    );
    boxes.push({
      label: box.getAttribute("aria-label") ?? "",
      items: items.map((n, k) => ({
        key: n.getAttribute("data-id") ?? n.getAttribute("data-rule-id") ?? n.getAttribute("data-hit") ?? `#${k}`,
        size: num(n.getAttribute("aria-setsize")) ?? items.length,
        position: num(n.getAttribute("aria-posinset")) ?? k + 1,
      })),
    });
  }
  return boxes;
}

interface Heard {
  /** Per container label: every size an item was announced at. */
  sizes: Map<string, Set<number>>;
  /** Per container label: key → the position it was heard at. */
  at: Map<string, Map<string, number>>;
  conflicts: string[];
  /** The most items mounted at once — the premise that this is a window at all. */
  mountedMax: number;
}

const STEP_ROWS = 20;

async function scrollTo(scroller: HTMLElement, px: number): Promise<void> {
  scroller.scrollTop = px;
  await act(async () => {
    scroller.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 40));
  });
}

/** Scroll the list top to bottom in steps inside one viewport, reading the tree at every stop. */
async function walk(host: HTMLElement, scroller: HTMLElement, slots: number): Promise<Heard> {
  const heard: Heard = { sizes: new Map(), at: new Map(), conflicts: [], mountedMax: 0 };
  const read = () => {
    let mounted = 0;
    for (const b of hear(host)) {
      mounted += b.items.length;
      const sizes = heard.sizes.get(b.label) ?? new Set<number>();
      const at = heard.at.get(b.label) ?? new Map<string, number>();
      heard.sizes.set(b.label, sizes);
      heard.at.set(b.label, at);
      for (const it of b.items) {
        sizes.add(it.size);
        const was = at.get(it.key);
        if (was !== undefined && was !== it.position) heard.conflicts.push(`${b.label}: ${it.key} at ${was}, then ${it.position}`);
        at.set(it.key, it.position);
      }
    }
    heard.mountedMax = Math.max(heard.mountedMax, mounted);
  };
  read();
  for (let top = STEP_ROWS * ESTIMATED_ROW_PX; top <= (slots + STEP_ROWS) * ESTIMATED_ROW_PX; top += STEP_ROWS * ESTIMATED_ROW_PX) {
    await scrollTo(scroller, top);
    read();
  }
  return heard;
}

/**
 * The verdict: each named container announced at exactly its size, every row heard once at one
 * position, 1..size, and — where the order is known — at the position its place in the list gives.
 */
function expectHeard(h: Heard, sizes: Record<string, number>, positionOf?: (label: string, key: string) => number): void {
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  expect(h.mountedMax, "every row was mounted at once — this list is not a window here").toBeLessThan(total);
  const heardLabels = [...h.at].filter(([, at]) => at.size > 0).map(([l]) => l).sort();
  expect(heardLabels).toEqual(Object.keys(sizes).sort());
  for (const [label, size] of Object.entries(sizes)) {
    expect([...(h.sizes.get(label) ?? [])].sort((a, b) => a - b), `${label}: the size its rows are announced at`).toEqual([size]);
  }
  expect(h.conflicts, h.conflicts.slice(0, 5).join("\n")).toEqual([]);
  for (const [label, size] of Object.entries(sizes)) {
    const positions = [...(h.at.get(label)?.values() ?? [])].sort((a, b) => a - b);
    expect(positions, `${label}: every row heard once, at 1..${size}`).toEqual(Array.from({ length: size }, (_, i) => i + 1));
    if (positionOf) {
      const off = [...(h.at.get(label) ?? [])].filter(([key, p]) => p !== positionOf(label, key));
      expect(off.slice(0, 5), `${label}: rows heard away from their place`).toEqual([]);
    }
  }
}

const indexOfKey = (key: string): number => Number(key.slice(1));

// ── mounting ────────────────────────────────────────────────────────────────────────────────

let roots: Root[] = [];
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
  for (const r of roots) await act(() => r.unmount());
  roots = [];
  document.body.innerHTML = "";
  if (!hadCss) (globalThis as unknown as { CSS?: unknown }).CSS = undefined;
  vi.restoreAllMocks();
});

async function mount(node: React.ReactNode, scrollerSel = ".scroller"): Promise<{ host: HTMLElement; scroller: HTMLElement }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} now={NOW} timeZone="UTC">
        <ThemeProvider storageKey={null}>
          <ToastHost>
            <KeymapProvider><WithListGone>{node}</WithListGone></KeymapProvider>
          </ToastHost>
        </ThemeProvider>
      </NextIntlClientProvider>,
    );
  });
  await settleFirstPaint();
  const scroller = host.querySelector(scrollerSel) as HTMLElement;
  expect(scroller, `no ${scrollerSel} mounted`).not.toBeNull();
  return { host, scroller };
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

const ohbox = (fresh: EngineMessage[], earlier: EngineMessage[]) => (
  <OhboxView owed={false} demo={false} newForYou={fresh} previouslySeen={earlier}
    tags={tags} now={NOW} selectedId={null} onSelect={none} onEnterReader={none}
    onMarkSeen={none} readerId={null} readSetFor={(id: string) => [id]} doorbellInitials={[]} doorbellCount={0} settled
    onDoorbell={none} onAction={none} onAddTag={none}
    bulk={{ run: () => true, tag: none, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => true }}
    older={{ available: false, items: [], loading: false, error: null, exhausted: true, loadMore: none }}
  />
);

const body = () => ({ text: "body", state: "snippet", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }) as never;

const news = (partition: FeedPartition, aiChip: { afterId: string } | null = null) => (
  <ReadsView settled owed={false} partition={partition} tags={tags} now={NOW} cur={null} onCur={none}
    aiChip={aiChip ? { ...aiChip, label: "Filed here by ohmail", approvedLabel: "Kept", correctedLabel: "Moved" } : null}
    chipState={null} onChipState={none} markSeen={none}
    bodyOf={body} hydrateBody={none} jumpTo={null} onJumped={none} onAction={none} />
);

const receipts = (all: EngineMessage[], freshCount?: number) => (
  <ReceiptsView settled owed={false} messages={all} tags={tags} now={NOW}
    {...(freshCount !== undefined ? { freshCount, waterline: { at: ISO } as never } : {})}
    cur={null} onCur={none} unreadCount={0} isUnread={() => false} markSeen={none}
    bodyOf={body} hydrateBody={none} jumpTo={null} onJumped={none} onAction={none} />
);

let ruleSeq = 0;
const rule = (i: number): RuleDTO => ({
  id: `r${i}`, kind: "sender", match: `sender${String(i).padStart(3, "0")}@rules.invalid`, destination: "INBOX",
  priority: 0, provenance: "manual", enabled: true, subjectContains: null, bodyContains: null,
  stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: new Date(NOW.getTime() - (++ruleSeq) * 60_000).toISOString(), updatedAt: ISO,
});

// ── the cases ───────────────────────────────────────────────────────────────────────────────

describe("a windowed list announces its true size and every row's true position", () => {
  it(`premise: ${N} rows is past the measured floor, so every list below is a window`, () => {
    expect(N).toBeGreaterThan(MEASURED_FULL_RANGE_MAX_ROWS);
  });

  it("the Ohbox, one group of 600", async () => {
    const m = await mount(ohbox([], range(0, N)));
    expectHeard(await walk(m.host, m.scroller, N + 1), { "Earlier": N }, (_, k) => indexOfKey(k) + 1);
  });

  it("the Ohbox, two groups: each listbox says its own group's size, the labels are no items", async () => {
    const m = await mount(ohbox(range(0, 100, { unread: true }), range(100, N - 100)));
    expectHeard(await walk(m.host, m.scroller, N + 2), { "New": 100, "Earlier": N - 100 },
      (label, k) => (label === "New" ? indexOfKey(k) + 1 : indexOfKey(k) - 100 + 1));
  });

  it("News, 600 above no line", async () => {
    const all = range(0, N);
    const m = await mount(news({ waterline: null, fresh: all, seen: [], newCount: 0 }));
    expectHeard(await walk(m.host, m.scroller, N), { News: N }, (_, k) => indexOfKey(k) + 1);
  });

  it("News with the line and the AI chip: both are in the index space and neither is an item", async () => {
    const m = await mount(news(
      { waterline: { at: ISO } as never, fresh: range(0, 100), seen: range(100, N - 100), newCount: 0 },
      { afterId: "m10" },
    ));
    expect(m.host.querySelector(".reads-chip-row"), "the chip is not mounted — the case asks nothing about it").not.toBeNull();
    const h = await walk(m.host, m.scroller, N + 2);
    const line = m.host.querySelector(".list-col .waterline");
    expectHeard(h, { News: 100, "Seen up to here": N - 100 },
      (label, k) => (label === "News" ? indexOfKey(k) + 1 : indexOfKey(k) - 100 + 1));
    expect(line === null || (line.getAttribute("role") === "separator" && line.closest(CONTAINERS) === null)).toBe(true);
  });

  it("Receipts, 600 above no line", async () => {
    const m = await mount(receipts(range(0, N)));
    expectHeard(await walk(m.host, m.scroller, N), { Receipts: N }, (_, k) => indexOfKey(k) + 1);
  });

  it("Receipts with the line: the rows on each side counted, the line not", async () => {
    const m = await mount(receipts(range(0, N), 40));
    expectHeard(await walk(m.host, m.scroller, N + 1), { Receipts: 40, "Seen up to here": N - 40 },
      (label, k) => (label === "Receipts" ? indexOfKey(k) + 1 : indexOfKey(k) - 40 + 1));
    const line = m.host.querySelector(".waterline");
    expect(line === null || line.closest(CONTAINERS) === null).toBe(true);
  });

  it("a folder of hundreds of rows, its two groups in one listbox", async () => {
    const rows = [...range(0, 60, { unread: true, folder: "Projects" as never }), ...range(60, N - 60, { folder: "Projects" as never })];
    const m = await mount(
      <FolderView onMarkSeen={() => {}}
        folder={{ id: "fd1", name: "Projects", mailboxId: "mb", mailbox: "a@x.invalid" }}
        messages={rows as never[]}
        older={{ available: false, items: [], loading: false, error: null, exhausted: true, loadMore: none }}
        tags={[]} now={NOW} onOpen={none} hydrateBody={none} onAction={none} onAddTag={none}
        onScreen={none} canDelete={() => true} canReplyAll={() => true}
      />,
    );
    expectHeard(await walk(m.host, m.scroller, N), { Projects: N }, (_, k) => indexOfKey(k) + 1);
  });

  it("a Trash of 600", async () => {
    const rows = range(0, N, { trashedAt: ISO, restoreTo: "INBOX" } as never);
    const m = await mount(
      <TrashView
        page={{ available: true, items: rows as never[], loading: false, error: null, exhausted: true, loadMore: none }}
        tags={[]} now={NOW} onOpen={none} hydrateBody={none} onAction={none} onAddTag={none}
        {...({} as Record<string, never>)}
      />,
    );
    expectHeard(await walk(m.host, m.scroller, N), { Trash: N }, (_, k) => indexOfKey(k) + 1);
  });

  it("the Rules list, six hundred rules", async () => {
    const m = await mount(
      <RulesView rules={Array.from({ length: N }, (_, i) => rule(i))}
        onRevoke={async () => ({ status: "confirmed" as const })}
        onRetarget={async () => ({ status: "confirmed" as const })} pastMail={() => null} />,
      ".rules-scroll",
    );
    expectHeard(await walk(m.host, m.scroller, N), { Rules: N });
  });

  it("History over a store of 600", async () => {
    const { engine } = await storeFixture(storeRows(N));
    const m = await mount(
      <HistoryView onMarkSeen={() => {}} engine={engine} version={0} settled owed={false} tags={tags} now={NOW}
        onOpen={none} hydrateBody={none} onAction={none} onAddTag={none} onScreen={none}
        canDelete={() => true} canReplyAll={() => true} />,
    );
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
    const m = await mount(
      <SearchView engine={engine} version={1} now={NOW} query="axa" onQuery={none} onOpen={none} />,
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 320)); });
    expectHeard(await walk(m.host, m.scroller, N), { Search: N }, (_, k) => indexOfKey(k) + 1);
  });

  it("an Answer Later pile of 600", async () => {
    const all = range(0, N);
    const byId = new Map(all.map((x) => [x.id, x]));
    const m = await mount(
      <TriageView onMarkSeen={() => {}} settled owed={false}
        piles={{ replyLater: all.map((x) => ({ messageId: x.id, title: x.subject })), setAside: [], resurface: [] }}
        pile="reply" onPile={none} frDone={new Set<string>()} onStartFR={none}
        messageOf={(id) => byId.get(id) ?? null}
        tags={tags} now={NOW} onOpen={none} hydrateBody={none} onAction={none} onAddTag={none}
      />,
    );
    expectHeard(await walk(m.host, m.scroller, N), { Triage: N }, (_, k) => indexOfKey(k) + 1);
  });

  it("a tag of 600", async () => {
    const tag = { id: "t1", name: "Studio" } as TagDTO;
    const m = await mount(
      <TagView onMarkSeen={() => {}} settled owed={false} tag={tag} messages={range(0, N, { labels: ["t1"] })} onScreen={none} canDelete={() => true}
        canReplyAll={() => true} tags={[tag]} now={NOW} onOpen={none} hydrateBody={none} onAction={none} onAddTag={none} />,
    );
    expectHeard(await walk(m.host, m.scroller, N), { Studio: N }, (_, k) => indexOfKey(k) + 1);
  });

  it("the Screener, hundreds of senders waiting", async () => {
    const held = Array.from({ length: N }, (_, i) =>
      message(i, { folder: "ohmail/Screener" as never, unread: true, from: { name: null, address: `w${i}@gate${i}.invalid` } }));
    const engine = await engineOver(held);
    function Probe(): React.ReactElement {
      const [v, setV] = React.useState(0);
      React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
      const state = useScreenerState(engine, v, none as never);
      return (
        <ScreenerView {...({
          owed: false, state, segment: "waiting", settled: true,
          selection: { waiting: null, screened: null, spam: null },
          onSelect: none, hydrateBody: none, hydrateBodies: none, full: false, onFull: none,
        } as unknown as React.ComponentProps<typeof ScreenerView>)} />
      );
    }
    const m = await mount(<Probe />);
    for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
    expectHeard(await walk(m.host, m.scroller, N), { Screener: N });
  });

  it("the Screener with decided senders: queue and decided rows are one set, their heading no item", async () => {
    const QUEUE = 100;
    const sender = (id: string) => ({
      id, from: { name: `Sender ${id}`, address: `${id}@gate.invalid` }, initial: "S", derived: true,
      scope: "sender" as const, ai: null, time: "09:00",
      held: [{
        id: `h-${id}`, subject: `Subject ${id}`, time: "09:00", body: "body", html: null, bodyState: "ready" as const,
        unsubscribe: "no_header" as const, unsubscribeUrl: null, trackerNote: null,
      }],
    });
    const decided = Array.from({ length: N - QUEUE }, (_, i) => ({
      sender: sender(`d${i}`),
      decision: { subject: `d${i}@gate.invalid`, scope: "sender", decidedAt: ISO, holder: "ohmail Cloud", state: "sent" },
    }));
    /* The view's own double, shaped as `organizer-notice.test.tsx` shapes it: a reader install whose
       organizer is elsewhere, so a decided sender stays on screen under "pending" until it lands. */
    const state = {
      suggestedCount: 0, suggestedDests: [], unsuggestedSenders: [], suggestedSenders: [], applying: null,
      screenedOut: [], spam: [], isExiting: () => false, refused: () => false, bodyStall: () => null,
      decide: none, applyAll: none, markAllSpam: none, allowScreened: none, notSpamToWaiting: none,
      notSpamToOhbox: none, deleteSpam: none, flush: none,
      waitingSource: "store", waitingMore: { available: false, loading: false, failed: false, load: () => {} }, rereadWaiting: () => {},
      role: { mode: "pending", name: "ohmail Cloud", reason: null, oauthOnly: false },
      pending: decided.map((d) => d.decision),
      waiting: Array.from({ length: QUEUE }, (_, i) => sender(`w${i}`)), waitingCount: QUEUE,
      decided, notApplied: [],
    };
    const m = await mount(
      <ScreenerView {...({
        owed: false, state, segment: "waiting", settled: true,
        selection: { waiting: null, screened: null, spam: null },
        onSelect: none, hydrateBody: none, hydrateBodies: none, full: false, onFull: none,
      } as unknown as React.ComponentProps<typeof ScreenerView>)} />,
    );
    const h = await walk(m.host, m.scroller, N + 1);
    expectHeard(h, { Screener: N });
    await scrollTo(m.scroller, (QUEUE - 4) * ESTIMATED_ROW_PX);
    const heading = m.host.querySelector('[data-group="decided"]');
    expect(heading, "the decided heading is not mounted at its slot — the case asks nothing about it").not.toBeNull();
    expect(heading!.closest('[role="option"]')).toBeNull();
    const off = [...(h.at.get("Screener") ?? [])]
      .filter(([k, p]) => k.startsWith("d") && p !== QUEUE + Number(k.slice(1)) + 1);
    expect(off.slice(0, 5), "a decided sender heard away from its place after the queue").toEqual([]);
  });
});
