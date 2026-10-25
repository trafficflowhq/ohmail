/** @vitest-environment jsdom */
/**
 * useSeenOnScroll: marks [data-unseen] elements via IntersectionObserver
 * once fully risen past the trigger line — and NEVER before the user has
 * actually driven the scroller.
 *
 * The second clause used to be tested with `fireEvent.scroll`, which is
 * what the implementation listened for and what a programmatic
 * `scrollIntoView` also fires. That made the guard's own claim untestable
 * by construction: a passing suite and a view that marked eleven messages
 * read on a jump nobody scrolled. The discriminator is INPUT,
 * so the tests below assert both directions of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { useSeenOnScroll, type SeenObserver } from "@ohmail/ui";

type IOCallback = (entries: Partial<IntersectionObserverEntry>[]) => void;

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  callback: IOCallback;
  options: IntersectionObserverInit | undefined;
  observed: Element[] = [];
  constructor(cb: IOCallback, options?: IntersectionObserverInit) {
    this.callback = cb;
    this.options = options;
    MockIntersectionObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve(el: Element) {
    this.observed = this.observed.filter((o) => o !== el);
  }
  disconnect() {
    this.observed = [];
  }
}

beforeEach(() => {
  MockIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness({ onSeen, onObserver }: { onSeen: (id: string) => void; onObserver?: (o: SeenObserver) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const observer = useSeenOnScroll({ root, onSeen });
  onObserver?.(observer);
  return (
    <div data-testid="scroller" ref={root}>
      <button data-id="f1" data-unseen="1">one</button>
      <button data-id="f2" data-unseen="1">two</button>
      <button data-id="f3">seen already</button>
    </div>
  );
}

function entryFor(el: Element, bottom: number, rootBottom = 400, isIntersecting = true) {
  return {
    target: el,
    isIntersecting,
    boundingClientRect: { bottom } as DOMRectReadOnly,
    rootBounds: { bottom: rootBottom } as DOMRectReadOnly,
  };
}

describe("useSeenOnScroll", () => {
  it("observes only [data-unseen] elements with the prototype's geometry", () => {
    render(<Harness onSeen={() => {}} />);
    const io = MockIntersectionObserver.instances.at(-1)!;
    expect(io.observed.map((el) => el.getAttribute("data-id"))).toEqual(["f1", "f2"]);
    expect(io.options?.rootMargin).toBe("0px 0px -67% 0px");
    // A LADDER of thresholds, not just [0, 0.99]: a tall card in a shrunk root can never reach
    // 0.99, so the intermediate rungs give the observer a crossing to fire on while the card's
    // bottom is still on screen (B.5 — see `useSeenOnScroll`).
    expect(io.options?.threshold).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.99]);
  });

  it("does NOT mark anything before the user touches the scroller", () => {
    const onSeen = vi.fn();
    render(<Harness onSeen={onSeen} />);
    const io = MockIntersectionObserver.instances.at(-1)!;
    // layout settles, intersections fire — but the user has done nothing yet
    io.callback([entryFor(io.observed[0], 100)]);
    expect(onSeen).not.toHaveBeenCalled();
  });

  it("a `scroll` event ON ITS OWN never arms the guard", () => {
    // THE GUARD FOR THAT CHANGE. `scroll` is a consequence, not an intent: `scrollIntoView`,
    // `scrollTo`, an anchor jump and a restored scroll position all fire it, and the two
    // views that wire this hook to a real `\Seen` write issue exactly those calls. Restore
    // `el.addEventListener("scroll", …)` as the arming event and this goes red — which is
    // precisely the state that shipped.
    const onSeen = vi.fn();
    const { getByTestId } = render(<Harness onSeen={onSeen} />);
    const io = MockIntersectionObserver.instances.at(-1)!;

    fireEvent.scroll(getByTestId("scroller"));
    io.callback([entryFor(io.observed[0], 100)]);
    expect(onSeen).not.toHaveBeenCalled();
  });

  it("marks a row seen once fully risen after a WHEEL", () => {
    const onSeen = vi.fn();
    const { getByTestId } = render(<Harness onSeen={onSeen} />);
    const io = MockIntersectionObserver.instances.at(-1)!;

    fireEvent.wheel(getByTestId("scroller"));
    io.callback([entryFor(io.observed[0], 100)]);
    expect(onSeen).toHaveBeenCalledTimes(1);
    expect(onSeen).toHaveBeenCalledWith("f1");
  });

  it("a touch drag arms it too — the mobile scroller is a finger", () => {
    const onSeen = vi.fn();
    const { getByTestId } = render(<Harness onSeen={onSeen} />);
    const io = MockIntersectionObserver.instances.at(-1)!;

    fireEvent.touchMove(getByTestId("scroller"));
    io.callback([entryFor(io.observed[0], 100)]);
    expect(onSeen).toHaveBeenCalledWith("f1");
  });

  it("PageDown arms it; the app's own `j` does not", () => {
    // Both halves matter. Drop the key listener and a keyboard-only user never marks
    // anything; widen it past the keys the BROWSER scrolls with and `j`/`k` — which move a
    // cursor and then call `scrollIntoView` — mark every row a sweep flies past.
    const onSeen = vi.fn();
    const { getByTestId } = render(<Harness onSeen={onSeen} />);
    const io = MockIntersectionObserver.instances.at(-1)!;

    fireEvent.keyDown(getByTestId("scroller"), { key: "j" });
    io.callback([entryFor(io.observed[0], 100)]);
    expect(onSeen).not.toHaveBeenCalled();

    fireEvent.keyDown(getByTestId("scroller"), { key: "PageDown" });
    io.callback([entryFor(io.observed[0], 100)]);
    expect(onSeen).toHaveBeenCalledWith("f1");
  });

  it("input aimed at a row inside the scroller counts — the listener is on the pane", () => {
    // A wheel is delivered to the element under the pointer, which is a row, and reaches
    // the scroller by bubbling. Move the listeners to the document and this still passes
    // while the per-pane isolation it exists for is gone; move them to a child and it goes
    // red.
    const onSeen = vi.fn();
    const { container } = render(<Harness onSeen={onSeen} />);
    const io = MockIntersectionObserver.instances.at(-1)!;

    fireEvent.wheel(container.querySelector('[data-id="f2"]')!);
    io.callback([entryFor(io.observed[0], 100)]);
    expect(onSeen).toHaveBeenCalledWith("f1");
  });

  it("does not mark rows still below the trigger line", () => {
    const onSeen = vi.fn();
    const { getByTestId } = render(<Harness onSeen={onSeen} />);
    const io = MockIntersectionObserver.instances.at(-1)!;

    fireEvent.wheel(getByTestId("scroller"));
    io.callback([entryFor(io.observed[1], 500)]); // bottom below rootBounds.bottom + 2
    expect(onSeen).not.toHaveBeenCalled();
  });

  it("never marks a row this observer did not see in its band (a row mounted above it)", () => {
    const onSeen = vi.fn();
    const { getByTestId } = render(<Harness onSeen={onSeen} />);
    const io = MockIntersectionObserver.instances.at(-1)!;
    fireEvent.wheel(getByTestId("scroller"));
    io.callback([entryFor(io.observed[0], -50, 400, false)]);
    expect(onSeen).not.toHaveBeenCalled();
    io.callback([entryFor(io.observed[0], 100, 400, true)]);
    expect(onSeen).toHaveBeenCalledWith("f1");
  });

  it("restart() forgets what was seen: a row shown before it is not marked after it", () => {
    const onSeen = vi.fn();
    let observer: SeenObserver | null = null;
    const { getByTestId } = render(<Harness onSeen={onSeen} onObserver={(o) => { observer = o; }} />);
    const io = MockIntersectionObserver.instances.at(-1)!;
    io.callback([entryFor(io.observed[0], 100)]); // shown, before any input
    observer!.restart();
    fireEvent.wheel(getByTestId("scroller"));
    io.callback([entryFor(io.observed[0], -50, 400, false)]); // now above the band
    expect(onSeen).not.toHaveBeenCalled();
  });
});
