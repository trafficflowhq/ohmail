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
import { useRef, type RefObject } from "react";
import { LANDING_QUIET_MS, READ_HOLD_MS, useSeenOnScroll, type SeenObserver } from "@ohmail/ui";

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

function Harness({ onSeen, onObserver, onLanded, deaf = false, pendingShift, putBack }: {
  onSeen: (id: string) => void;
  onObserver?: (o: SeenObserver) => void;
  onLanded?: () => void;
  deaf?: boolean;
  pendingShift?: () => number;
  putBack?: (time: number) => boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const observer = useSeenOnScroll({ root, onSeen, onLanded, pendingShift, putBack });
  onObserver?.(observer);
  return (
    <div data-testid="scroller" ref={root}>
      <button data-id="f1" data-unseen="1">one</button>
      <button data-id="f2" data-unseen="1">two</button>
      <button data-id="f3">seen already</button>
      <iframe data-testid="letter" title="letter" ref={deaf ? deafen : undefined} />
    </div>
  );
}

/** The pane's scroll geometry, which jsdom leaves at 0: `top` of a `height`-tall content in a `view`. */
function scrolledTo(el: HTMLElement, top: number, height = 2000, view = 400): void {
  for (const [k, value] of Object.entries({ scrollTop: top, scrollHeight: height, clientHeight: view })) {
    Object.defineProperty(el, k, { configurable: true, value });
  }
}

/** Lay `el` out at `top()` px, `height` tall: jsdom has no layout. */
function lay(el: Element, top: () => number, height = 200): void {
  const rect = () => ({ top: top(), bottom: top() + height, height, left: 0, right: 300, width: 300, x: 0, y: top() });
  Object.defineProperty(el, "getBoundingClientRect", { configurable: true, value: rect });
}

/** A letter as WebKit renders it: sandboxed without scripts, its document runs no listener of the app's. */
function deafen(frame: HTMLIFrameElement | null): void {
  if (!frame) return;
  const doc = document.implementation.createHTMLDocument("letter");
  Object.defineProperty(doc, "addEventListener", { value: () => {} });
  Object.defineProperty(frame, "contentDocument", { configurable: true, get: () => doc });
}

/** A key typed inside the letter: Chromium hands it to the letter's own document, never the app's. */
function typeIn(letter: HTMLElement, key: string, init: KeyboardEventInit = {}): void {
  fireEvent.keyDown((letter as HTMLIFrameElement).contentDocument!.body, { key, ...init });
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

  it("a key typed into an editor inside the scroller, or one already handled, does not arm it", () => {
    // A reply typed in place sits inside the stream: its spaces and caret keys scroll nothing.
    const onSeen = vi.fn();
    const { getByTestId } = render(<Harness onSeen={onSeen} />);
    const io = MockIntersectionObserver.instances.at(-1)!;
    const scroller = getByTestId("scroller");
    const rich = document.createElement("div");
    rich.setAttribute("contenteditable", "true");
    const inner = rich.appendChild(document.createElement("p"));
    for (const tag of ["input", "textarea", "select"]) scroller.appendChild(document.createElement(tag));
    scroller.appendChild(rich);
    for (const t of [inner, ...scroller.querySelectorAll("input, textarea, select")]) {
      for (const key of [" ", "ArrowDown", "End"]) fireEvent.keyDown(t, { key });
    }
    const handled = new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true });
    handled.preventDefault();
    scroller.dispatchEvent(handled);
    io.callback([entryFor(io.observed[0], 100)]);
    expect(onSeen).not.toHaveBeenCalled();
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

  it("End lands: nothing it carries through the band is marked; once it rests the band is", () => {
    vi.useFakeTimers();
    try {
      const onSeen = vi.fn();
      const { getByTestId } = render(<Harness onSeen={onSeen} />);
      const io = MockIntersectionObserver.instances.at(-1)!;
      const [f1, f2] = io.observed;
      fireEvent.keyDown(getByTestId("scroller"), { key: "End" });
      io.callback([entryFor(f1!, 100)]); // carried through the band in mid-flight
      fireEvent.scroll(getByTestId("scroller"));
      vi.advanceTimersByTime(LANDING_QUIET_MS - 1);
      io.callback([entryFor(f1!, -20, 400, false)]);
      expect(onSeen).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      // At rest the targets are observed afresh, and only the band then is marked.
      expect(io.observed.map((el) => el.getAttribute("data-id"))).toEqual(["f1", "f2"]);
      io.callback([entryFor(f2!, 100)]);
      expect(onSeen.mock.calls).toEqual([["f2"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Cmd+ArrowDown lands like End; PageDown still marks at once", () => {
    vi.useFakeTimers();
    try {
      const onSeen = vi.fn();
      const { getByTestId } = render(<Harness onSeen={onSeen} />);
      const io = MockIntersectionObserver.instances.at(-1)!;
      fireEvent.keyDown(getByTestId("scroller"), { key: "ArrowDown", metaKey: true });
      io.callback([entryFor(io.observed[0]!, 100)]);
      expect(onSeen).not.toHaveBeenCalled();
      vi.advanceTimersByTime(LANDING_QUIET_MS);
      fireEvent.keyDown(getByTestId("scroller"), { key: "PageDown" });
      io.callback([entryFor(io.observed[1]!, 100)]);
      expect(onSeen.mock.calls).toEqual([["f2"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a report from a frame the scroller puts back is neither read nor counted as shown, and is asked for again", () => {
    vi.useFakeTimers();
    try {
      const onSeen = vi.fn();
      let shift = 0;
      let backAt = -Infinity;
      const { getByTestId } = render(<Harness onSeen={onSeen} pendingShift={() => shift} putBack={(t) => t < backAt} />);
      const io = MockIntersectionObserver.instances.at(-1)!;
      const f1 = io.observed[0]!;
      fireEvent.wheel(getByTestId("scroller"));
      shift = 40; // content moved under the pane: it scrolls 40px to put the frame back
      io.callback([{ ...entryFor(f1, 100), time: 5 }]);
      shift = 0;
      backAt = 10; // put back at 10; this report was recorded before
      io.callback([{ ...entryFor(f1, 100), time: 8 }]);
      expect(onSeen).not.toHaveBeenCalled();
      vi.advanceTimersByTime(20);
      expect(io.observed.at(-1), "observed afresh, so the next frame reports it").toBe(f1);
      io.callback([{ ...entryFor(f1, -50, 400, false), time: 30 }]);
      expect(onSeen, "never in the band on a frame the reader saw").not.toHaveBeenCalled();
      io.callback([{ ...entryFor(f1, 100), time: 40 }]);
      expect(onSeen.mock.calls).toEqual([["f1"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("End with focus outside the pane still holds the marks of a pane a wheel armed", () => {
    vi.useFakeTimers();
    try {
      const onSeen = vi.fn();
      const { getByTestId } = render(<Harness onSeen={onSeen} />);
      const io = MockIntersectionObserver.instances.at(-1)!;
      fireEvent.wheel(getByTestId("scroller"));
      fireEvent.keyDown(document.body, { key: "End" });
      io.callback([entryFor(io.observed[0]!, 100)]);
      expect(onSeen).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  describe("focus in a letter's frame", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    /** A pane a wheel armed a while ago (or none did), with focus then put in its letter. */
    function inLetter(deaf = false, { wheel = true, pendingShift }: { wheel?: boolean; pendingShift?: () => number } = {}) {
      const onSeen = vi.fn();
      const onLanded = vi.fn();
      const box: { observer?: SeenObserver } = {};
      const { getByTestId } = render(
        <Harness onSeen={onSeen} onObserver={(o) => { box.observer = o; }} onLanded={onLanded} deaf={deaf} pendingShift={pendingShift} />,
      );
      const io = MockIntersectionObserver.instances.at(-1)!;
      const [f1, f2] = io.observed as [Element, Element];
      const scroller = getByTestId("scroller");
      if (wheel) fireEvent.wheel(scroller);
      vi.advanceTimersByTime(400);
      const letter = getByTestId("letter");
      letter.focus();
      return { onSeen, onLanded, observer: box.observer!, io, f1, f2, scroller, letter };
    }
    const scroll = (el: HTMLElement, top: number, height?: number) => {
      scrolledTo(el, top, height);
      fireEvent.scroll(el);
    };

    it("End typed in a letter lands: a correction off the end before it rests marks nothing it carried", () => {
      const { onSeen, io, f1, f2, scroller, letter } = inLetter();
      typeIn(letter, "End");
      scroll(scroller, 400);
      io.callback([entryFor(f1, 100)]); // carried through the band in mid-flight
      scroll(scroller, 1600);
      scroll(scroller, 1572); // the stream's anchoring takes it 28px back up
      vi.advanceTimersByTime(LANDING_QUIET_MS);
      expect(onSeen).not.toHaveBeenCalled();
      io.callback([entryFor(f2, 100)]);
      expect(onSeen.mock.calls).toEqual([["f2"]]);
    });

    it("End typed in a letter lands when the pane shrinks, then grows, before it rests", () => {
      const { onSeen, io, f1, scroller, letter } = inLetter();
      typeIn(letter, "End");
      scroll(scroller, 400, 2000);
      io.callback([entryFor(f1, 100)]);
      scroll(scroller, 1300, 1700); // cards measured shorter than guessed: End stops at 1300
      scrolledTo(scroller, 1300, 2100); // then the last ones render taller
      vi.advanceTimersByTime(LANDING_QUIET_MS);
      expect(onSeen).not.toHaveBeenCalled();
    });

    it("a wheel delivered to the letter's document is a read, even when the pane rests at its end", () => {
      const { onSeen, io, f1, scroller, letter } = inLetter();
      // Chromium hands a wheel over a letter to the letter's own document; the pane only scrolls.
      fireEvent.wheel((letter as HTMLIFrameElement).contentDocument!.body);
      scroll(scroller, 1600);
      io.callback([entryFor(f1, 100)]);
      expect(onSeen.mock.calls).toEqual([["f1"]]);
      vi.advanceTimersByTime(LANDING_QUIET_MS);
      expect(onSeen.mock.calls).toEqual([["f1"]]);
    });

    it("PageDown typed in a letter marks what it passes, onto the last page too; Ctrl+ArrowUp lands", () => {
      const { onSeen, io, f1, f2, scroller, letter } = inLetter();
      typeIn(letter, "PageDown");
      scroll(scroller, 1600);
      io.callback([entryFor(f1, 100)]);
      expect(onSeen.mock.calls).toEqual([["f1"]]);
      typeIn(letter, "ArrowUp", { ctrlKey: true });
      scroll(scroller, 0);
      io.callback([entryFor(f2, 100)]);
      expect(onSeen.mock.calls).toEqual([["f1"]]);
    });

    it("a scroll from a letter whose keys never reach the app (WebKit) is no landing and marks nothing it carries through the band", () => {
      const { onSeen, onLanded, io, f1, f2, scroller } = inLetter(true);
      scroll(scroller, 400);
      io.callback([entryFor(f1, 100)]);
      scroll(scroller, 1572); // End corrected short of the end, or a PageDown: no key says which
      vi.advanceTimersByTime(LANDING_QUIET_MS);
      expect({ seen: onSeen.mock.calls, landed: onLanded.mock.calls.length }).toEqual({ seen: [], landed: 0 });
      io.callback([entryFor(f2, 100)]);
      expect(onSeen.mock.calls).toEqual([["f2"]]);
      // A wheel over the pane just before its scroll is the reader's own hand: marked at once.
      fireEvent.wheel(scroller);
      scroll(scroller, 1500);
      io.callback([entryFor(f1, 100)]);
      expect(onSeen.mock.calls).toEqual([["f2"], ["f1"]]);
    });

    it("such a scroll reads a letter whose first lines stay READ_HOLD_MS on screen, and none it carries past sooner", () => {
      const { onSeen, observer, f1, f2, scroller } = inLetter(true);
      const tops = new Map<Element, number>([[f1, 100], [f2, 500]]);
      lay(scroller, () => 0, 400);
      for (const f of [f1, f2]) lay(f, () => tops.get(f)!);
      scroll(scroller, 10);
      expect(observer.landing(), "judged, not a landing").toBe(false);
      expect(observer.judging()).toBe(true);
      vi.advanceTimersByTime(100);
      tops.set(f1, 50).set(f2, 250); // f2's first lines come on screen
      scroll(scroller, 60);
      vi.advanceTimersByTime(100);
      tops.set(f1, 0).set(f2, -100); // and are carried off 100ms later
      scroll(scroller, 160);
      vi.advanceTimersByTime(READ_HOLD_MS - 201);
      expect(onSeen).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onSeen.mock.calls).toEqual([["f1"]]);
      vi.advanceTimersByTime(READ_HOLD_MS);
      expect({ seen: onSeen.mock.calls, judging: observer.judging() }).toEqual({ seen: [["f1"]], judging: false });
    });

    it("a letter that comes due on a frame the pane is about to put back is judged where the correction will show it", () => {
      let shift = 0;
      const { onSeen, f1, f2, scroller } = inLetter(true, { pendingShift: () => shift });
      const tops = new Map<Element, number>([[f1, 100], [f2, 500]]);
      lay(scroller, () => 0, 400);
      for (const f of [f1, f2]) lay(f, () => tops.get(f)!);
      scroll(scroller, 10);
      vi.advanceTimersByTime(READ_HOLD_MS - 50);
      // A letter above lands: f1's first lines go off the foot until the pane scrolls 300px to put them back.
      tops.set(f1, 400).set(f2, 800);
      shift = 300;
      vi.advanceTimersByTime(50);
      expect(onSeen.mock.calls).toEqual([["f1"]]);
    });

    it("with no wheel before it, such a scroll arms the pane and the read rule judges it", () => {
      const { onSeen, observer, io, f1, f2, scroller } = inLetter(true, { wheel: false });
      lay(scroller, () => 0, 400);
      lay(f1, () => 100);
      lay(f2, () => 500);
      scroll(scroller, 10);
      io.callback([entryFor(f2, 100)]); // carried through the band: held, never read
      vi.advanceTimersByTime(READ_HOLD_MS);
      expect({ driven: observer.userHasDriven(), seen: onSeen.mock.calls }).toEqual({ driven: true, seen: [["f1"]] });
    });

    it("with no wheel before it, a scroll key, a wheel or a touch in a letter the app hears arms the pane", () => {
      for (const input of ["key", "wheel", "touch"] as const) {
        const { onSeen, io, f1, letter } = inLetter(false, { wheel: false });
        const body = (letter as HTMLIFrameElement).contentDocument!.body;
        if (input === "key") fireEvent.keyDown(body, { key: "PageDown" });
        else if (input === "wheel") fireEvent.wheel(body);
        else fireEvent.touchMove(body);
        io.callback([entryFor(f1, 100)]);
        expect(onSeen.mock.calls, input).toEqual([["f1"]]);
        cleanup();
      }
    });

    it("the app's own scroll of a pane nobody drove, focus in a letter it cannot hear, arms nothing", () => {
      const { onSeen, observer, io, f1, scroller } = inLetter(true, { wheel: false });
      observer.own(() => scrolledTo(scroller, 28));
      fireEvent.scroll(scroller);
      io.callback([entryFor(f1, 100)]);
      vi.advanceTimersByTime(READ_HOLD_MS * 2);
      expect({ driven: observer.userHasDriven(), seen: onSeen.mock.calls }).toEqual({ driven: false, seen: [] });
    });

    it("a wheel's scroll stays a read while the pane keeps moving, past 200ms too (WebKit animates it)", () => {
      const { onSeen, io, f1, scroller } = inLetter(true);
      fireEvent.wheel(scroller);
      for (let top = 40; top <= 400; top += 40) {
        vi.advanceTimersByTime(50);
        scroll(scroller, top);
      }
      io.callback([entryFor(f1, 100)]);
      expect(onSeen.mock.calls).toEqual([["f1"]]);
    });

    it("a wheel joining a hold no key started makes it the wheel's own scroll: all of it is read", () => {
      const { onSeen, observer, io, f1, f2, scroller } = inLetter(true);
      scroll(scroller, 300); // WebKit scrolls for the wheel before the page hears it
      io.callback([entryFor(f1, 100)]);
      fireEvent.wheel(scroller);
      expect({ landing: observer.landing(), seen: onSeen.mock.calls }).toEqual({ landing: false, seen: [["f1"]] });
      scroll(scroller, 600);
      io.callback([entryFor(f2, 100)]);
      expect(onSeen.mock.calls).toEqual([["f1"], ["f2"]]);
    });

    it("a wheel does not end a landing a key started", () => {
      const { onSeen, observer, io, f1, scroller, letter } = inLetter();
      typeIn(letter, "End");
      scroll(scroller, 300);
      fireEvent.wheel(scroller);
      scroll(scroller, 1600); // End's animation carries on past the wheel
      io.callback([entryFor(f1, 100)]);
      expect({ landing: observer.landing(), seen: onSeen.mock.calls }).toEqual({ landing: true, seen: [] });
    });

    it("a letter's keys stop counting when the pane's observer goes and the letter stays", () => {
      function Seen({ root }: { root: RefObject<HTMLDivElement | null> }) {
        useSeenOnScroll({ root, onSeen: () => {} });
        return null;
      }
      function Pane({ seen }: { seen: boolean }) {
        const root = useRef<HTMLDivElement>(null);
        return (
          <div ref={root}>
            <button data-id="f1" data-unseen="1">one</button>
            <iframe data-testid="letter" title="letter" />
            {seen ? <Seen root={root} /> : null}
          </div>
        );
      }
      const { getByTestId, rerender } = render(<Pane seen />);
      const io = MockIntersectionObserver.instances.at(-1)!;
      rerender(<Pane seen={false} />);
      typeIn(getByTestId("letter"), "End");
      vi.advanceTimersByTime(LANDING_QUIET_MS);
      // A landing left behind would rest on its gone observer and observe the pane again.
      expect(io.observed).toEqual([]);
    });

    it("the app's own scroll of the pane neither starts a hold nor keeps one from resting", () => {
      const { onSeen, observer, io, f1, scroller } = inLetter(true);
      // The browser fires the scroll event of the app's own correction on the next frame.
      observer.own(() => scrolledTo(scroller, 28));
      fireEvent.scroll(scroller);
      io.callback([entryFor(f1, 100)]);
      expect(onSeen.mock.calls).toEqual([["f1"]]);
      fireEvent.keyDown(scroller, { key: "End" });
      scroll(scroller, 1600);
      vi.advanceTimersByTime(100);
      observer.own(() => scrolledTo(scroller, 1572));
      fireEvent.scroll(scroller);
      vi.advanceTimersByTime(LANDING_QUIET_MS - 100);
      expect(observer.landing()).toBe(false);
    });
  });

  describe("a scroll key with nothing focused", () => {
    function Pane({ id, onSeen }: { id: string; onSeen: (id: string) => void }) {
      const root = useRef<HTMLDivElement>(null);
      useSeenOnScroll({ root, onSeen });
      return (
        <div data-testid={id} ref={root}>
          <p data-testid={`${id}-text`}>prose</p>
          <button data-id={`${id}1`} data-unseen="1">one</button>
        </div>
      );
    }

    it("arms only the pane last pressed; a key the app took, or one aimed at another pane's control, arms none", () => {
      const seen = { a: vi.fn(), b: vi.fn(), c: vi.fn() };
      const { getByTestId } = render(<><Pane id="a" onSeen={seen.a} /><Pane id="b" onSeen={seen.b} /><Pane id="c" onSeen={seen.c} /></>);
      const [, ioB, ioC] = MockIntersectionObserver.instances.slice(-3) as [MockIntersectionObserver, MockIntersectionObserver, MockIntersectionObserver];
      const band = () => {
        ioB.callback([entryFor(ioB.observed[0]!, 100)]);
        ioC.callback([entryFor(ioC.observed[0]!, 100)]);
      };
      fireEvent.pointerDown(getByTestId("b-text"));
      const took = (e: KeyboardEvent) => { if (e.key === "ArrowDown") e.preventDefault(); };
      document.addEventListener("keydown", took);
      try {
        fireEvent.keyDown(document.body, { key: "ArrowDown" }); // the app's own step
        band();
        expect(seen.b).not.toHaveBeenCalled();
        const control = getByTestId("a").querySelector("button")!;
        control.focus();
        fireEvent.keyDown(control, { key: "PageDown" });
        band();
        expect(seen.b).not.toHaveBeenCalled();
        control.blur();
        fireEvent.keyDown(document.body, { key: "PageDown" });
        band();
      } finally {
        document.removeEventListener("keydown", took);
      }
      expect({ b: seen.b.mock.calls, c: seen.c.mock.calls }).toEqual({ b: [["b1"]], c: [] });
    });

    it("a press alone, a bare scroll or the app's own j arms nothing", () => {
      const onSeen = vi.fn();
      const { getByTestId } = render(<Pane id="s" onSeen={onSeen} />);
      const io = MockIntersectionObserver.instances.at(-1)!;
      fireEvent.pointerDown(getByTestId("s-text"));
      scrolledTo(getByTestId("s"), 300);
      fireEvent.scroll(getByTestId("s"));
      fireEvent.keyDown(document.body, { key: "j" });
      io.callback([entryFor(io.observed[0]!, 100)]);
      expect(onSeen).not.toHaveBeenCalled();
    });
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
