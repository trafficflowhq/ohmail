/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { EngineMessage, OhmailEngine, TagDTO } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { HistoryView as HistoryViewRaw } from "../app/views/HistoryView";
import { KeymapProvider } from "../app/shell/keymap";
import { WithListGone } from "./_list-gone";
import { FIXTURE_NOW, idOf, storeFixture, storeMessage } from "./_store-fixture";

/**
 * A RAIL PRESS LANDS ON THE PERIOD PRESSED. A year or month press puts that period's first row at
 * the top edge and opens that year, over a multi-year store whose rows are measured at uneven
 * heights, under an explainer note that stands above the rows. jsdom has no layout, so the rows'
 * boxes are stacked here from the same heights the window measures; the web and the paired
 * desktop render this one HistoryView.
 */

const HistoryView = (props: React.ComponentProps<typeof HistoryViewRaw>) => (
  <KeymapProvider><WithListGone><HistoryViewRaw {...props} /></WithListGone></KeymapProvider>
);

const NOTE_PX = 90;
const VIEW_PX = 600;
const FOOT_PX = 48;
const GHOST_PX = 72;
const UNEVEN = (i: number): number => 64 + ((i * 7) % 4) * 12;
let rowPx = UNEVEN;

function heightOf(el: Element): number {
  if (!(el instanceof HTMLElement)) return 0;
  if (el.classList.contains("history-gone")) return 0;
  if (el.classList.contains("history-ghost")) return GHOST_PX;
  if (el.classList.contains("row") && el.dataset.index !== undefined) return rowPx(Number(el.dataset.index));
  if (el.classList.contains("view-note")) return NOTE_PX;
  if (el.classList.contains("tail-row")) return 30;
  if (el.style.height) return parseFloat(el.style.height);
  if (el.classList.contains("rows")) return [...el.children].reduce((n, c) => n + heightOf(c), 0);
  return 0;
}

/** Where `el` starts in its scroller's content: every box before it, stacked. */
function yIn(scroller: Element, el: Element): number {
  let y = 0;
  for (let node: Element | null = el; node && node !== scroller; node = node.parentElement) {
    for (let s = node.previousElementSibling; s; s = s.previousElementSibling) y += heightOf(s);
  }
  return y;
}

const saved: [object, string, PropertyDescriptor][] = [];
function stub(target: object, key: string, desc: PropertyDescriptor): void {
  saved.push([target, key, Object.getOwnPropertyDescriptor(target, key)!]);
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
      // A scroller stops at its end, as a browser's does.
      const max = this.classList.contains("scroller")
        ? Math.max(0, [...this.children].reduce((n, c) => n + heightOf(c), 0) + FOOT_PX - VIEW_PX)
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

/** Months, newest first — three years, one of them small, sizes uneven; 25 months collapse the rail to years. */
type Spec = readonly [year: number, month: number, count: number][];
const WINDOWED: Spec = [
  [2026, 9, 60], [2026, 8, 45], [2026, 7, 70], [2026, 6, 30], [2026, 5, 55], [2026, 4, 25], [2026, 3, 40],
  [2026, 2, 35], [2026, 1, 50],
  [2025, 12, 20], [2025, 11, 35], [2025, 10, 15], [2025, 9, 28], [2025, 8, 9], [2025, 7, 22], [2025, 6, 31],
  [2025, 5, 12], [2025, 4, 18], [2025, 3, 26], [2025, 2, 7], [2025, 1, 17],
  [2024, 12, 11], [2024, 10, 3], [2024, 7, 4], [2024, 3, 15],
];
/** The same years under the window's whole-list bound: every row is mounted and measured. */
const WHOLE: Spec = WINDOWED.map(([y, mo, n], i) =>
  [y, mo, i === WINDOWED.length - 1 ? n : Math.max(2, Math.round(n / 3))] as const);

function rowsOf(spec: Spec): { rows: EngineMessage[]; starts: Map<string, number> } {
  const rows: EngineMessage[] = [];
  const starts = new Map<string, number>();
  for (const [y, mo, n] of spec) {
    starts.set(`${y}-${String(mo).padStart(2, "0")}`, rows.length);
    const top = Date.UTC(y, mo - 1, 28, 12);
    for (let k = 0; k < n; k++) rows.push(storeMessage(rows.length, new Date(top - k * 3_600_000).toISOString()));
  }
  return { rows, starts };
}

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthsOf = (spec: Spec, year: number): string[] => spec.filter(([y]) => y === year).map(([, mo]) => MONTH[mo - 1]!);

const tags: TagDTO[] = [];
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let roots: Root[] = [];

async function settle(rounds = 1): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

async function mount(engine: OhmailEngine): Promise<{ host: HTMLElement; scroller: HTMLElement }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} now={FIXTURE_NOW} timeZone="UTC">
        <HistoryView
          engine={engine} version={0} settled owed={false} tags={tags} now={FIXTURE_NOW}
          onOpen={() => {}} hydrateBody={() => {}} onAction={() => {}} onAddTag={() => {}} onScreen={() => {}}
          canDelete={() => true} canReplyAll={() => true}
        />
      </NextIntlClientProvider>,
    );
  });
  return { host, scroller: host.querySelector(".scroller") as HTMLElement };
}

const rail = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>(".history-rail-item")];
const openMonths = (host: HTMLElement) => rail(host).filter((b) => !b.classList.contains("year")).map((b) => b.textContent);
const current = (host: HTMLElement) => rail(host).find((b) => b.getAttribute("aria-current") === "true")?.textContent ?? null;

/** The slot whose box holds the scroller's top edge, and where that box starts against it. */
function topRow(host: HTMLElement): { slot: number; at: number; real: boolean } | null {
  for (const n of host.querySelectorAll<HTMLElement>(".rows > [data-index]")) {
    const r = n.getBoundingClientRect();
    if (r.bottom > 0.5) return { slot: Number(n.dataset.index), at: Math.round(r.top) + 0, real: n.dataset.id !== undefined };
  }
  return null;
}

async function press(host: HTMLElement, label: string, year?: boolean): Promise<void> {
  const hits = rail(host).filter((b) => b.textContent === label && b.classList.contains("year") === Boolean(year));
  expect(hits.length, `one rail entry named ${label}`).toBe(1);
  await act(async () => { hits[0]!.click(); await Promise.resolve(); });
}

/** Let the pages land and the placement settle on `slot` (or give up and let the assertions say why). */
async function landOn(host: HTMLElement, slot: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const t = topRow(host);
    if (t && t.slot === slot && t.real && Math.abs(t.at) < 1) {
      await settle(2);
      return;
    }
    await settle(1);
  }
}

describe("a rail press lands on the period pressed and opens that year", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true, writable: true,
      value: (query: string) => ({
        matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false,
      }),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    rowPx = UNEVEN;
    installLayout();
  });

  afterEach(async () => {
    for (const r of roots) await act(() => r.unmount());
    roots = [];
    document.body.innerHTML = "";
    for (const [target, key, desc] of saved.splice(0).reverse()) Object.defineProperty(target, key, desc);
    vi.restoreAllMocks();
  });

  for (const [shape, spec] of [["windowed", WINDOWED], ["whole", WHOLE]] as const) {
    it(`${shape}: each year, and each of one year's months, puts its first row at the top and opens its year`, async () => {
      const { rows, starts } = rowsOf(spec);
      expect(rows.length > 500, "the shape under test").toBe(shape === "windowed");
      const fx = await storeFixture(rows);
      const { host } = await mount(fx.engine);
      await settle(4);
      expect(rail(host).filter((b) => b.classList.contains("year")).map((b) => b.textContent)).toEqual(["2026", "2025", "2024"]);
      expect(openMonths(host)).toEqual(monthsOf(spec, 2026));

      for (const year of [2025, 2024, 2026, 2024]) {
        const first = spec.find(([y]) => y === year)!;
        const slot = starts.get(`${year}-${String(first[1]).padStart(2, "0")}`)!;
        await press(host, String(year), true);
        await landOn(host, slot);
        expect(topRow(host), `press ${year}: its first row is the top row`).toEqual({ slot, at: 0, real: true });
        expect(openMonths(host), `press ${year}: its months are open`).toEqual(monthsOf(spec, year));
        expect(current(host)).toBe(MONTH[first[1] - 1]);
      }

      await press(host, "2025", true);
      for (const [y, mo] of spec.filter(([y]) => y === 2025)) {
        const slot = starts.get(`${y}-${String(mo).padStart(2, "0")}`)!;
        await press(host, MONTH[mo - 1]!);
        await landOn(host, slot);
        expect(topRow(host), `press ${MONTH[mo - 1]} ${y}: its first row is the top row`).toEqual({ slot, at: 0, real: true });
        expect(openMonths(host)).toEqual(monthsOf(spec, 2025));
        expect(current(host)).toBe(MONTH[mo - 1]);
      }

      // The oldest year, then its oldest month: one press each.
      await press(host, "2024", true);
      await press(host, "Mar");
      await landOn(host, starts.get("2024-03")!);
      expect(topRow(host)).toEqual({ slot: starts.get("2024-03")!, at: 0, real: true });
      expect(current(host)).toBe("Mar");
    }, 30_000);
  }

  it("a month chosen by keyboard takes the cursor and the focus to its first row, and j walks on from there", async () => {
    const { rows, starts } = rowsOf(WINDOWED);
    const fx = await storeFixture(rows);
    const { host } = await mount(fx.engine);
    await settle(4);
    await press(host, "2025", true);
    const slot = starts.get("2025-10")!;
    const oct = rail(host).find((b) => b.textContent === "Oct" && !b.classList.contains("year"))!;
    // ↵ on a focused button is its click.
    await act(async () => { oct.focus(); oct.click(); await Promise.resolve(); });
    await landOn(host, slot);
    for (let i = 0; i < 40 && host.querySelector<HTMLElement>(".rows > .row.sel")?.dataset.index !== String(slot); i++) await settle(1);
    const sel = host.querySelector<HTMLElement>(".rows > .row.sel");
    expect(sel?.dataset.index, "the month's first row holds the cursor").toBe(String(slot));
    expect(document.activeElement, "and the focus").toBe(sel);
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true }));
    });
    await settle(2);
    expect(host.querySelector<HTMLElement>(".rows > .row.sel")?.dataset.index, "j walks the month").toBe(String(slot + 1));
    expect((document.activeElement as HTMLElement).dataset.index).toBe(String(slot + 1));
  });

  it("a month pressed before the list has drawn the jump still lands, though the rows above it were priced again", async () => {
    const { rows, starts } = rowsOf(WINDOWED);
    const fx = await storeFixture(rows);
    const { host } = await mount(fx.engine);
    await settle(4);
    // A busy page: no frame runs from the presses until the pages land. The window still draws
    // slot 0 when page one leaves the cache; its ghosts are measured, and every unmeasured row
    // above the month is priced again before the month is drawn.
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => frames.push(cb));
    await press(host, "2025", true);
    const slot = starts.get("2025-10")!;
    const oct = rail(host).find((b) => b.textContent === "Oct" && !b.classList.contains("year"))!;
    await act(async () => { oct.focus(); oct.click(); await Promise.resolve(); });
    await settle(4);
    raf.mockRestore();
    await act(async () => { for (const cb of frames.splice(0)) cb(performance.now()); });
    await landOn(host, slot);
    expect(topRow(host), "the month's first row is the top row").toEqual({ slot, at: 0, real: true });
    for (let i = 0; i < 10 && (document.activeElement as HTMLElement).dataset.index !== String(slot); i++) await settle(1);
    expect(host.querySelector<HTMLElement>(".rows > .row.sel")?.dataset.index, "and the cursor").toBe(String(slot));
    expect((document.activeElement as HTMLElement).dataset.index, "and the focus").toBe(String(slot));
  });

  it("the keyboard cursor stays on screen under the note: ↓ scrolls before its row passes the bottom edge", async () => {
    rowPx = () => 80;
    const { rows } = rowsOf(WINDOWED);
    const fx = await storeFixture(rows);
    const { host, scroller } = await mount(fx.engine);
    await settle(4);
    for (let step = 1; step <= 24; step++) {
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
        scroller.dispatchEvent(new Event("scroll")); // a browser fires it for the move; jsdom does not
        await new Promise((r) => setTimeout(r, 20));
      });
      await settle(1);
      const sel = host.querySelector<HTMLElement>(".rows > .row.sel");
      expect(sel?.dataset.index, `step ${step}: the cursor moved`).toBe(String(step));
      const r = sel!.getBoundingClientRect();
      expect(r.top >= 0 && r.bottom <= VIEW_PX, `step ${step}: row ${step} is on screen (${r.top}..${r.bottom})`).toBe(true);
    }
  });

  it("after a press the reader's scroll moves the rail by the row under the top edge, not the one under the note", async () => {
    const { rows, starts } = rowsOf(WINDOWED);
    const fx = await storeFixture(rows);
    const { host, scroller } = await mount(fx.engine);
    await settle(4);
    const first = starts.get("2025-12")!;
    await press(host, "2025", true);
    await landOn(host, first);
    for (let i = 0; i < 40 && !host.querySelector(`.row[data-id="${idOf(first - 1)}"]`); i++) await settle(1);
    expect(openMonths(host)).toEqual(monthsOf(WINDOWED, 2025));
    // Up until one pixel of 2026's last row shows at the top edge.
    const above = host.querySelector<HTMLElement>(`.rows > [data-index="${first - 1}"]`)!.getBoundingClientRect();
    await act(async () => {
      scroller.dispatchEvent(new Event("wheel"));
      scroller.scrollTop += above.top + above.height - 1;
      scroller.dispatchEvent(new Event("scroll"));
      await new Promise((r) => setTimeout(r, 40));
    });
    await settle(4);
    expect(topRow(host)!.slot).toBe(first - 1);
    expect(openMonths(host)).toEqual(monthsOf(WINDOWED, 2026));
    expect(current(host)).toBe("Jan");
  });

  it("a year too small to reach the top edge still opens on its press; the reader's scroll then moves the rail", async () => {
    const spec: Spec = [...WINDOWED, [2011, 6, 3]];
    const { rows, starts } = rowsOf(spec);
    const fx = await storeFixture(rows);
    const { host, scroller } = await mount(fx.engine);
    await settle(4);
    await press(host, "2011", true);
    for (let i = 0; i < 40 && !host.querySelector(`.row[data-id="${idOf(starts.get("2011-06")!)}"]`); i++) await settle(1);
    await settle(4);
    // The list stops at its end with 2024's rows on top; the rail stays on the year pressed.
    expect(topRow(host)!.slot).toBeLessThan(starts.get("2011-06")!);
    expect(openMonths(host)).toEqual(["Jun"]);
    expect(current(host)).toBe("Jun");
    // The reader moves the list: the rail follows the top edge again.
    await act(async () => {
      scroller.dispatchEvent(new Event("wheel"));
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event("scroll"));
      await new Promise((r) => setTimeout(r, 40));
    });
    await settle(4);
    expect(topRow(host)!.slot).toBe(0);
    expect(openMonths(host)).toEqual(monthsOf(spec, 2026));
    expect(current(host)).toBe("Sep");
  });
});
