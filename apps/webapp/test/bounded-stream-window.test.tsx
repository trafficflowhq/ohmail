/** @vitest-environment jsdom */
import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issue, mountStreamFrame, receipt } from "../../../packages/app/test/streams/registered-world.js";
import {
  STREAM_CARD_ESTIMATE_PX,
  STREAM_WINDOW_MAX,
  openingCount,
} from "@ohmail/app-logic/lists/stream-window";

/** The opening window jsdom gets: the window's height stands in for the column (no layout). */
const OPENING = (): number => openingCount(window.innerHeight);

/**
 * THE READING STREAM IS A SLIDING WINDOW, NOT A PILE AND NOT A PREFIX.
 *
 * Two generations of the same defect stand behind these tests. First the stream mounted the
 * whole pile on every switch (a long blocked main thread at a real account's
 * full-size pile). Then it mounted a growing PREFIX, which fixed the switch and made
 * scroll depth a permanent tax instead: measured over a generated pile of tens of thousands of messages in real
 * Chromium, a deep scroll held thousands of cards, tens of thousands of DOM nodes and a large heap in the DOM,
 * with the scroll-spy walking every one of them per frame — and a deep jump mounted everything
 * above its target in one commit.
 *
 * The invariant now: the mounted cards are a CONTIGUOUS window near the viewport, bounded by
 * `STREAM_WINDOW_MAX` wherever the reader is, with spacers reserving the height of everything
 * else. Cards left behind UNMOUNT — the assertion the prefix model could never make.
 *
 * jsdom has no layout, so the sampler's geometry is stubbed per element through the same reads
 * a browser answers (`clientHeight`, `scrollTop`, `getBoundingClientRect`), with every card at
 * the never-measured estimate — nothing about the derivation itself is mocked.
 */

const ISO = "2026-08-04T09:00:00.000Z";
const N = 5000;
type Make = typeof issue;

function letters(make: Make, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.parse(ISO) - i * 1000).toISOString();
    return make(`m${i}`, 1, { date, arrivedAt: date, unread: false });
  });
}

async function visit(make: Make, count: number, jumpTo?: string) {
  const news = make === issue;
  const base = news ? "#/reads" : "#/receipts";
  const at = jumpTo ? `${base}/m/${jumpTo}` : base;
  const seat = mountStreamFrame({ at, letters: letters(make, count) });
  await act(async () => {});
  const host = screen.getByRole("region", { name: news ? "News stream" : "Receipts stream" });
  return { ...seat, host };
}

const cardIndices = (host: HTMLElement): number[] =>
  [...host.querySelectorAll<HTMLElement>("[data-stream-item]")].map((node) =>
    Number(node.dataset.streamItem!.slice(1)),
  );

const expectContiguous = (idx: number[]): void => {
  for (let i = 1; i < idx.length; i++) expect(idx[i]).toBe(idx[i - 1]! + 1);
};

/**
 * Give the stream a browser's geometry: a viewport, a scroll position, and card rects that
 * follow the estimate model (card i's top is `i * estimate - scrollTop`). Every card that
 * MOUNTS during the test inherits the model through a prototype-level stub keyed on its
 * `data-sid`, so window moves re-stub themselves.
 */
function armGeometry(host: HTMLElement, viewport: number): HTMLElement {
  const scroller = host.matches("[data-reading-scroll]") ? host
    : host.querySelector<HTMLElement>("[data-reading-scroll]")!;
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: N * STREAM_CARD_ESTIMATE_PX });
  scroller.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
    scroller.scrollTop = (typeof options === "number" ? y : options?.top) ?? scroller.scrollTop;
    scroller.dispatchEvent(new Event("scroll"));
  };
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: viewport });
  let top = 0;
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => { top = v; },
  });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: viewport, height: viewport } as DOMRect);
  // Cards are <article>s — stub at the shared HTMLElement level so every card that ever
  // mounts inherits the model. The scroller keeps its own-property stub above.
  const proto = HTMLElement.prototype;
  const original = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const sid = this.dataset?.streamWindowItem ?? this.dataset?.streamItem;
    if (sid) {
      const i = Number(sid.slice(1));
      const y = i * STREAM_CARD_ESTIMATE_PX - top;
      return { top: y, bottom: y + STREAM_CARD_ESTIMATE_PX, height: STREAM_CARD_ESTIMATE_PX } as DOMRect;
    }
    return original.call(this);
  };
  restoreRect = () => { proto.getBoundingClientRect = original; };
  return scroller;
}
let restoreRect: (() => void) | null = null;

/** One jump, then the frames that let it land: a move past a viewport is a flight, and the window
 *  commits only once two frames have passed with no scroll. */
const scrollTo = async (scroller: HTMLElement, px: number): Promise<void> => {
  await act(async () => {
    scroller.scrollTop = px;
    scroller.dispatchEvent(new Event("scroll"));
    for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 40)); // the rAF-coalesced sampler
  });
};

/** One scroll event and one frame, on fake timers. */
const step = async (scroller: HTMLElement, px: number): Promise<void> => {
  await act(async () => {
    scroller.scrollTop = px;
    scroller.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(17);
  });
};
const frames = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { vi.advanceTimersByTime(17); });
};

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  Element.prototype.scrollIntoView ??= () => undefined;
  HTMLElement.prototype.scrollTo ??= () => undefined;
});
afterEach(() => {
  cleanup();
  restoreRect?.();
  restoreRect = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the reading stream is a sliding window", () => {
  for (const [name, render] of [
    ["News", issue],
    ["Receipts", receipt],
  ] as const) {
    it(`${name}: a switch mounts one screen of cards at ${N}, not ${N}`, async () => {
      const host = (await visit(render, N)).host;
      const idx = cardIndices(host);
      // The load-bearing assertion — mapping the whole pile again makes this the pile's length,
      // and the old sixty-card opening run several screens of it.
      expect(idx.length).toBe(OPENING());
      expect(idx.length).toBeLessThanOrEqual(Math.ceil(window.innerHeight / STREAM_CARD_ESTIMATE_PX) + 2);
      expect(idx).toEqual(Array.from({ length: OPENING() }, (_, i) => i));
    });

    it(`${name}: under a Text size zoom the opening screen is counted in CSS px`, async () => {
      document.documentElement.style.setProperty("--ui-zoom", "2");
      try {
        const host = (await visit(render, N)).host;
        expect(cardIndices(host).length).toBe(openingCount(window.innerHeight / 2));
        expect(openingCount(window.innerHeight / 2)).toBeLessThan(OPENING());
      } finally {
        document.documentElement.style.removeProperty("--ui-zoom");
      }
    });

    it(`${name}: a short pile mounts whole, with no spacers`, async () => {
      const short = OPENING() - 1;
      const host = (await visit(render, short)).host;
      expect(cardIndices(host).length).toBe(short);
      expect(host.querySelector("[data-stream-tail]")).toBeNull();
      expect(host.querySelector("[data-stream-head]")).toBeNull();
    });

    it(`${name}: a pile past one screen reserves the rest as height, not cards`, async () => {
      const host = (await visit(render, 24)).host;
      expect(cardIndices(host).length).toBe(OPENING());
      expect(host.querySelector("[data-stream-head]")).toBeNull();
      const tail = host.querySelector<HTMLElement>("[data-stream-tail]");
      expect(tail?.style.height).toBe(`${(24 - OPENING()) * STREAM_CARD_ESTIMATE_PX}px`);
    });

    it(`${name}: a jump beyond the window REPOSITIONS it around the target`, async () => {
      const host = (await visit(render, N, "m3000")).host;
      // jumpTo schedules on a frame; let it run.
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
      const idx = cardIndices(host);
      // The target is mounted — a scroll to a missing card is a silent no-op, so this is the
      // difference between "jump works" and "jump quietly does nothing".
      expect(idx).toContain(3000);
      // …and the jump did NOT mount the thousands of cards above it: the window MOVED.
      expect(idx.length).toBeLessThanOrEqual(STREAM_WINDOW_MAX);
      expect(idx[0]).toBeGreaterThan(2000);
      expectContiguous(idx);
      // Both sides of the pile are reserved height now, not DOM.
      expect(host.querySelector("[data-stream-head]")).not.toBeNull();
      expect(host.querySelector("[data-stream-tail]")).not.toBeNull();
    });
  }

  it("scrolling deep SLIDES the window: cards left behind unmount, the count stays bounded", async () => {
    const host = (await visit(issue, N)).host;
    const scroller = armGeometry(host, 800);

    // Deep into the pile: the window follows the viewport there.
    await scrollTo(scroller, 2500 * STREAM_CARD_ESTIMATE_PX);
    let idx = cardIndices(host);
    expect(idx.length).toBeGreaterThan(0);
    expect(idx.length).toBeLessThanOrEqual(STREAM_WINDOW_MAX);
    // The anti-prefix assertion: the opening cards are OUT of the DOM.
    expect(idx[0]).toBeGreaterThan(2000);
    expect(idx.some((i) => i >= 2500)).toBe(true);
    expectContiguous(idx);
    expect(host.querySelector("[data-stream-head]")).not.toBeNull();

    // Half a pile further: still bounded, still near the viewport.
    await scrollTo(scroller, 4500 * STREAM_CARD_ESTIMATE_PX);
    idx = cardIndices(host);
    expect(idx.length).toBeLessThanOrEqual(STREAM_WINDOW_MAX);
    expect(idx[0]).toBeGreaterThan(4000);
    expectContiguous(idx);

    // And back to the top: the early cards return, the deep ones unmount.
    await scrollTo(scroller, 0);
    idx = cardIndices(host);
    expect(idx[0]).toBe(0);
    expect(idx.length).toBeLessThanOrEqual(STREAM_WINDOW_MAX);
    expectContiguous(idx);
  });

  it("the end-of-pile line is only claimed while the last card is mounted", async () => {
    const big = (await visit(issue, N)).host;
    expect(within(big).queryByText("No older unread items.")).toBeNull();
    const scroller = armGeometry(big, 800);
    await scrollTo(scroller, (N - 3) * STREAM_CARD_ESTIMATE_PX);
    expect(cardIndices(big)).toContain(N - 1);
    // The stream shows no end-of-pile sentence.
    expect(within(big).queryByText("No older unread items.")).toBeNull();

    cleanup();
    restoreRect?.();
    restoreRect = null;
    const small = (await visit(issue, OPENING() - 1)).host;
    expect(within(small).queryByText("No older unread items.")).toBeNull();
  });

  /* End in News: WebKit animates the stream over a dozen frames, each far past the mounted
     window. Re-committing on each one unmounted and mounted cards and their letter frames a
     dozen times inside the animation; the desktop's web process crashed there. */
  it("a flight holds the window and commits once, where it stops", async () => {
    vi.useFakeTimers();
    try {
      const host = (await visit(issue, N)).host;
      const scroller = armGeometry(host, 800);
      await frames(6); // the post-paint growth settles
      const held = cardIndices(host);
      let top = 0;
      for (let s = 1; s <= 12; s++) {
        top += 7000;
        await step(scroller, top);
        expect(cardIndices(host), `frame ${s} of the flight re-committed the window`).toEqual(held);
      }
      await frames(3);
      const idx = cardIndices(host);
      expect(idx).toContain(Math.floor(top / STREAM_CARD_ESTIMATE_PX));
      expect(idx.length).toBeLessThanOrEqual(STREAM_WINDOW_MAX);
      expectContiguous(idx);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hand scroll still moves the window while it scrolls", async () => {
    vi.useFakeTimers();
    try {
      const host = (await visit(issue, N)).host;
      const scroller = armGeometry(host, 800);
      await frames(6);
      for (let top = 300; top <= 12_000; top += 300) await step(scroller, top);
      // No rest frames: the window followed the hand.
      expect(cardIndices(host)).toContain(Math.floor(12_000 / STREAM_CARD_ESTIMATE_PX));
      expectContiguous(cardIndices(host));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the window under a pile that changes size", () => {
  it("a view mounted MID-DRAIN grows its opening window as the pile arrives — no scroll needed", async () => {
    const { host, replaceEngine } = await visit(issue, 2);
    expect(cardIndices(host).length).toBe(2);
    await act(async () => { replaceEngine("acct-1", letters(issue, N)); });
    expect(cardIndices(host).length).toBe(OPENING());
    expect(cardIndices(host)).toEqual(Array.from({ length: OPENING() }, (_, i) => i));
  });
});
