/** @vitest-environment jsdom */
/**
 * THE STREAM'S SCROLL, TWO IMPLEMENTATIONS, ONE BEHAVIOUR. The web shell's `StreamShell` and the places' carried-over
 * `useStreamScroll` (`@ohmail/app-logic/streams`) stand side by side until the old stream leaves. Each sequence below
 * runs against both, over the same laid-out pile, and the two must land the same cards at the same offsets, report
 * the same landings, announce the same cursor, hold the same anchor and leave the same range.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { StreamShell, type StreamHandle, type StreamLeaveState } from "../app/shell/StreamShell";
import { useStreamScroll, type StreamScroll } from "@ohmail/app-logic/streams";

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEW_H = 600;

/** The pile's laid-out heights, by card; every card at the sum of the heights above it. */
let heights: number[] = [];
const topOf = (i: number): number => heights.slice(0, i).reduce((a, b) => a + b, 0);
const total = (): number => topOf(heights.length);

let roots: Root[] = [];

beforeEach(() => {
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return [];
    }
  };
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) =>
    setTimeout(() => cb(performance.now()), 4) as unknown as number,
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>));
});

afterEach(async () => {
  for (const root of roots) await act(() => root.unmount());
  roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const rect = (top: number, height: number): DOMRect =>
  ({ top, bottom: top + height, left: 0, right: 100, width: 100, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

async function frames(ms = 60): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

/** Give a scroller and its cards the pile's geometry; return the scroller and its scroll offset. */
function layOut(el: HTMLElement): { top: () => number; set: (v: number) => void } {
  let scrollTop = 0;
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => VIEW_H });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => total() });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = Math.min(Math.max(0, total() - VIEW_H), Math.max(0, v));
    },
  });
  el.getBoundingClientRect = () => rect(0, VIEW_H);
  const place = (): void => {
    for (const c of el.querySelectorAll<HTMLElement>(".scast[data-sid]")) {
      const i = Number(c.dataset.sid!.slice(1));
      c.getBoundingClientRect = () => rect(topOf(i) - scrollTop, heights[i]!);
    }
  };
  place();
  el.scrollTo = ((opts: ScrollToOptions) => {
    el.scrollTop = opts.top ?? 0;
    el.dispatchEvent(new Event("scroll"));
  }) as typeof el.scrollTo;
  return {
    top: () => scrollTop,
    set: (v: number) => {
      el.scrollTop = v;
      el.dispatchEvent(new Event("scroll"));
    },
  };
}

const cardsOf = (n: number) =>
  Array.from({ length: n }, (_, i) => h("div", { className: "scast", "data-sid": `c${i}`, key: `c${i}` }));

/** What one side does, step by step. */
interface Side {
  el: HTMLElement;
  scrollTo(id: string, onLanded: () => void): void;
  range(): { newestSeenId: string | null; bottomVisibleId: string | null };
  announced: string[];
}

async function mountOld(n: number): Promise<Side> {
  const announced: string[] = [];
  const ref = React.createRef<StreamHandle>();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  let left: StreamLeaveState | null = null;
  const pileIndexOf = (id: string): number => (/^c\d+$/.test(id) && Number(id.slice(1)) < n ? Number(id.slice(1)) : -1);
  await act(async () => {
    root.render(
      h(StreamShell, {
        ref,
        ariaLabel: "stream",
        onCurrentChange: (id: string) => announced.push(id),
        onSeen: () => {},
        onLeave: (s: StreamLeaveState) => {
          left = s;
        },
        pileIndexOf,
        contentKey: 1,
        children: cardsOf(n),
      }),
    );
  });
  const el = container.querySelector<HTMLElement>(".stream")!;
  return {
    el,
    scrollTo: (id, onLanded) => ref.current!.scrollTo(id, onLanded),
    range: () => {
      root.unmount();
      roots = roots.filter((r) => r !== root);
      const s = left as StreamLeaveState | null;
      return { newestSeenId: s?.newestSeenId ?? null, bottomVisibleId: s?.bottomVisibleId ?? null };
    },
    announced,
  };
}

async function mountNew(n: number): Promise<Side> {
  const announced: string[] = [];
  const handle: { current: StreamScroll | null } = { current: null };
  const pileIndexOf = (id: string): number => (/^c\d+$/.test(id) && Number(id.slice(1)) < n ? Number(id.slice(1)) : -1);
  function Harness() {
    const [scroller, setScroller] = React.useState<HTMLDivElement | null>(null);
    handle.current = useStreamScroll({
      scroller,
      card: { base: "scast", attr: "data-sid", pending: "pend" },
      contentKey: 1,
      onCurrentChange: (id) => announced.push(id),
      pileIndexOf,
    });
    return h("div", { className: "stream", ref: setScroller }, cardsOf(n));
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(Harness));
  });
  const el = container.querySelector<HTMLElement>(".stream")!;
  return {
    el,
    scrollTo: (id, onLanded) => handle.current!.scrollTo(id, onLanded),
    range: () => handle.current!.range(),
    announced,
  };
}

/** One sequence over one side: what it lands, where, what it announces, and the range it leaves. */
type Step =
  | { jump: string }
  | { scroll: number }
  | { grow: { card: number; by: number } };

async function run(mount: (n: number) => Promise<Side>, n: number, steps: Step[]) {
  heights = Array.from({ length: n }, () => 200);
  const side = await mount(n);
  const geo = layOut(side.el);
  const trace: Array<{ at: number; landed: number }> = [];
  for (const step of steps) {
    let landed = 0;
    if ("jump" in step) {
      await act(async () => side.scrollTo(step.jump, () => (landed += 1)));
    } else if ("scroll" in step) {
      await act(async () => geo.set(step.scroll));
    } else {
      heights[step.grow.card] = heights[step.grow.card]! + step.grow.by;
      // The DOM edit that a body landing is (what arms the hold).
      await act(async () => {
        side.el.querySelector<HTMLElement>(`.scast[data-sid="c${step.grow.card}"]`)!.setAttribute("data-h", "x");
      });
    }
    await frames(80);
    trace.push({ at: geo.top(), landed });
  }
  return { trace, announced: side.announced, range: side.range() };
}

async function twin(n: number, steps: Step[]) {
  const before = await run(mountOld, n, steps);
  const after = await run(mountNew, n, steps);
  return { before, after };
}

describe("the stream's scroll: the web shell's and the places' agree on one sequence", () => {
  it("a far landing puts the card at the line, reports it once, and starts the run where it rests", async () => {
    const { before, after } = await twin(40, [{ jump: "c25" }, { scroll: 25 * 200 + 300 }]);
    expect(before.trace[0]).toEqual({ at: 25 * 200 - 14, landed: 1 });
    expect(after).toEqual(before);
  });

  it("a near landing is reported at once and flown to the line", async () => {
    const { before, after } = await twin(20, [{ jump: "c2" }]);
    expect(before.trace[0]!.landed).toBe(1);
    expect(after).toEqual(before);
  });

  it("a jump that bottoms out keeps the jumped-to card the cursor, never the pile's last", async () => {
    const { before, after } = await twin(6, [{ jump: "c4" }]);
    expect(before.announced).not.toContain("c5");
    expect(after).toEqual(before);
  });

  it("a hand's scroll moves the cursor along the reading line", async () => {
    const { before, after } = await twin(20, [{ scroll: 400 }, { scroll: 1210 }, { scroll: 300 }, { scroll: 99999 }]);
    // At the end the last card is current, though its top never reaches the line.
    expect(before.announced.at(-1)).toBe("c19");
    expect(after).toEqual(before);
  });

  it("a card above the reader that grows moves the scroll by as much, in the same frames", async () => {
    const { before, after } = await twin(20, [{ jump: "c10" }, { grow: { card: 3, by: 120 } }]);
    expect(before.trace[1]!.at).toBe(before.trace[0]!.at + 120);
    expect(after).toEqual(before);
  });

  it("a move that skips cards ends the run: the leave's range starts on the screen it rests on", async () => {
    const { before, after } = await twin(40, [{ scroll: 200 }, { scroll: 30 * 200 }]);
    expect(before.range.newestSeenId).toBe("c30");
    expect(after).toEqual(before);
  });

  it("scrolled down by steps, the newest card displayed stays the range's top", async () => {
    const { before, after } = await twin(20, [{ scroll: 200 }, { scroll: 500 }, { scroll: 800 }]);
    expect(before.range).toEqual({ newestSeenId: "c1", bottomVisibleId: "c6" });
    expect(after).toEqual(before);
  });
});
