/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { ESTIMATED_ROW_PX, MEASURED_FULL_RANGE_MAX_ROWS } from "@ohmail/app-logic/lists/list-window";
import { FIXTURE_NOW } from "../_store-fixture";
import { ohboxList } from "../_ohbox-1-list.js";

/**
 * A WINDOWED LIST TELLS ITS SIZE: THE OHBOX. Past 50 rows a list mounts a screenful, and a screen reader counts what is
 * mounted: a screenful's item count for a far longer Ohbox. The Ohbox's list is rendered well past the window and read
 * as the accessibility tree reads it (an item's `aria-setsize`/`aria-posinset` where stated, else its container's item
 * count and its place there) while the whole list is scrolled. Each row must be heard at one position, the positions
 * must be 1..size, and the size must never move.
 *
 * MOVED (share ohbox-2, the switch's older tests) word for word from `list-window-set-size.test.tsx`, whose other
 * cases still stand over the views of places not mounted yet: here the Ohbox's own list is drawn from its model
 * (`_ohbox-1-list.tsx`: the list's behaviour hook fed the same two groups, as the seat draws it), where today's
 * harness drew today's Ohbox view. Every expectation is as it stood.
 */

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

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (q: string) => ({ matches: false, media: q, addEventListener: none, removeEventListener: none, addListener: none, removeListener: none, onchange: null, dispatchEvent: () => false }),
  });
  vi.spyOn(console, "error").mockImplementation(none);
  vi.spyOn(console, "warn").mockImplementation(none);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** The Ohbox's own list over the two groups, and its scroller. */
async function ohbox(fresh: EngineMessage[], earlier: EngineMessage[]): Promise<{ host: HTMLElement; scroller: HTMLElement }> {
  const view = ohboxList({ newForYou: fresh, previouslySeen: earlier, now: NOW });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const host = view.container;
  const scroller = host.querySelector(".ob-scroll") as HTMLElement;
  expect(scroller, "no .ob-scroll mounted").not.toBeNull();
  return { host, scroller };
}

// ── the cases ───────────────────────────────────────────────────────────────────────────────

describe("a windowed list announces its true size and every row's true position", () => {
  it(`premise: ${N} rows is past the measured floor, so every list below is a window`, () => {
    expect(N).toBeGreaterThan(MEASURED_FULL_RANGE_MAX_ROWS);
  });

  it("the Ohbox, one group of 600", async () => {
    const m = await ohbox([], range(0, N));
    expectHeard(await walk(m.host, m.scroller, N + 1), { "Earlier": N }, (_, k) => indexOfKey(k) + 1);
  });

  it("the Ohbox, two groups: each listbox says its own group's size, the labels are no items", async () => {
    const m = await ohbox(range(0, 100, { unread: true }), range(100, N - 100));
    expectHeard(await walk(m.host, m.scroller, N + 2), { "New": 100, "Earlier": N - 100 },
      (label, k) => (label === "New" ? indexOfKey(k) + 1 : indexOfKey(k) - 100 + 1));
  });
});
