/**
 * A LAYOUT FOR THE READER IN JSDOM — the thread-read guards' shared stub. jsdom lays nothing out,
 * so the rule would see no line anywhere. This gives the reading column (`.read-col`) and the
 * sheet (`.reader`) a viewport, stacks their `[data-conv-id]` panels top to bottom with a gap, and
 * answers each panel's sender line (`.msg-from`, 20px down), body block (`.msg-body`/`.pm-body`,
 * from 80px down, or `bodyAt[id]` under a tall header; its first lines the 72px of three fallback
 * lines) and end marker (`[data-own-end]`) from that stack and the scroller's own `scrollTop`. The sticky bar
 * (`.msg-actions`) sits at the viewport's foot. A panel's height is `heights[id]` or the default.
 * The window is focused (jsdom answers `hasFocus()` false until something takes focus) unless a
 * test sets `focused` false.
 *
 * THE DWELL BY HAND: a message turns read once its top has been on screen for 0.7 s. `passDwell()`
 * completes every dwell under way at once — a test settles the look that starts a dwell, then
 * passes it, instead of sleeping and hoping the look ran in time. On fake timers (the shell
 * harness) it advances them past the dwell; on real ones it runs the rule's clock
 * (`threadReadTime`) a step ahead of the wall clock and runs the looks the dwell's timer owes.
 */
import * as React from "react";
import { vi } from "vitest";
import { THREAD_READ_HOLD_MS } from "@ohmail/client-engine";
import { threadReadTime } from "../../app/shell/reader-seen";

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const SCROLLERS = ".read-col, .reader";
const GAP = 20;

export interface ThreadLayout {
  /** Every panel's height, by id; the rest take `defaultHeight`. */
  heights: Record<string, number>;
  viewport: number;
  /** The bar's top inside the viewport. */
  barTop: number;
  /** The scroller in use (the column, else the sheet). */
  scroller: () => HTMLElement;
  /** Where a panel's top sits in the scroller's content. */
  topOf: (id: string) => number;
  /** A person's scroll: a wheel on the scroller, then the scroll itself. */
  handScroll: (top: number) => Promise<void>;
  /** The app's own scroll: no input before it. */
  setScroll: (top: number) => void;
  /** What `document.hasFocus()` answers. */
  focused: boolean;
  /** Complete every dwell under way now: the rule's clock steps past it and the looks it owes run. */
  passDwell: () => Promise<void>;
  /** Is a dwell under way — a message's top on screen in an entered visit, its read owed? */
  dwelling: () => boolean;
  restore: () => void;
}

export function stubThreadLayout(opts: {
  viewport?: number; defaultHeight?: number; heights?: Record<string, number>;
  /** Where a panel's body starts, by id (default 80px down): a tall header pushes it down. */
  bodyAt?: Record<string, number>;
  /** Is the reading column `display:none` now (a phone width)? Then it lays out nothing. */
  columnHidden?: () => boolean;
} = {}): ThreadLayout {
  const viewport = opts.viewport ?? 800;
  const defaultHeight = opts.defaultHeight ?? 400;
  const heights: Record<string, number> = { ...(opts.heights ?? {}) };
  const bodyAt: Record<string, number> = opts.bodyAt ?? {};
  const barTop = viewport - 60;
  const tops = new WeakMap<Element, number>();
  const proto = HTMLElement.prototype;
  const saved = {
    rect: Element.prototype.getBoundingClientRect,
    clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight"),
    scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight"),
    scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop"),
    scrollIntoView: (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView,
    computed: window.getComputedStyle,
    hasFocus: Object.getOwnPropertyDescriptor(document, "hasFocus"),
  };
  const focus = { on: true };
  Object.defineProperty(document, "hasFocus", { configurable: true, value: () => focus.on });
  const clock = { now: threadReadTime.now, after: threadReadTime.after };
  let skew = 0;
  const owed = new Set<{ at: number; run: () => void }>();
  threadReadTime.now = () => Date.now() + skew;
  threadReadTime.after = (ms, run) => {
    const entry = { at: threadReadTime.now() + ms, run };
    owed.add(entry);
    const t = setTimeout(() => { if (owed.delete(entry)) run(); }, ms);
    return () => { owed.delete(entry); clearTimeout(t); };
  };

  const hiddenCol = (el: Element): boolean => (opts.columnHidden?.() ?? false) && el.matches(".read-col");
  const isScroller = (el: Element): boolean => el.matches(SCROLLERS) && !hiddenCol(el);
  const scrollerOf = (el: Element): HTMLElement | null => el.closest<HTMLElement>(SCROLLERS);
  const panelsIn = (sc: Element): HTMLElement[] => [...sc.querySelectorAll<HTMLElement>("[data-conv-id]")];
  const heightOf = (p: HTMLElement): number => heights[p.dataset.convId!] ?? defaultHeight;
  /** A panel's top in content coordinates. */
  const contentTop = (p: HTMLElement): number => {
    const sc = scrollerOf(p);
    if (!sc) return 0;
    let y = 0;
    for (const q of panelsIn(sc)) {
      if (q === p) return y;
      y += heightOf(q) + GAP;
    }
    return y;
  };
  const contentHeight = (sc: Element): number => panelsIn(sc).reduce((n, p) => n + heightOf(p) + GAP, 0) + 80;
  const box = (top: number, bottom: number): DOMRect =>
    ({ top, bottom, left: 0, right: 600, width: 600, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    if (isScroller(this)) return box(0, viewport);
    const sc = scrollerOf(this);
    if (!sc || hiddenCol(sc)) return box(0, 0);
    const scrolled = tops.get(sc) ?? 0;
    if (this.classList.contains("msg-actions")) return box(barTop, barTop + 48);
    const panel = this.closest<HTMLElement>("[data-conv-id]");
    if (!panel) return box(0, 0);
    const top = contentTop(panel) - scrolled;
    const h = heightOf(panel);
    if (this === panel) return box(top, top + h);
    if (this.classList.contains("msg-from")) return box(top + 20, top + 60);
    if (this.hasAttribute("data-own-end")) return box(top + h - 30, top + h - 30);
    if (this.classList.contains("msg-body") || this.classList.contains("pm-body")) return box(top + (bodyAt[panel.dataset.convId!] ?? 80), top + h - 30);
    return box(0, 0);
  };
  Object.defineProperty(Element.prototype, "clientHeight", {
    configurable: true,
    get(this: Element) { return isScroller(this) ? viewport : 0; },
  });
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get(this: Element) { return isScroller(this) ? contentHeight(this) : 0; },
  });
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) { return tops.get(this) ?? 0; },
    set(this: Element, v: number) {
      const max = isScroller(this) ? Math.max(0, contentHeight(this) - viewport) : 0;
      tops.set(this, Math.max(0, Math.min(max, v)));
    },
  });
  (Element.prototype as unknown as { scrollIntoView: (o?: ScrollIntoViewOptions) => void }).scrollIntoView = function (this: Element) {
    const sc = scrollerOf(this);
    const panel = this.closest<HTMLElement>("[data-conv-id]");
    if (sc && panel) sc.scrollTop = contentTop(panel);
  };
  window.getComputedStyle = ((el: Element, pseudo?: string | null) => {
    const real = saved.computed.call(window, el, pseudo ?? null);
    if (!isScroller(el)) return real;
    return new Proxy(real, { get: (t, k) => (k === "overflowY" ? "auto" : Reflect.get(t, k)) });
  }) as typeof window.getComputedStyle;

  const scroller = (): HTMLElement => {
    const sheet = document.querySelector<HTMLElement>(".reader");
    const col = document.querySelector<HTMLElement>(".read-col");
    return (sheet && panelsIn(sheet).length > 0 ? sheet : col ?? sheet)!;
  };
  void proto;
  return {
    heights,
    viewport,
    barTop,
    scroller,
    topOf: (id) => {
      const p = scroller().querySelector<HTMLElement>(`[data-conv-id="${id}"]`);
      return p ? contentTop(p) : 0;
    },
    handScroll: async (top) => {
      await act(async () => {
        const sc = scroller();
        sc.dispatchEvent(new Event("wheel", { bubbles: true }));
        sc.scrollTop = top;
        sc.dispatchEvent(new Event("scroll"));
      });
    },
    setScroll: (top) => {
      const sc = scroller();
      sc.scrollTop = top;
      sc.dispatchEvent(new Event("scroll"));
    },
    get focused() { return focus.on; },
    set focused(v: boolean) { focus.on = v; },
    dwelling: () => owed.size > 0,
    passDwell: async () => {
      if (vi.isFakeTimers()) {
        await act(async () => { await vi.advanceTimersByTimeAsync(THREAD_READ_HOLD_MS + 20); });
        return;
      }
      await act(async () => {
        skew += THREAD_READ_HOLD_MS + 2;
        const t = threadReadTime.now();
        for (const e of [...owed]) if (e.at <= t && owed.delete(e)) e.run();
        await new Promise((r) => setTimeout(r, 40)); // the look the timer asked for runs in the next frame
      });
    },
    restore: () => {
      threadReadTime.now = clock.now;
      threadReadTime.after = clock.after;
      for (const e of owed) owed.delete(e);
      Element.prototype.getBoundingClientRect = saved.rect;
      for (const k of ["clientHeight", "scrollHeight", "scrollTop"] as const) {
        const d = saved[k];
        if (d) Object.defineProperty(Element.prototype, k, d);
        else delete (Element.prototype as unknown as Record<string, unknown>)[k];
      }
      (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView = saved.scrollIntoView;
      window.getComputedStyle = saved.computed;
      if (saved.hasFocus) Object.defineProperty(document, "hasFocus", saved.hasFocus);
      else delete (document as unknown as Record<string, unknown>).hasFocus;
    },
  };
}
