/** @vitest-environment jsdom */
/**
 * THE READ RULE IN THE STREAM (B12-4), over a laid-out stream: jsdom has no layout, so each item stands 300 px tall
 * one under the other and the stream's window is 600 px. The geometry of a real browser is the guarded browser
 * file's.
 */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { letter, mountStream, said, streamInput, type StreamSaid } from "./world.js";

const ITEM = 300;
const VIEW = 600;
const LETTERS = Array.from({ length: 8 }, (_, i) => letter(`n${i}`, { subject: `Issue ${i}`, unread: true }));

function layOut(count = LETTERS.length): HTMLElement {
  const stream = screen.getByRole("region", { name: "News stream" });
  const scroller = stream.querySelector<HTMLElement>(".oh-sheet-scroll")!;
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => VIEW });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => count * ITEM });
  scroller.getBoundingClientRect = () => ({
    top: 0,
    bottom: VIEW,
    left: 0,
    right: 600,
    width: 600,
    height: VIEW,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  const rect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const id = this.dataset.streamItem ?? this.dataset.streamWindowItem;
    if (!id || !scroller.contains(this)) return rect.call(this);
    const i = LETTERS.findIndex((letter) => letter.id === id);
    const top = i * ITEM - scroller.scrollTop;
    return {
      top,
      bottom: top + ITEM,
      left: 0,
      right: 600,
      width: 600,
      height: ITEM,
      x: 0,
      y: top,
      toJSON: () => ({}),
    };
  });
  return scroller;
}

/** The page's frames, run one at a time: the stream's scroll reads its range in the frame after a scroll, as a page does. */
let frames: FrameRequestCallback[] = [];
function nextFrame(): void {
  const due = frames;
  frames = [];
  act(() => {
    for (const cb of due) cb(performance.now());
  });
}

/** The opening screen, as a page's first frame after its layout measures it (jsdom lays out only after the mount). */
function firstFrame(scroller: HTMLElement): void {
  fireEvent.scroll(scroller);
  nextFrame();
}

function scrollTo(scroller: HTMLElement, top: number): void {
  scroller.scrollTop = top;
  fireEvent.scroll(scroller);
}

/** The tab goes away: the document says it is hidden (the prototype's own answer comes back after the case). */
function hideTab(): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
}

let s: StreamSaid;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  s = said();
});
afterEach(() => {
  cleanup();
  delete (document as { visibilityState?: unknown }).visibilityState;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const written = () => s.seen.flat();

describe("News is read by scrolling through it", () => {
  it("reads nothing before a hand moves the stream: not at the opening, not on a scroll no hand made, not at rest", () => {
    mountStream({ place: "news", input: streamInput(LETTERS, s) });
    const scroller = layOut();
    scrollTo(scroller, 700);
    act(() => void vi.advanceTimersByTime(2000));
    expect(written()).toEqual([]);
  });

  it.each([
    ["horizontal wheel", { deltaX: 120, deltaY: 0 }],
    ["upward wheel at the head", { deltaY: -120 }],
  ])("writes nothing after a %s on a stationary overflowing stream", (_gesture, delta) => {
    mountStream({ place: "news", input: streamInput(LETTERS, s) });
    const scroller = layOut();
    firstFrame(scroller);
    fireEvent.wheel(scroller, delta);
    act(() => void vi.advanceTimersByTime(2_000));
    expect(scroller.scrollTop).toBe(0);
    expect(written()).toEqual([]);
  });

  it("an arrival cannot earn the rest after a stationary wheel", () => {
    const { repile } = mountStream({ place: "news", input: streamInput(LETTERS, s) });
    const scroller = layOut(LETTERS.length + 1);
    firstFrame(scroller);
    fireEvent.wheel(scroller, { deltaY: -120 });
    repile([...LETTERS, letter("arrival", { unread: true })]);
    nextFrame();
    act(() => void vi.advanceTimersByTime(2_000));
    expect(scroller.scrollTop).toBe(0);
    expect(written()).toEqual([]);
  });

  it("reads at once what a hand carries past, and the item it rests on after 0.6 s, not before", () => {
    mountStream({ place: "news", input: streamInput(LETTERS, s) });
    const scroller = layOut();
    firstFrame(scroller);
    fireEvent.wheel(scroller, { deltaY: 120 });
    scrollTo(scroller, 400);
    nextFrame();
    expect(written()).toEqual(["n0"]);
    act(() => void vi.advanceTimersByTime(599));
    expect(written()).toEqual(["n0"]);
    act(() => void vi.advanceTimersByTime(1));
    expect(written()).toEqual(["n0", "n1"]);
  });

  it("takes a wheel over the list beside it as no hand on the stream", () => {
    mountStream({ place: "news", input: streamInput(LETTERS, s) });
    const scroller = layOut();
    const list = screen.getByRole("region", { name: "News" });
    fireEvent.wheel(within(list).getByText("Issue 3"), { deltaY: 120 });
    scrollTo(scroller, 400);
    act(() => void vi.advanceTimersByTime(2000));
    expect(written()).toEqual([]);
  });

  it("reads a stream that fits whole on a wheel step, and not on an arrow key", () => {
    mountStream({ place: "news", input: streamInput(LETTERS.slice(0, 2), s) });
    const scroller = layOut(2);
    // The arrow steps the stream: its landing scrolls.
    scroller.scrollTo = ((o: ScrollToOptions) => scrollTo(scroller, o.top ?? 0)) as typeof scroller.scrollTo;
    fireEvent.keyDown(scroller, { key: "ArrowDown" });
    expect(written()).toEqual([]);
    fireEvent.wheel(scroller, { deltaY: 40 });
    expect(written()).toEqual(["n0", "n1"]);
  });

  it("writes nothing more at the rest when the tab turns hidden inside the 0.6 s", () => {
    mountStream({ place: "news", input: streamInput(LETTERS, s) });
    const scroller = layOut();
    firstFrame(scroller);
    fireEvent.wheel(scroller, { deltaY: 120 });
    scrollTo(scroller, 400);
    nextFrame();
    expect(written()).toEqual(["n0"]);
    hideTab();
    act(() => void vi.advanceTimersByTime(2000));
    expect(written()).toEqual(["n0"]);
  });

  it("writes nothing on a wheel step over a stream that fits whole while the tab is hidden", () => {
    mountStream({ place: "news", input: streamInput(LETTERS.slice(0, 2), s) });
    const scroller = layOut(2);
    hideTab();
    fireEvent.wheel(scroller, { deltaY: 40 });
    act(() => void vi.advanceTimersByTime(2000));
    expect(written()).toEqual([]);
  });

  it("holds a letter marked unread: a later scroll and rest leave it unread", () => {
    const { repile, view } = mountStream({ place: "news", input: streamInput(LETTERS, s) });
    const scroller = layOut();
    firstFrame(scroller);
    fireEvent.wheel(scroller, { deltaY: 120 });
    scrollTo(scroller, 400);
    nextFrame();
    expect(written()).toEqual(["n0"]);
    // The engine says n0 is read; then the panel marks it unread again.
    repile(LETTERS.map((m) => (m.id === "n0" ? { ...m, unread: false } : m)));
    repile(LETTERS);
    fireEvent.wheel(scroller, { deltaY: -120 });
    scrollTo(scroller, 0);
    fireEvent.wheel(scroller, { deltaY: 120 });
    scrollTo(scroller, 450);
    act(() => void vi.advanceTimersByTime(2000));
    expect(written().filter((id) => id === "n0")).toEqual(["n0"]);
    // Nor does the leave flip it.
    view.unmount();
    expect(s.leaves).toHaveLength(1);
    expect(s.leaves[0]!.messageIds).not.toContain("n0");
  });

  it("moves the waterline on leaving, once, and only after a hand drove the stream", () => {
    const quiet = mountStream({ place: "news", input: streamInput(LETTERS, s, { fresh: 4 }) });
    layOut();
    quiet.view.unmount();
    expect(s.leaves).toEqual([]);

    const { view } = mountStream({ place: "news", input: streamInput(LETTERS, s, { fresh: 4 }) });
    const scroller = layOut();
    firstFrame(scroller);
    fireEvent.wheel(scroller, { deltaY: 120 });
    scrollTo(scroller, 400);
    nextFrame();
    view.unmount();
    expect(s.leaves).toHaveLength(1);
    expect(s.leaves[0]!.upToId).toBe("n0");
    expect(s.leaves[0]!.messageIds).toEqual(["n0"]);
  });

  it("a link to an item is a preview: the stream lands on it and reads nothing, not at the landing, not at rest", () => {
    /* jsdom scrolls nothing: the landing at the mount stands where the case lays it out. */
    const was = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = function () {} as typeof was;
    onTestFinished(() => {
      HTMLElement.prototype.scrollTo = was;
    });
    mountStream({ place: "news", input: streamInput(LETTERS, s, { fresh: 8 }), open: "n2" });
    const scroller = layOut();
    scroller.scrollTo = ((o: ScrollToOptions) => scrollTo(scroller, o.top ?? 0)) as typeof scroller.scrollTo;
    firstFrame(scroller);
    for (let i = 0; i < 5; i += 1) nextFrame();
    scrollTo(scroller, 2 * ITEM);
    nextFrame();
    act(() => void vi.advanceTimersByTime(2000));
    expect(written()).toEqual([]);
  });

  it("starts the leave's run where a far landing rests: what the landing carried past was never displayed", () => {
    const { view, address } = mountStream({ place: "news", input: streamInput(LETTERS, s, { fresh: 8 }) });
    const scroller = layOut();
    scroller.scrollTo = ((o: ScrollToOptions) => scrollTo(scroller, o.top ?? 0)) as typeof scroller.scrollTo;
    firstFrame(scroller);
    act(() => address.write("#/reads/m/n6", "push"));
    for (let i = 0; i < 5; i += 1) nextFrame();
    expect(scroller.scrollTop).toBe(6 * ITEM - 14);
    fireEvent.wheel(scroller, { deltaY: 40 });
    scrollTo(scroller, 1800);
    nextFrame();
    view.unmount();
    expect(s.leaves).toHaveLength(1);
    expect(s.leaves[0]!.upToId).toBe("n5");
  });

  it("j and k open the next and the previous item and read only what they rest on, after the rest", () => {
    const { address } = mountStream({ place: "news", input: streamInput(LETTERS, s, { fresh: 8 }) });
    const scroller = layOut();
    scroller.scrollTo = ((o: ScrollToOptions) => scrollTo(scroller, o.top ?? 0)) as typeof scroller.scrollTo;
    firstFrame(scroller);
    // From the item under the reading line, the opening's first: j goes to the one after it.
    act(() => void fireEvent.keyDown(window, { key: "j" }));
    expect(address.read()).toBe("#/reads/m/n1");
    nextFrame();
    // What the step carried past is not read: a key is no hand.
    expect(written()).toEqual([]);
    act(() => void vi.advanceTimersByTime(600));
    expect(written()).toEqual(["n1"]);
    act(() => void fireEvent.keyDown(window, { key: "k" }));
    expect(address.read()).toBe("#/reads/m/n0");
    // In a field, j is a letter.
    const field = document.createElement("input");
    document.body.appendChild(field);
    act(() => void fireEvent.keyDown(field, { key: "j" }));
    expect(address.read()).toBe("#/reads/m/n0");
    field.remove();
  });

  it("the arrows step as j and k do: ArrowDown opens the next item and reads only what it rests on, after the rest", () => {
    const { address } = mountStream({ place: "news", input: streamInput(LETTERS, s, { fresh: 8 }) });
    const scroller = layOut();
    scroller.scrollTo = ((o: ScrollToOptions) => scrollTo(scroller, o.top ?? 0)) as typeof scroller.scrollTo;
    firstFrame(scroller);
    act(() => void fireEvent.keyDown(window, { key: "ArrowDown" }));
    expect(address.read()).toBe("#/reads/m/n1");
    nextFrame();
    expect(written()).toEqual([]);
    act(() => void vi.advanceTimersByTime(600));
    expect(written()).toEqual(["n1"]);
    act(() => void fireEvent.keyDown(window, { key: "ArrowUp" }));
    expect(address.read()).toBe("#/reads/m/n0");
    // With Ctrl or Cmd an arrow is a jump to an end, not a step; in a field it is the field's.
    act(() => void fireEvent.keyDown(window, { key: "ArrowDown", ctrlKey: true }));
    expect(address.read()).toBe("#/reads/m/n0");
    const field = document.createElement("input");
    document.body.appendChild(field);
    act(() => void fireEvent.keyDown(field, { key: "ArrowDown" }));
    expect(address.read()).toBe("#/reads/m/n0");
    field.remove();
  });

  it("lands a held arrow's last step: the key's repeat at the stream's end does not cut the landing short", () => {
    const { address } = mountStream({ place: "news", input: streamInput(LETTERS, s, { fresh: 8 }) });
    const scroller = layOut();
    // Room below the last item (the column's foot), so no landing is clamped at the end.
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => LETTERS.length * ITEM + VIEW,
    });
    // A smooth scroll is half way at its first frame; an instant one is there.
    scroller.scrollTo = ((o: ScrollToOptions) => {
      const to = o.top ?? 0;
      scrollTo(scroller, o.behavior === "smooth" ? Math.round((scroller.scrollTop + to) / 2) : to);
    }) as typeof scroller.scrollTo;
    firstFrame(scroller);
    act(() => address.write("#/reads/m/n6", "push"));
    for (let i = 0; i < 8; i += 1) nextFrame();
    expect(scroller.scrollTop).toBe(6 * ITEM - 14);
    // ↓ held on the stream: the step to the last item, then the key's repeat, which has nowhere to go.
    act(() => void fireEvent.keyDown(scroller, { key: "ArrowDown" }));
    expect(address.read()).toBe("#/reads/m/n7");
    act(() => void fireEvent.keyDown(scroller, { key: "ArrowDown", repeat: true }));
    expect(address.read()).toBe("#/reads/m/n7");
    for (let i = 0; i < 8; i += 1) nextFrame();
    expect(scroller.scrollTop).toBe(7 * ITEM - 14);
  });

  it("leaves the address where it was on j or k with Ctrl, Cmd or Alt, on j at the last item and on k at the first", () => {
    const { address } = mountStream({ place: "news", input: streamInput(LETTERS, s, { fresh: 8 }) });
    const scroller = layOut();
    scroller.scrollTo = ((o: ScrollToOptions) => scrollTo(scroller, o.top ?? 0)) as typeof scroller.scrollTo;
    firstFrame(scroller);
    act(() => address.write("#/reads/m/n3", "push"));
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }])
      for (const key of ["j", "k"]) {
        act(() => void fireEvent.keyDown(window, { key, ...mod }));
        expect(address.read()).toBe("#/reads/m/n3");
      }
    act(() => address.write("#/reads/m/n7", "push"));
    act(() => void fireEvent.keyDown(window, { key: "j" }));
    expect(address.read()).toBe("#/reads/m/n7");
    act(() => address.write("#/reads/m/n0", "push"));
    act(() => void fireEvent.keyDown(window, { key: "k" }));
    expect(address.read()).toBe("#/reads/m/n0");
  });

  it("moves the waterline when the tab goes away, through the shell's page-hide", () => {
    let hide: (() => void) | null = null;
    const onPageHide = (leave: () => void) => {
      hide = leave;
      return () => {
        hide = null;
      };
    };
    mountStream({ place: "news", input: streamInput(LETTERS, s, { fresh: 4, onPageHide }) });
    const scroller = layOut();
    firstFrame(scroller);
    fireEvent.wheel(scroller, { deltaY: 120 });
    scrollTo(scroller, 400);
    nextFrame();
    expect(hide).not.toBeNull();
    hide!();
    expect(s.leaves).toEqual([{ upToId: "n0", messageIds: ["n0"] }]);
  });
});
