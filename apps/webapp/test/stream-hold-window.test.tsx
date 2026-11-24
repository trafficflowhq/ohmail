/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { STREAM_HOLD_QUIET_MS } from "@ohmail/app-logic/streams";
import { StreamScrollFixture } from "./stream-scroll-fixture";
import { within } from "@testing-library/react";

/**
 * ═══ THE ANCHOR-HOLD LOOP RUNS WHILE SOMETHING CAN MOVE, AND NOT OTHERWISE ═══════════════════
 *
 * The loop re-armed its own `requestAnimationFrame` unconditionally, so a mounted stream was a
 * 60 Hz forced layout for the life of the view. Measured on the shipped shell through CDP, signed
 * in, untouched for 120 s: a callback every frame and four `getBoundingClientRect` calls a frame
 * against ZERO DOM mutations — the loop was reading layout four times a frame to discover,
 * every frame, that nothing had happened.
 *
 * The rule now: armed by the things that can move the content it holds, stopped
 * {@link STREAM_HOLD_QUIET_MS} after the last of them and while the document is hidden. Both halves are
 * here — a loop that never stops and a loop that never restarts are the same file passing.
 *
 * jsdom has no layout, so geometry is stubbed through the same reads a browser answers, and
 * `requestAnimationFrame` is a queue this file drains by hand: the number of callbacks OUTSTANDING
 * after a drain is the fact under test, and it cannot be reached by waiting.
 */
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];
/** The pending frame callbacks, by handle. A cancel really cancels — an unmount must be quiet. */
let pending = new Map<number, FrameRequestCallback>();
let nextHandle = 1;
let clock = 1_000_000;
let hiddenNow = false;

/**
 * Run every frame currently queued.
 *
 * The count that follows is NOT `pending.size`: a scroll legitimately arms the scroll-spy's own
 * frame too, and a test that counted both would read the spy as the hold loop. The hold loop is
 * identified by IDENTITY — it re-arms with the same function object, so the callback the mount
 * queues is the loop, for ever — rather than by a name a rename could quietly retire.
 */
async function drainFrames(): Promise<void> {
  const due = [...pending.entries()];
  pending = new Map();
  await act(async () => {
    for (const [, cb] of due) cb(clock);
  });
}

let holdFrame: FrameRequestCallback | null = null;
/** How many frames the ANCHOR-HOLD loop has outstanding. */
function holdPending(): number {
  return [...pending.values()].filter((cb) => cb === holdFrame).length;
}

/** A rect at `top`, one card high. */
const rect = (top: number, height = 200): DOMRect =>
  ({ top, bottom: top + height, left: 0, right: 100, width: 100, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

beforeEach(() => {
  pending = new Map();
  nextHandle = 1;
  holdFrame = null;
  clock = 1_000_000;
  hiddenNow = false;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hiddenNow });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hiddenNow ? "hidden" : "visible"),
  });
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
  (globalThis as Record<string, unknown>).cancelAnimationFrame = (handle: number) => {
    pending.delete(handle);
  };
});

afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

interface Mounted {
  el: HTMLElement;
  cards: HTMLElement[];
  /** Content-space tops, mutable — growing a card above the anchor moves the ones below it. */
  tops: Record<string, number>;
  scrollTos: number[];
  scrollTop: () => number;
}

async function mountStream(): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const card = (sid: string) => h("div", { className: "scast", "data-sid": sid, key: sid });
  await act(async () => {
    root.render(
      h(StreamScrollFixture, {
        onCurrentChange: () => {},
        contentKey: 1,
        children: ["c1", "c2", "c3", "c4"].map(card),
      }),
    );
  });

  const el = within(container).getByRole("region", { name: "stream" });
  let scrollTop = 300; // c2 is the topmost card fully inside the port — the anchor.
  const tops: Record<string, number> = { c1: 0, c2: 300, c3: 600, c4: 900 };
  const scrollTos: number[] = [];
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 600 });
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: 1200 });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => { scrollTop = Math.max(0, v); },
  });
  el.getBoundingClientRect = () => rect(0, 600);
  const cards = [...container.querySelectorAll<HTMLElement>(".scast")];
  for (const c of cards) c.getBoundingClientRect = () => rect(tops[c.dataset.sid!]! - scrollTop);
  el.scrollTo = ((opts: ScrollToOptions) => {
    scrollTos.push(opts.top ?? 0);
    scrollTop = Math.max(0, opts.top ?? 0);
  }) as typeof el.scrollTo;
  /* The mount arms exactly one frame and it is the hold loop's — nothing else is armed at mount.
     That single callback is the loop's identity for the rest of the case. */
  if (pending.size !== 1) throw new Error(`the mount armed ${pending.size} frames, expected 1`);
  holdFrame = [...pending.values()][0]!;
  return { el, cards, tops, scrollTos, scrollTop: () => scrollTop };
}

/** Run frames until the hold loop stops re-arming. Bounded, so a loop that never stops fails. */
async function runUntilQuiet(limit = 20): Promise<number> {
  for (let i = 1; i <= limit; i++) {
    await drainFrames();
    if (holdPending() === 0) return i;
  }
  return limit + 1;
}

describe("the anchor-hold loop's arming window", () => {
  it("stops within the quiet window when nothing moves, and does not restart on its own", async () => {
    await mountStream();
    // Mounting arms it: the first cards are arriving as the effect runs.
    expect(holdPending(), "the mount arms one frame").toBe(1);
    // Inside the window it keeps running — this is the half that must stay true.
    await drainFrames();
    expect(holdPending(), "still armed inside the window").toBe(1);

    clock += STREAM_HOLD_QUIET_MS + 1;
    await drainFrames();
    expect(holdPending(), "the window ran out and the loop let go").toBe(0);
    await drainFrames();
    expect(holdPending(), "and nothing re-armed it by itself").toBe(0);
    // Twenty more frames' worth of clock: an idle stream queues nothing at all.
    clock += 20 * STREAM_HOLD_QUIET_MS;
    expect(pending.size).toBe(0);
  });

  it("a scroll re-arms it, and a DOM change inside the stream re-arms it", async () => {
    const { el } = await mountStream();
    clock += STREAM_HOLD_QUIET_MS + 1;
    expect(await runUntilQuiet()).toBeLessThan(3);
    expect(holdPending()).toBe(0);

    await act(async () => { el.dispatchEvent(new Event("scroll")); });
    expect(holdPending(), "a scroll is somebody using the stream").toBe(1);

    clock += STREAM_HOLD_QUIET_MS + 1;
    await runUntilQuiet();
    expect(holdPending()).toBe(0);

    /* A body arriving, the clamp class going on, a re-measure: every one of them is a DOM edit
       inside the stream, and the observer sees it where a ResizeObserver would not. */
    await act(async () => {
      el.querySelector<HTMLElement>(".scast")!.setAttribute("data-clamped", "1");
      await Promise.resolve();
    });
    expect(holdPending(), "a mutation inside the stream is a reason to hold").toBe(1);
  });

  it("a hidden document neither holds the loop open nor lets an event start one", async () => {
    const { el } = await mountStream();
    expect(holdPending()).toBe(1);

    hiddenNow = true;
    await drainFrames();
    expect(holdPending(), "going hidden ends the loop at the next frame").toBe(0);

    await act(async () => { el.dispatchEvent(new Event("scroll")); });
    expect(holdPending(), "and a hidden stream cannot be armed").toBe(0);

    hiddenNow = false;
    // On the DOCUMENT, which is where the event is delivered — dispatching it at the stream would
    // pass through a listener that was never there and prove nothing.
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(holdPending(), "coming back is a reason to hold again").toBe(1);
  });

  it("STILL HOLDS THE PLACE: a card growing above the anchor is compensated, same as before", async () => {
    // The positive control. Every refusal above is worth nothing if the loop no longer does its
    // job inside the window — this is the job, driven through the real component.
    const m = await mountStream();
    await drainFrames(); // frame 1 takes the anchor: c2 at offset 0.

    // A card ABOVE the anchor grows by 50px, the way a body arriving does: the DOM changes and
    // everything below it moves down.
    await act(async () => {
      m.tops.c2 += 50;
      m.tops.c3 += 50;
      m.tops.c4 += 50;
      m.cards[0]!.setAttribute("data-grown", "1");
      await Promise.resolve();
    });
    await drainFrames();

    expect(m.scrollTos, "the stream absorbed the growth in the same frame").toEqual([350]);
    expect(m.scrollTop()).toBe(350);
  });

  it("the same growth arriving while the loop is QUIET is still absorbed when it wakes", async () => {
    // The anchor survives the stop — that is what makes waking correct. Remove the survival (null
    // the held anchor on stop) and this goes red while every refusal above stays green.
    const m = await mountStream();
    await drainFrames();
    clock += STREAM_HOLD_QUIET_MS + 1;
    await runUntilQuiet();
    expect(holdPending(), "asleep").toBe(0);

    await act(async () => {
      m.tops.c2 += 50;
      m.tops.c3 += 50;
      m.tops.c4 += 50;
      m.cards[0]!.setAttribute("data-grown", "1");
      await Promise.resolve();
    });
    expect(holdPending(), "the mutation woke it").toBe(1);
    await drainFrames();
    expect(m.scrollTos, "and the growth that woke it was measured against the anchor from before")
      .toEqual([350]);
  });
});
