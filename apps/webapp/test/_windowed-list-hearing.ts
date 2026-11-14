import { act } from "@testing-library/react";
import { expect } from "vitest";
import { ESTIMATED_ROW_PX } from "@ohmail/app-logic/lists/list-window";

interface Box {
  label: string;
  items: { key: string; size: number; position: number }[];
}
const ITEM_ROLE: Record<string, string> = { listbox: "option", list: "listitem" };
export const CONTAINERS = '[role="listbox"], [role="list"]';
const hidden = (n: Element): boolean => n.closest('[aria-hidden="true"]') !== null;
const num = (v: string | null): number | null => (v === null ? null : Number(v));

/** Every list container on screen, and each of its items as the tree states it. */
function hear(root: Element, fallbackKey: (item: HTMLElement, slot: number) => string): Box[] {
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
        key: n.getAttribute("data-id") ?? n.getAttribute("data-rule-id") ?? n.getAttribute("data-hit") ?? fallbackKey(n, k),
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

export async function scrollTo(scroller: HTMLElement, px: number, advance?: (ms: number) => Promise<void>): Promise<void> {
  scroller.scrollTop = px;
  await act(async () => {
    scroller.dispatchEvent(new Event("scroll"));
    if (!advance) await new Promise((r) => setTimeout(r, 40));
  });
  await advance?.(40);
}

/** Scroll the list top to bottom in steps inside one viewport, reading the tree at every stop. */
export async function walk(host: HTMLElement, scroller: HTMLElement, slots: number, options: {
  advance?: (ms: number) => Promise<void>;
  fallbackKey?: (item: HTMLElement, slot: number) => string;
} = {}): Promise<Heard> {
  const heard: Heard = { sizes: new Map(), at: new Map(), conflicts: [], mountedMax: 0 };
  const read = () => {
    let mounted = 0;
    for (const b of hear(host, options.fallbackKey ?? ((_, slot) => `#${slot}`))) {
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
    await scrollTo(scroller, top, options.advance);
    read();
  }
  return heard;
}

/**
 * The verdict: each named container announced at exactly its size, every row heard once at one
 * position, 1..size, and — where the order is known — at the position its place in the list gives.
 */
export function expectHeard(h: Heard, sizes: Record<string, number>, positionOf?: (label: string, key: string) => number): void {
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

export const indexOfKey = (key: string): number => Number(key.slice(1));
