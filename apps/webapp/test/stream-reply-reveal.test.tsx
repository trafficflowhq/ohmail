/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { issue, mountStreamFrame } from "../../../packages/app/test/streams/registered-world.js";

let pending = new Map<number, FrameRequestCallback>();
let nextHandle = 1;
let clock = 1_000_000;

async function drainFrames(n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    const due = [...pending.values()];
    pending = new Map();
    await act(async () => { for (const cb of due) cb(clock); });
    clock += 16;
  }
}

const rect = (top: number, height: number): DOMRect =>
  ({ top, bottom: top + height, left: 0, right: 100, width: 100, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

beforeEach(() => {
  HTMLElement.prototype.scrollTo ??= () => {};
  pending = new Map();
  nextHandle = 1;
  clock = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  (globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) => {
    const handle = nextHandle++;
    pending.set(handle, cb);
    return handle;
  };
  (globalThis as Record<string, unknown>).cancelAnimationFrame = (handle: number) => { pending.delete(handle); };
});

afterEach(async () => {
  cleanup();
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

describe("a letter answered in place that grows after its reveal", () => {
  let observers: CardResizeObserver[];
  class CardResizeObserver implements ResizeObserver {
    private readonly targets = new Set<Element>();
    constructor(private readonly callback: ResizeObserverCallback) { observers.push(this); }
    observe(target: Element): void { this.targets.add(target); }
    unobserve(target: Element): void { this.targets.delete(target); }
    disconnect(): void { this.targets.clear(); }
    report(changed: Element[]): void {
      const entries: ResizeObserverEntry[] = changed.filter((target) => this.targets.has(target)).map((target) => {
        const contentRect = target.getBoundingClientRect();
        const size = { blockSize: contentRect.height, inlineSize: contentRect.width };
        return { target, contentRect, borderBoxSize: [size], contentBoxSize: [size], devicePixelContentBoxSize: [size] };
      });
      if (entries.length > 0) this.callback(entries, this);
    }
  }
  beforeEach(() => {
    observers = [];
    (globalThis as Record<string, unknown>).ResizeObserver = CardResizeObserver;
  });
  afterEach(() => { delete (globalThis as Record<string, unknown>).ResizeObserver; });

  async function answered() {
    const heights = [2000, 300, 300, 300, 1800];
    const letters = heights.map((_, i) => issue(`c${i + 1}`, 20 - i));
    mountStreamFrame({ at: "#/reads/m/c2", withReply: true, letters });
    onTestFinished(cleanup);
    const reading = screen.getByRole("region", { name: "News stream" });
    const el = reading.matches("[data-reading-scroll]") ? reading
      : reading.querySelector<HTMLElement>("[data-reading-scroll]")!;
    const cards = [...el.querySelectorAll<HTMLElement>("[data-stream-item]")];
    expect(cards).toHaveLength(heights.length);
    const above = (i: number) => heights.slice(0, i).reduce((sum, h) => sum + h, 0);
    el.scrollTop = 2000;
    el.getBoundingClientRect = () => rect(0, 600);
    Object.defineProperty(el, "clientHeight", { value: 600 });
    Object.defineProperty(el, "scrollHeight", { get: () => above(heights.length) });
    const scrollTos: number[] = [];
    el.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
      const top = (typeof options === "number" ? y : options?.top) ?? el.scrollTop;
      scrollTos.push(top);
      el.scrollTop = top;
    };
    cards.forEach((card, i) => {
      const measure = () => rect(above(i) - el.scrollTop, heights[i]!);
      card.getBoundingClientRect = measure;
      card.parentElement!.getBoundingClientRect = measure;
    });
    await drainFrames(12);
    await act(async () => {
      el.scrollTop = 2000;
      fireEvent.scroll(el);
    });
    await drainFrames(2);
    const top = (id: string) => cards.find((card) => card.dataset.streamItem === id)!.getBoundingClientRect().top;
    expect(top("c2")).toBe(0);
    const actions = await screen.findByRole("toolbar", { name: "Actions" });
    await act(async () => {
      heights[1] = 900;
      fireEvent.click(within(actions).getByRole("button", { name: "Reply" }));
    });
    await drainFrames(4);
    const dock = within(el).getByRole("textbox", { name: "Reply body" });
    expect(top("c3"), "the reveal put the end at the foot").toBe(600);
    const grow = async (height: number) => {
      heights[1] = height;
      await act(async () => {
        const changed = [cards[1]!, cards[1]!.parentElement!];
        for (const observer of observers) observer.report(changed);
      });
      await drainFrames(4);
    };
    const scroll = async (position: number) => {
      await act(async () => {
        fireEvent.wheel(el, { deltaY: position - el.scrollTop });
        el.scrollTop = position;
        fireEvent.scroll(el);
      });
      await drainFrames(2);
    };
    const close = async () => {
      await act(async () => { fireEvent.keyDown(dock, { key: "Escape" }); });
      await drainFrames(4);
      expect(within(el).queryByRole("textbox", { name: "Reply body" })).toBeNull();
    };
    return { top, scrollTos, grow, scroll, close };
  }

  it("follows the growth, so the end meets the port's foot and nothing hides behind the dock", async () => {
    const s = await answered();
    expect(s.top("c3"), "the reveal put the end at the foot").toBe(600);
    await s.grow(1100);
    expect(s.top("c3"), "after the frame grew by 200").toBe(600);
    await s.grow(1250);
    expect(s.top("c3"), "and again").toBe(600);
    expect(s.scrollTos.at(-1)).toBe(2650);
  });

  it("never moves a letter the person scrolled away from", async () => {
    const s = await answered();
    await s.scroll(2100);
    const writes = s.scrollTos.length;
    await s.grow(1100);
    expect(s.scrollTos.length, "no scroll of the stream's").toBe(writes);
    expect(s.top("c2")).toBe(-100);
  });

  it("stops once the dock has closed", async () => {
    const s = await answered();
    await s.close();
    const writes = s.scrollTos.length;
    await s.grow(1100);
    expect(s.scrollTos.length).toBe(writes);
  });
});
