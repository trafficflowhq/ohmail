/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issue, mountStreamFrame } from "../../../packages/app/test/streams/registered-world.js";

const CARD = 200;
const VIEW = 600;
const COUNT = 40;
const END = COUNT * CARD - VIEW;
const box = (top: number, height: number) => new DOMRect(0, top, VIEW, height);

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  Element.prototype.scrollIntoView ??= () => undefined;
  HTMLElement.prototype.scrollTo ??= () => undefined;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function visit() {
  let frames = new Map<number, FrameRequestCallback>();
  let serial = 0;
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
    frames.set(++serial, run);
    return serial;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));

  const letters = Array.from({ length: COUNT }, (_, i) => issue(`r${i}`, COUNT - i));
  const { mail } = mountStreamFrame({ at: "#/reads", letters });
  const stream = screen.getByRole("region", { name: "News stream" });
  const scroller = stream.querySelector<HTMLElement>(".oh-sheet-scroll")!;
  const rect = HTMLElement.prototype.getBoundingClientRect;

  // Measuring the landing can mount a new window of cards during the same frame.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === scroller) return box(0, VIEW);
    const card = this.closest<HTMLElement>("[data-stream-item]");
    if (card && scroller.contains(card)) {
      const top = Number(card.dataset.streamItem!.slice(1)) * CARD - scroller.scrollTop;
      if (this === card) return box(top, CARD);
      if (this.matches("[data-sender-line]")) return box(top + 16, 20);
      if (this.matches(".oh-message-clip, .oh-message-body, [data-read-body]")) return box(top + 70, CARD - 100);
    }
    return rect.call(this);
  });

  Object.defineProperties(scroller, {
    clientHeight: { get: () => VIEW },
    scrollHeight: { get: () => COUNT * CARD },
    scrollTo: { value: (options: ScrollToOptions) => scroll(options.top ?? 0) },
  });

  function scroll(top: number) {
    scroller.scrollTop = Math.max(0, Math.min(top, END));
    fireEvent.scroll(scroller);
  }

  function frame(ms = 20) {
    const due = frames;
    frames = new Map();
    act(() => {
      vi.advanceTimersByTime(ms);
      for (const run of due.values()) run(performance.now());
    });
  }

  const rest = (count = 40) => {
    for (let i = 0; i < count; i += 1) frame();
  };
  const move = (...offsets: number[]) => {
    for (const top of offsets) {
      scroll(top);
      frame(16);
    }
  };
  const wheel = (top: number) => {
    fireEvent.wheel(scroller, { deltaY: top - scroller.scrollTop });
    move(top);
  };
  const leave = () => {
    const rail = within(screen.getByRole("navigation", { name: "Places" }));
    fireEvent.click(rail.getByRole("button", { name: /^Ohbox/ }));
    return mail.mutations.filter((mutation) => mutation.kind === "feed_mark_seen" && mutation.upToId);
  };
  move(0);
  return { rest, move, wheel, leave };
}

describe("a far jump ends the tracked run: nothing the visit never displayed is marked", () => {
  it("a drag back up past unseen cards starts the run where it rests", () => {
    const visitAt = visit();
    visitAt.wheel(100);
    visitAt.move(6000);
    visitAt.wheel(6100);
    visitAt.move(1200);
    visitAt.rest();
    expect(visitAt.leave()).toEqual([
      { kind: "feed_mark_seen", view: "reads", upToId: "r6", messageIds: ["r6", "r7", "r8"] },
    ]);
  });
});
