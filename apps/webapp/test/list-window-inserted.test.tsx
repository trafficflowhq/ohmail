/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useListWindow } from "../app/shell/list-window";

/**
 * ROWS ARRIVING ABOVE EVERY INDEX (`inserted`, History's arrivals). Each row keeps its measured
 * height at its new index, so every offset below the arrivals is the old one plus their price;
 * inside the rows the row under the top edge holds, above them the new rows show on top. jsdom
 * has no layout: the scroller is a column of blocks, each row's height keyed to the ROW, not its
 * index, so a row that moves an index down keeps its height.
 */

const VIEW_PX = 600;
const CHROME_PX = 120;
const BASE = 1000;
let inserted = 0;
/** The row in index `i`: the rows that arrived take the negative identities. */
const rowOf = (i: number): number => i - inserted;
/** Rows from 500 on are taller, so reading there moves the mean. */
const rowPx = (row: number): number => (row >= 500 ? 150 : 60 + ((Math.abs(row) * 7) % 4) * 10);

function heightOf(el: Element): number {
  if (!(el instanceof HTMLElement)) return 0;
  if (el.classList.contains("chrome")) return CHROME_PX;
  if (el.dataset.row !== undefined) return rowPx(Number(el.dataset.row));
  if (el.style.height) return parseFloat(el.style.height);
  return [...el.children].reduce((n, c) => n + heightOf(c), 0);
}

function yIn(scroller: Element, el: Element): number {
  let y = 0;
  for (let node: Element | null = el; node && node !== scroller; node = node.parentElement) {
    for (let s = node.previousElementSibling; s; s = s.previousElementSibling) y += heightOf(s);
  }
  return y;
}

const saved: [object, string, PropertyDescriptor | undefined][] = [];
function stub(target: object, key: string, desc: PropertyDescriptor): void {
  saved.push([target, key, Object.getOwnPropertyDescriptor(target, key)]);
  Object.defineProperty(target, key, { configurable: true, ...desc });
}

function installLayout(): void {
  const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
  const rect = Element.prototype.getBoundingClientRect;
  stub(HTMLElement.prototype, "offsetHeight", { get(this: HTMLElement) { return heightOf(this); } });
  stub(Element.prototype, "clientHeight", {
    get(this: Element) { return this.classList.contains("scroller") ? VIEW_PX : 0; },
  });
  stub(Element.prototype, "scrollTop", {
    get(this: Element) { return scrollTop.get!.call(this) as number; },
    set(this: Element, v: number) {
      const max = this.classList.contains("scroller")
        ? Math.max(0, [...this.children].reduce((n, c) => n + heightOf(c), 0) - VIEW_PX)
        : Number.POSITIVE_INFINITY;
      scrollTop.set!.call(this, Math.max(0, Math.min(max, v)));
    },
  });
  stub(Element.prototype, "getBoundingClientRect", {
    value(this: Element): DOMRect {
      const scroller = this.closest(".scroller");
      if (!scroller) return rect.call(this);
      const top = this === scroller ? 0 : yIn(scroller, this) - scroller.scrollTop;
      const height = this === scroller ? VIEW_PX : heightOf(this);
      return { top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    },
  });
}

/** Offsets the window prices, read back by the case: `probe` indices, stamped on the scroller. */
let probe: number[] = [];
function List(): React.ReactElement {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const win = useListWindow({ scrollerRef, count: BASE + inserted, inserted });
  return (
    <div ref={scrollerRef} className="scroller" data-off={JSON.stringify(probe.map((i) => win.offsetOf(i)))}>
      <div className="chrome" />
      <div aria-hidden data-window-top="" style={{ height: win.padTop }} />
      {Array.from({ length: win.end - win.start }, (_, k) => (
        <div key={rowOf(win.start + k)} className="row" data-index={win.start + k} data-row={rowOf(win.start + k)} />
      ))}
      {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
    </div>
  );
}

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let roots: Root[] = [];

async function mount(): Promise<{ root: Root; scroller: HTMLElement }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(() => root.render(<List />));
  return { root, scroller: host.querySelector(".scroller") as HTMLElement };
}

async function arrive(root: Root, n: number): Promise<void> {
  inserted += n;
  await act(() => root.render(<List />));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

async function scrollTo(scroller: HTMLElement, px: number): Promise<void> {
  scroller.scrollTop = px;
  await act(async () => {
    scroller.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 30));
  });
}

const offsets = (scroller: HTMLElement): number[] => JSON.parse(scroller.dataset.off!) as number[];
/** The mounted row whose box holds the top edge: its identity and where it stands. */
function atTop(scroller: HTMLElement): { row: number; top: number } {
  const hit = [...scroller.querySelectorAll<HTMLElement>("[data-row]")].find((n) => {
    const r = n.getBoundingClientRect();
    return r.top <= 0 && r.bottom > 0;
  });
  expect(hit, "a mounted row holds the top edge").toBeDefined();
  return { row: Number(hit!.dataset.row), top: hit!.getBoundingClientRect().top };
}

describe("rows arriving above every index", () => {
  beforeEach(() => {
    inserted = 0;
    probe = [];
    installLayout();
  });

  afterEach(async () => {
    for (const r of roots) await act(() => r.unmount());
    roots = [];
    document.body.innerHTML = "";
    for (const [target, key, desc] of saved.splice(0).reverse()) {
      if (desc) Object.defineProperty(target, key, desc);
      else delete (target as Record<string, unknown>)[key];
    }
  });

  it("every measured row keeps its height at its new index: offsets below move by the new rows' price", async () => {
    const { root, scroller } = await mount();
    for (let px = 0; px <= 6_000; px += 400) await scrollTo(scroller, px);
    const rows = Array.from({ length: 40 }, (_, k) => 30 + k);
    probe = rows;
    await arrive(root, 0);
    const before = offsets(scroller);
    probe = [...rows.map((i) => i + 3), 0, 3];
    await arrive(root, 3);
    const after = offsets(scroller);
    const price = after[rows.length + 1]! - after[rows.length]!;
    expect(price).toBeGreaterThan(0);
    rows.forEach((i, k) => {
      expect(after[k]!, `row ${i}, now at index ${i + 3}`).toBeCloseTo(before[k]! + price, 6);
    });
  });

  it("read inside the rows, the row under the top edge stays where it stood", async () => {
    const { root, scroller } = await mount();
    await scrollTo(scroller, CHROME_PX + 300 * 75 + 10);
    await scrollTo(scroller, scroller.scrollTop);
    const before = atTop(scroller);
    await arrive(root, 2);
    const after = atTop(scroller);
    expect(after.row).toBe(before.row);
    expect(Math.abs(after.top - before.top)).toBeLessThan(0.5);
  });

  it("the new rows keep the price they arrived at when a later reading moves the mean", async () => {
    const { root, scroller } = await mount();
    probe = [0, 3];
    await scrollTo(scroller, CHROME_PX + 300 * 75);
    await arrive(root, 3);
    const [o0, o3] = offsets(scroller);
    for (let px = scroller.scrollTop; px < CHROME_PX + 760 * 90; px += 500) await scrollTo(scroller, px);
    const [p0, p3] = offsets(scroller);
    expect(p3! - p0!, "three arrivals above the reader, priced once").toBeCloseTo(o3! - o0!, 6);
    // About 92 scroll steps of 30 ms each, 2.8 s of waiting: 3.1 s on the CI VMs.
  }, 15_000);

  it("read at the top, the chrome is what is read: the new rows show on top and nothing scrolls", async () => {
    const { root, scroller } = await mount();
    expect(scroller.scrollTop).toBe(0);
    await arrive(root, 2);
    expect(scroller.scrollTop).toBe(0);
    const first = scroller.querySelector<HTMLElement>("[data-index='0']");
    expect(first?.dataset.row).toBe("-2");
  });
});
