/** @vitest-environment jsdom */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFrame } from "@ohmail/app/frame";
import { message, mountShell, stubDom, unmountAll } from "./_draft-shell.js";

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, left: 0, right: 600, width: 600, height, x: 0, y: top,
    toJSON: () => ({}) };
}

let frames: Map<number, FrameRequestCallback>;
let frameId: number;

beforeEach(() => {
  localStorage.clear();
  stubDom();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
  frames = new Map();
  frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function settle(ms = 200): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 20) {
    const due = [...frames.values()];
    frames.clear();
    act(() => {
      for (const callback of due) callback(performance.now());
      vi.advanceTimersByTime(20);
    });
  }
}

async function arrange(view: "receipts" | "reads", more = 0, { port = 860, at = 3 } = {}) {
  const news = view === "reads";
  const place = news ? "News" : "Receipts";
  const folder = news ? "ohmail/News" : "ohmail/Receipts";
  const date = new Date().toISOString();
  const letters = Array.from({ length: 5 + more }, (_, i) => {
    const id = `RC${String(5 + more - i).padStart(2, "0")}`;
    return message(id, { folder, date, arrivedAt: date, unread: true, subject: `Purchase ${id}` });
  });
  const target = letters[at]!.id;
  function ChooseStreamLetter() {
    const { commands } = useFrame();
    return (
      <button type="button" onClick={() => commands.go({ place: news ? "news" : "receipts", open: target }, { entered: true })}>
        Open stream letter
      </button>
    );
  }
  const { sent } = await mountShell("#/search", letters, [], {
    places: {
      search: { id: "search", body: "search", rail: null, panes: { kind: "wide", Wide: ChooseStreamLetter } },
    },
  });
  const heads = new Map<string, number>();

  function layOut(scroller: HTMLElement) {
    const cards = () => [...scroller.querySelectorAll<HTMLElement>("[data-stream-item]")];
    const id = (card: HTMLElement) => card.dataset.streamItem!;
    const open = (card: HTMLElement) =>
      card.querySelector('button[aria-expanded="true"][aria-controls]') !== null;
    const height = (card: HTMLElement) => (open(card) ? 400 : 180) + (heads.get(id(card)) ?? 0);
    const spacer = (edge: "head" | "tail") =>
      Number.parseFloat(scroller.querySelector<HTMLElement>(`[data-stream-${edge}]`)?.style.height ?? "0") || 0;
    const topOf = (index: number) =>
      cards().slice(0, index).reduce((top, card) => top + height(card) + 20, 100 + spacer("head"));
    const max = () => Math.max(0, topOf(cards().length) + spacer("tail") + 48 - port);
    let scrollTop = 0;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: port },
      scrollHeight: { configurable: true, get: () => max() + port },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (top: number) => { scrollTop = Math.min(max(), Math.max(0, top)); },
      },
    });
    const boxOf = (card: HTMLElement) => rect(topOf(cards().indexOf(card)) - scrollTop, height(card));
    const scroll = (top: number) => {
      scroller.scrollTop = top;
      fireEvent.scroll(scroller);
    };
    scroller.scrollTo = ((options: ScrollToOptions) => scroll(options.top ?? 0)) as typeof scroller.scrollTo;
    const state = () => ({
      open: cards().filter(open).map(id),
      card: scroller.querySelector<HTMLElement>("[data-stream-item][data-open]")?.dataset.streamItem ?? null,
      row: screen.getByRole("region", { name: place })
        .querySelector<HTMLElement>("[data-id][data-open]")?.dataset.id ?? null,
      filed: sent.flatMap((m) => m.kind === "message_delete" ? [m.messageId] : []),
    });
    const measureIn = (by = -85) => {
      for (const card of cards().slice(0, cards().findIndex((card) => id(card) === target))) {
        heads.set(id(card), by);
      }
    };
    const top = (letter: string) => cards().find((card) => id(card) === letter)!.getBoundingClientRect().top;
    const order = () => cards().map(id);
    return { scroller, state, scroll, measureIn, top, order, cards, boxOf };
  }

  const layouts = new WeakMap<HTMLElement, ReturnType<typeof layOut>>();
  let whenLaidOut: ((stream: ReturnType<typeof layOut>) => void) | undefined;
  const layout = (scroller: HTMLElement) => {
    const previous = layouts.get(scroller);
    if (previous) return previous;
    const next = layOut(scroller);
    layouts.set(scroller, next);
    whenLaidOut?.(next);
    return next;
  };
  const nativeRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const scroller = this.closest<HTMLElement>("[data-reading-scroll]");
    if (scroller) {
      const stream = layout(scroller);
      if (this === scroller) return rect(0, port);
      if (this.matches("[data-stream-item]")) return stream.boxOf(this);
    }
    return nativeRect.call(this);
  });

  const streamOf = () => layout(screen.getByRole("region", { name: place + " stream" })
    .querySelector<HTMLElement>("[data-reading-scroll]")!);
  const visit = (hash: string) => act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
  });
  const arrive = async (onLayout?: typeof whenLaidOut) => {
    whenLaidOut = onLayout;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open stream letter" }));
      window.dispatchEvent(new Event("hashchange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(window.location.hash).toBe(`#/${view}/m/${target}`);
    const stream = streamOf();
    const first = Math.max(0, at - 8);
    const end = first === 0 ? stream.order().length : at + 9;
    expect(stream.order()).toEqual(letters.slice(first, end).map((letter) => letter.id));
    expect(stream.order()).toContain(target);
    whenLaidOut = undefined;
    return stream;
  };
  const del = async (stream: ReturnType<typeof layOut>, expected: string) => {
    const before = stream.state();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Delete" });
    expect(screen.getByRole("button", { name: /Undo/ })).toBeTruthy();
    expect(stream.state().filed).toEqual([]);
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect({ ...before, filed: stream.state().filed })
      .toEqual({ open: [expected], card: expected, row: expected, filed: [expected] });
  };
  return { arrive, del, streamOf, target, visit };
}

/** A smooth scroll flies in four frames. The first frame is observable by the test. */
function flights(scroller: HTMLElement, first: () => void) {
  const flight = { asked: 0, flew: false };
  let frame = 0;
  scroller.scrollTo = (({ top = 0, behavior }: ScrollToOptions) => {
    flight.asked++;
    cancelAnimationFrame(frame);
    if (behavior !== "smooth") {
      scroller.scrollTop = top;
      fireEvent.scroll(scroller);
      return;
    }
    const from = scroller.scrollTop;
    let step = 0;
    const fly = () => {
      scroller.scrollTop = from + ((top - from) * ++step) / 4;
      fireEvent.scroll(scroller);
      if (!flight.flew) {
        flight.flew = true;
        first();
      }
      if (step < 4) frame = requestAnimationFrame(fly);
    };
    frame = requestAnimationFrame(fly);
  }) as typeof scroller.scrollTo;
  return flight;
}

describe("a search arrival among letters sharing one Date: Delete files the letter the reader shows", () => {
  for (const view of ["receipts", "reads"] as const) {
    it(`${view}: cards above that measure in during the flight leave the pressed letter at the landing, and Delete files it`, async () => {
      const { arrive, del, target } = await arrange(view, 10);
      let flight: ReturnType<typeof flights> | undefined;
      const stream = await arrive((s) => { flight = flights(s.scroller, s.measureIn); });
      fireEvent.scroll(stream.scroller);
      settle(400);
      expect(flight?.flew, "the flight never flew").toBe(true);
      expect(stream.top(target), "the pressed card's head is at the landing, on screen").toBeCloseTo(14, 0);
      await del(stream, target);
    });
  }

  for (const [view, by] of [["receipts", -85], ["reads", -85], ["receipts", 85], ["reads", 85]] as const) {
    it(`${view}: cards above that measure in ${by}px after a far landing leave the pressed letter at the landing, and Delete files it`, async () => {
      const { arrive, del, target } = await arrange(view, 20, { port: 300, at: 15 });
      const stream = await arrive();
      fireEvent.scroll(stream.scroller);
      settle(400);
      expect(stream.top(target), "control: the far landing put the card at the landing").toBeCloseTo(14, 0);
      act(() => stream.measureIn(by));
      settle(400);
      expect(stream.top(target), "the pressed card's head is at the landing, on screen").toBeCloseTo(14, 0);
      await del(stream, target);
    });
  }

  it("a wheel during the flight is the person's: the landing never pulls the pane back", async () => {
    const { arrive } = await arrange("receipts", 10);
    let asked = 0;
    let flight: ReturnType<typeof flights> | undefined;
    const stream = await arrive((s) => {
      flight = flights(s.scroller, () => {
        fireEvent.wheel(s.scroller, { deltaY: 40 });
        s.measureIn();
        asked = flight!.asked;
      });
    });
    fireEvent.scroll(stream.scroller);
    settle(400);
    expect(flight?.flew).toBe(true);
    expect(flight!.asked - asked, "a scroll asked after the wheel").toBe(0);
  });

  for (const view of ["receipts", "reads"] as const) {
    it(`${view}: back in a kept pile, Delete after the first scroll files the letter on the reading line`, async () => {
      const { arrive, del, streamOf, visit } = await arrange(view);
      const first = await arrive();
      fireEvent.scroll(first.scroller);
      settle();
      first.scroll(288);
      settle(60);
      await visit("#/");
      await visit(`#/${view}`);
      const stream = streamOf();
      stream.scroller.scrollTo = ((options: ScrollToOptions) => {
        stream.scroller.scrollTop = options.top ?? 0;
        setTimeout(() => fireEvent.scroll(stream.scroller), 0);
      }) as typeof stream.scroller.scrollTo;
      fireEvent.scroll(stream.scroller);
      settle(120);
      expect(stream.state().card, "the revisit's cursor follows the top").toBe(stream.order()[0]);
      stream.scroll(230);
      settle(60);
      const line = stream.order()[1]!;
      fireEvent.click(within(stream.cards()[1]!).getByRole("button", { name: "Expand" }));
      settle(50);
      await del(stream, line);
    });
  }
});
