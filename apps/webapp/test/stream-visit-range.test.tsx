/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issue, mountStreamFrame, receipt } from "../../../packages/app/test/streams/registered-world.js";

const CARD = 200;
const VIEW = 600;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  Element.prototype.scrollIntoView ??= () => undefined;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function visit(
  place: "News" | "Receipts",
  alreadyRead: readonly number[] = [],
  gesture: "wheel" | "page key" | "outside press" = "wheel",
  restoreUnread?: number,
) {
  const frames = new Map<number, FrameRequestCallback>();
  let serial = 0;
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
    frames.set(++serial, run);
    return serial;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const frame = () => {
    const due = [...frames.values()];
    frames.clear();
    act(() => { for (const run of due) run(performance.now()); });
  };
  const view = place === "News" ? "reads" : "receipts";
  const make = place === "News" ? issue : receipt;
  const letters = Array.from({ length: 10 }, (_, i) => make(`r${i}`, 20 - i, { unread: !alreadyRead.includes(i) }));
  const { mail } = mountStreamFrame({ at: `#/${view}`, letters });
  const stream = screen.getByRole("region", { name: `${place} stream` });
  const scroller = stream.querySelector<HTMLElement>(".oh-sheet-scroll")!;
  Object.defineProperties(scroller, {
    clientHeight: { get: () => VIEW },
    scrollHeight: { get: () => letters.length * CARD },
  });
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, VIEW, VIEW);
  scroller.scrollTo = ((options: ScrollToOptions) => {
    scroller.scrollTop = options.top ?? 0;
    fireEvent.scroll(scroller);
  }) as typeof scroller.scrollTo;
  const rect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const card = this.closest<HTMLElement>("[data-stream-item]");
    if (!card || !scroller.contains(card)) return rect.call(this);
    const top = Number(card.dataset.streamItem!.slice(1)) * CARD - scroller.scrollTop;
    if (this === card) return new DOMRect(0, top, VIEW, CARD);
    if (this.matches("[data-sender-line]")) return new DOMRect(0, top + 16, VIEW, 20);
    if (this.matches(".oh-message-clip, .oh-message-body, [data-read-body]")) return new DOMRect(0, top + 70, VIEW, 100);
    return rect.call(this);
  });
  fireEvent.scroll(scroller);
  frame();
  if (restoreUnread !== undefined) act(() => mail.patch(`r${restoreUnread}`, { unread: true }));
  if (gesture === "wheel") {
    fireEvent.wheel(scroller, { deltaY: 400 });
  } else {
    fireEvent.pointerDown(scroller);
    if (gesture === "outside press") {
      fireEvent.pointerDown(screen.getByRole("navigation", { name: "Places" }));
    }
    fireEvent.keyDown(document.body, { key: "PageDown" });
  }
  for (const offset of [100, 200, 300, 400]) {
    scroller.scrollTop = offset;
    fireEvent.scroll(scroller);
    act(() => { vi.advanceTimersByTime(20); });
    frame();
  }
  act(() => { vi.advanceTimersByTime(40); });
  frame();
  act(() => { vi.advanceTimersByTime(800); });
  frame();
  const rail = within(screen.getByRole("navigation", { name: "Places" }));
  fireEvent.click(rail.getByRole("button", { name: /^Ohbox/ }));
  return mail.mutations.filter((mutation) => mutation.kind === "feed_mark_seen" && mutation.upToId);
}

describe("leaving commits the waterline — once, anchored, bounded", () => {
  it("BOUNDED by what was displayed — never the pile", () => {
    expect(visit("News")).toEqual([
      { kind: "feed_mark_seen", view: "reads", upToId: "r0", messageIds: ["r0", "r1", "r2", "r3", "r4"] },
    ]);
  });

  it("only UNREAD ids ride the commit — the anchor still stands for the range", () => {
    expect(visit("News", [1, 3])).toEqual([
      { kind: "feed_mark_seen", view: "reads", upToId: "r0", messageIds: ["r0", "r2", "r4"] },
    ]);
  });

  it("Receipts commits through ITS OWN seam, same shape", () => {
    expect(visit("Receipts")).toEqual([
      { kind: "feed_mark_seen", view: "receipts", upToId: "r0", messageIds: ["r0", "r1", "r2", "r3", "r4"] },
    ]);
  });
});


it("PageDown with nothing focused after a stream press reads the displayed range", () => {
  expect(visit("News", [], "page key")).toEqual([
    { kind: "feed_mark_seen", view: "reads", upToId: "r0", messageIds: ["r0", "r1", "r2", "r3", "r4"] },
  ]);
});

it("a press outside the stream withdraws its claim to a free PageDown", () => {
  expect(visit("News", [], "outside press")).toEqual([]);
});

it("keeps a letter made unread before the wheel out of the leave", () => {
  expect(visit("News", [2], "wheel", 2)).toEqual([
    { kind: "feed_mark_seen", view: "reads", upToId: "r0", messageIds: ["r0", "r1", "r3", "r4"] },
  ]);
});
