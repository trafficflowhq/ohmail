/** @vitest-environment jsdom */
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STREAM_ITEM, useStreamRead, useStreamScroll, type StreamRange, type StreamScroll } from "@ohmail/app-logic/streams";

const h = React.createElement;
const noOrder: readonly string[] = [];
const noWrite = () => {};

function ScrollFixture({ handle, children, order = noOrder, write = noWrite, onLeave, onAttach }: {
  handle: React.RefObject<StreamScroll | null>;
  children?: React.ReactNode;
  order?: readonly string[];
  write?: (ids: readonly string[]) => void;
  onLeave?: (range: StreamRange) => void;
  onAttach?: (scroller: HTMLDivElement) => void;
}) {
  const [scroller, attach] = React.useState<HTMLDivElement | null>(null);
  const read = useStreamRead({ scroller, order, factsOf: () => ({ unread: true, ready: true }), write });
  const scroll = useStreamScroll({
    scroller,
    card: STREAM_ITEM,
    contentKey: children,
    onCurrentChange: () => {},
    seam: { moved: read.moved, landing: read.flying },
  });
  handle.current = scroll;
  React.useLayoutEffect(() => () => onLeave?.(scroll.range()), [onLeave, scroll]);
  const ref = React.useCallback((element: HTMLDivElement | null) => {
    if (element) onAttach?.(element);
    attach(element);
  }, [onAttach]);
  return <div role="region" aria-label="stream" ref={ref}>{children}</div>;
}

let roots: Root[] = [];

/** A rect at `top`, `height` high. */
const rect = (top: number, height: number): DOMRect =>
  ({ top, bottom: top + height, left: 0, right: 600, width: 600, height, x: 0, y: top,
     toJSON: () => ({}) }) as DOMRect;

async function settle(ms = 400): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

describe("a deep landing re-measures until the card is at the reading line", () => {
  afterEach(async () => {
    for (const r of roots) await act(() => r.unmount());
    roots = [];
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("lands on the target card even though every card above it starts at its intrinsic guess", async () => {
    const N = 40;
    const TARGET = 30;
    const VIEWPORT = 600;
    /** The `contain-intrinsic-size` guess a card that has never been rendered reports. */
    const GUESS = 200;
    /** What a card actually measures once the browser has laid it out. */
    const REAL = 300;

    const ref = React.createRef<StreamScroll>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        h(ScrollFixture, {
          handle: ref,
          children: Array.from({ length: N }, (_, i) =>
            h("div", { className: "st-item", "data-stream-item": `c${i}`, key: `c${i}` }),
          ),
        }),
      );
    });

    const el = container.querySelector<HTMLElement>("[aria-label=stream]")!;
    /**
     * `content-visibility: auto` + `contain-intrinsic-size: auto` in one model: a card reports the
     * GUESS until the scroller has been within a viewport of it, and its REAL height for ever
     * after (`auto` remembers). Content offsets are therefore a prefix sum that MOVES as the
     * scroller travels — which is exactly what makes a single pre-computed destination wrong.
     */
    const laidOut = new Set<number>();
    const heightOf = (i: number) => (laidOut.has(i) ? REAL : GUESS);
    const topOf = (i: number) => {
      let t = 0;
      for (let k = 0; k < i; k++) t += heightOf(k);
      return t;
    };
    const total = () => topOf(N);
    let scrollTop = 0;
    const renderAround = () => {
      for (let i = 0; i < N; i++) {
        const top = topOf(i) - scrollTop;
        if (top + heightOf(i) > -VIEWPORT && top < VIEWPORT * 2) laidOut.add(i);
      }
    };
    renderAround();

    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => VIEWPORT });
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => total() });
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = Math.min(Math.max(0, v), Math.max(0, total() - VIEWPORT));
        renderAround();
      },
    });
    el.getBoundingClientRect = () => rect(0, VIEWPORT);
    for (const [i, c] of [...container.querySelectorAll<HTMLElement>(".st-item")].entries()) {
      c.getBoundingClientRect = () => rect(topOf(i) - scrollTop, heightOf(i));
    }
    const scrolls: number[] = [];
    el.scrollTo = ((opts: ScrollToOptions) => {
      scrolls.push(opts.top ?? 0);
      el.scrollTop = opts.top ?? 0;
      el.dispatchEvent(new Event("scroll"));
    }) as typeof el.scrollTo;

    const landed = vi.fn();
    await act(async () => {
      ref.current!.scrollTo(`c${TARGET}`, landed);
    });
    await settle();

    const card = container.querySelector<HTMLElement>(`.st-item[data-stream-item="c${TARGET}"]`)!;
    const offLine = card.getBoundingClientRect().top - el.getBoundingClientRect().top;

    // THE ASSERTION THE REPORT IS ABOUT: the card the jump asked for is AT the reading line, not
    // hundreds of pixels past wherever the guesses said it would be.
    expect(
      offLine,
      `the target parked ${Math.round(offLine)}px from the line; the first aim was ` +
        `${Math.round(scrolls[0] ?? -1)} and the scroller ended at ${scrollTop}`,
    ).toBeLessThanOrEqual(16);
    expect(offLine).toBeGreaterThanOrEqual(-2);
    // It took MORE THAN ONE scroll, which is the mechanism: a single aim computed from the
    // guesses is exactly what missed. Replace the loop with one `scrollTo` and both this and the
    // assertion above go red.
    expect(scrolls.length).toBeGreaterThan(1);
    // …and the landing is reported exactly once, however many corrections it took.
    expect(landed).toHaveBeenCalledTimes(1);
  });

  it("after the reader drove, a far landing that corrects itself marks and tracks nothing it only flew past", async () => {
    const view = 600;
    const ids = Array.from({ length: 40 }, (_, i) => `c${i}`);
    const target = ids[30]!;
    const seen: string[] = [];
    const leaves: StreamRange[] = [];
    const handle = React.createRef<StreamScroll>();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    let scroller: HTMLElement;
    let cards: HTMLElement[];
    const laidOut = new Set<number>();
    const height = (i: number) => laidOut.has(i) ? 300 : 200;
    const top = (i: number) => cards.slice(0, i).reduce((sum, _, index) => sum + height(index), 0);
    let scrollTop = 0;
    const renderAround = () => {
      for (let i = 0; i < cards.length; i++) {
        const relative = top(i) - scrollTop;
        if (relative + height(i) > -view && relative < view * 2) laidOut.add(i);
      }
    };
    const layOut = (element: HTMLElement) => {
      scroller = element;
      cards = [...scroller.querySelectorAll<HTMLElement>("[data-stream-item]")];
      renderAround();
      Object.defineProperties(scroller, {
        clientHeight: { configurable: true, value: view },
        scrollHeight: { configurable: true, get: () => top(cards.length) },
        scrollTop: {
          configurable: true,
          get: () => scrollTop,
          set: (value: number) => {
            scrollTop = Math.min(Math.max(0, value), Math.max(0, top(cards.length) - view));
            renderAround();
          },
        },
      });
      scroller.getBoundingClientRect = () => rect(0, view);
      cards.forEach((card, i) => { card.getBoundingClientRect = () => rect(top(i) - scrollTop, height(i)); });
      scroller.scrollTo = (({ top = 0 }: ScrollToOptions) => {
        scroller.scrollTop = top;
        scroller.dispatchEvent(new Event("scroll"));
      }) as typeof scroller.scrollTo;
    };
    await act(() => root.render(
      <ScrollFixture handle={handle} order={ids} write={(read) => seen.push(...read)}
        onAttach={layOut} onLeave={(range) => leaves.push(range)}>
        {ids.map((id) => <div className="st-item" data-stream-item={id} key={id} />)}
      </ScrollFixture>,
    ));
    const onScreen = () => cards.filter((card) => {
      const box = card.getBoundingClientRect();
      return box.bottom > 0 && box.top < view;
    }).map((card) => card.dataset.streamItem!);
    const wheel = (top: number) => act(() => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: top - scroller.scrollTop }));
      scroller.scrollTo({ top });
    });
    await wheel(320);
    await settle(100);
    expect(seen.length, "the first wheel drove the read rule").toBeGreaterThan(0);
    // Finish the first screen's read before starting the jump. The second wheel
    // can then be judged without counting a read the first screen already earned.
    await wheel(0);
    await settle(100);
    const seenBefore = seen.length;
    const landed = vi.fn();
    await act(() => handle.current!.scrollTo(target, landed));
    await settle();
    expect(landed).toHaveBeenCalledTimes(1);
    const atRest = onScreen();
    await wheel(scrollTop + 60);
    await settle(100);
    const shown = new Set([...atRest, ...onScreen()]);
    await act(() => root.unmount());
    roots.pop();
    expect(atRest, "control: the jump went deep").toContain(target);
    expect(seen.slice(seenBefore).filter((id) => !shown.has(id))).toEqual([]);
    expect(leaves).toHaveLength(1);
    expect(atRest).toContain(leaves[0]!.newestSeenId);
  });

  it("a card pushed off the line AFTER it arrives is followed, not abandoned", async () => {
    /**
     * The landing has to be a resting state, not an instant. A card's own top keeps moving after
     * the scroller stops, because the cards ABOVE it are still swapping their intrinsic guesses for
     * real heights. Measured on the fixture Reads pile: the landing was declared with the card on
     * screen 405px down, and two frames later it had been pushed to 935px — below the fold, loop
     * already finished, nothing left watching.
     *
     * Here that shove is deterministic: the target's top gains 400px on the second frame after the
     * scroller first arrives. Set `ANCHOR_STABLE_FRAMES` to 1 and this ends 414px off the line.
     */
    const ref = React.createRef<StreamScroll>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        h(ScrollFixture, {
          handle: ref,
          children: ["a", "b"].map((s) => h("div", { className: "st-item", "data-stream-item": s, key: s })),
        }),
      );
    });
    const el = container.querySelector<HTMLElement>("[aria-label=stream]")!;
    let scrollTop = 0;
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 10_000 });
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => { scrollTop = Math.min(9400, Math.max(0, v)); },
    });
    el.getBoundingClientRect = () => rect(0, 600);

    let shove = 0;
    let readsAfterFirstScroll = 0;
    const target = container.querySelector<HTMLElement>('.st-item[data-stream-item="b"]')!;
    target.getBoundingClientRect = () => {
      if (scrollTop > 0 && shove === 0 && ++readsAfterFirstScroll >= 2) shove = 400;
      return rect(3000 + shove - scrollTop, 100);
    };
    container.querySelector<HTMLElement>('.st-item[data-stream-item="a"]')!.getBoundingClientRect = () =>
      rect(0 - scrollTop, 100);
    el.scrollTo = ((opts: ScrollToOptions) => { el.scrollTop = opts.top ?? 0; }) as typeof el.scrollTo;

    const landed = vi.fn();
    await act(async () => {
      ref.current!.scrollTo("b", landed);
    });
    await settle();
    const offLine = target.getBoundingClientRect().top - el.getBoundingClientRect().top;
    expect(shove, "the shove never happened — the model, not the product").toBe(400);
    expect(offLine, `the card ended ${Math.round(offLine)}px from the line`).toBeLessThanOrEqual(16);
    expect(landed).toHaveBeenCalledTimes(1);
  });

  it("a card that cannot reach the line stops the loop instead of fighting the scroller", async () => {
    // The last card in a pile: the scroller bottoms out first, so its wanted offset is past the
    // maximum for ever. Without the clamp the loop would re-scroll every frame for its whole
    // budget, and — because each correction re-arms the spy's stand-down — the cursor would be
    // frozen for the duration. `stream-jump-cursor.test.tsx` is the other half of this.
    const ref = React.createRef<StreamScroll>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        h(ScrollFixture, {
          handle: ref,
          children: ["a", "b"].map((s) => h("div", { className: "st-item", "data-stream-item": s, key: s })),
        }),
      );
    });
    const el = container.querySelector<HTMLElement>("[aria-label=stream]")!;
    let scrollTop = 0;
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 3200 });
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => { scrollTop = Math.min(2600, Math.max(0, v)); },
    });
    el.getBoundingClientRect = () => rect(0, 600);
    // `b` sits past the end of the scroller's reach and far enough away that the landing takes the
    // anchored path rather than the one-shot smooth scroll for a card already near the fold.
    const tops: Record<string, number> = { a: 0, b: 3000 };
    for (const c of container.querySelectorAll<HTMLElement>(".st-item")) {
      c.getBoundingClientRect = () => rect(tops[c.dataset.streamItem!]! - scrollTop, 100);
    }
    const scrolls: number[] = [];
    el.scrollTo = ((opts: ScrollToOptions) => {
      scrolls.push(opts.top ?? 0);
      el.scrollTop = opts.top ?? 0;
    }) as typeof el.scrollTo;

    const landed = vi.fn();
    await act(async () => {
      ref.current!.scrollTo("b", landed);
    });
    await settle();
    // Bottomed out, and it says so once rather than churning. The budget is 90 frames, so an
    // unclamped loop would show up here as a scroll count in the tens.
    expect(scrolls.length).toBeLessThanOrEqual(2);
    expect(scrollTop).toBe(2600);
    expect(landed).toHaveBeenCalledTimes(1);
  });
});
