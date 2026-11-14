/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { EngineMessage, TagDTO } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { OhboxView } from "../app/views/OhboxView";
import { KeymapProvider } from "@ohmail/app/keys";

/**
 * THE OHBOX LIST HOLDS STILL UNDER THE READER. Reported live on 0.19.3: after a jump (the
 * scrollbar, End, a search reveal) the rows at the top of the viewport left before they reached
 * its edge. `useListWindow` priced every row it had not measured at the RUNNING MEAN, so each row
 * measured for the first time re-priced every unmeasured row above the viewport at once and the
 * spacer above the slice moved under a fixed `scrollTop` — measured live at -48.7px in one frame
 * for one 66.5px row entering an 85px mean, and at hundreds of pixels for a fresh window.
 */

/**
 * The invariants below are asked PER FRAME over the scroll patterns the investigation used —
 * fractional wheel steps, a jump, a fling, a count change — on rows of mixed height with both
 * group headers in the index space: (I1) the item under the top edge is rendered; (I2) a row on
 * screen in two consecutive frames moved by exactly what the reader scrolled; (I3) the spacer's
 * error against the true offsets changes only when a row above the viewport was drawn for the
 * first time. Same jsdom layout as ohbox-scroll-geometry.test.tsx.
 */

/**
 * I1 TO I3 ARE FRAME-RELATIVE, AND THE FIX ADDED A WRITER OF `scrollTop`. Two absolute
 * invariants hold that writer to the fixture's own heights: (I4) the frame that settles after a
 * position is asked for is AT that position, with the slice around the reader; (I5) the spacer
 * and the whole reserved height price every row nobody has drawn at a height a row of this list
 * can actually have. Without them the anchor can be taken from a row outside the slice and send
 * a jump of 48 060px to 143 059px, the end of the list, or a frozen row can be priced half again
 * above any real row, with I1-I3 green — both are frame-relative and a jump frame exempts them.
 */
const ISO = "2026-08-04T09:00:00.000Z";
const VIEWPORT_PX = 900;
const ROW_TWO_LINE_PX = 64;
const PREVIEW_LINE_PX = 32;
const LABEL_PX = 28;
const MAX_ITEM_PX = ROW_TWO_LINE_PX + PREVIEW_LINE_PX;
/** The shortest item in the index space — a group label. No price may fall below it. */
const MIN_ITEM_PX = LABEL_PX;
/** `useListWindow`'s own OVERSCAN_ROWS, which is not exported; asserted through the slice below. */
const OVERSCAN = 8;
/** The most one row's price can be wrong by, so the most the overscan above the anchor can owe. */
const LANDING_PX = OVERSCAN * (MAX_ITEM_PX - MIN_ITEM_PX);
/** Past FULL_RANGE_MAX_ROWS, where the window runs, as a real Ohbox does. */
const N = 1200;

const tags: TagDTO[] = [];

/**
 * A non-stationary height pattern: preview-heavy in the first rows (fresh mail), lighter
 * after — so the mean keeps moving for hundreds of measurements, as a real Ohbox's does.
 */
const hasPreview = (i: number): boolean => {
  const r = ((i * 2654435761) >>> 0) % 100;
  return i < 300 ? r < 80 : r < 40;
};

const message = (i: number, id = `m${i}`, preview = hasPreview(i)): EngineMessage =>
  ({
    id, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `subject of ${id}`, from: { name: `Sender ${i}`, address: `s${i}@x.invalid` },
    to: [], cc: [], date: ISO, folder: "INBOX", snippet: preview ? `snippet of message ${i}` : null,
    unread: false, hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null,
    labels: [], remoteContent: "none", updatedAt: ISO,
  }) as unknown as EngineMessage;

const rowPx = (m: EngineMessage): number => ROW_TWO_LINE_PX + (m.snippet ? PREVIEW_LINE_PX : 0);

const heightOf = (el: HTMLElement): number => {
  if (el.classList.contains("row")) {
    return ROW_TWO_LINE_PX + (el.querySelector(".prev") ? PREVIEW_LINE_PX : 0);
  }
  if (el.classList.contains("grouplabel")) return LABEL_PX;
  const inline = el.style.height;
  if (inline.endsWith("px")) return Number.parseFloat(inline);
  let sum = 0;
  for (const c of [...el.children]) sum += heightOf(c as HTMLElement);
  return sum;
};

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

interface Fixture {
  newForYou: EngineMessage[];
  previouslySeen: EngineMessage[];
  /** True height of window index i: [New label], New rows, [Earlier label], Earlier rows. */
  truth: number[];
  /** True offset of window index i — what a whole render would put there. */
  prefix: number[];
  total: number;
}

const fixture = (
  half: number,
  opts: { insertTop?: EngineMessage[]; moveToEarlier?: number } = {},
): Fixture => {
  let newForYou = Array.from({ length: half }, (_, i) => message(i));
  let previouslySeen = Array.from({ length: N - half }, (_, i) => message(i + half));
  if (opts.insertTop) newForYou = [...opts.insertTop, ...newForYou];
  if (opts.moveToEarlier) {
    const moved = newForYou.slice(-opts.moveToEarlier);
    newForYou = newForYou.slice(0, -opts.moveToEarlier);
    previouslySeen = [...moved, ...previouslySeen];
  }
  const truth: number[] = [];
  if (newForYou.length > 0) truth.push(LABEL_PX);
  for (const m of newForYou) truth.push(rowPx(m));
  if (previouslySeen.length > 0) truth.push(LABEL_PX);
  for (const m of previouslySeen) truth.push(rowPx(m));
  const prefix = [0];
  for (const h of truth) prefix.push(prefix[prefix.length - 1]! + h);
  return { newForYou, previouslySeen, truth, prefix, total: prefix[prefix.length - 1]! };
};

/** The index a whole render — every row at its true height — would put under `px`. */
const truthIndexAt = (f: Fixture, px: number): number => {
  let lo = 0;
  while (lo + 1 < f.prefix.length && f.prefix[lo + 1]! <= px) lo += 1;
  return lo;
};

const ohbox = (f: Fixture): React.ReactElement => (
  <OhboxView owed={false}
    demo={false}
    newForYou={f.newForYou}
    previouslySeen={f.previouslySeen}
    tags={tags} now={new Date(ISO)} selectedId={null} onSelect={() => {}} onEnterReader={() => {}}
    onMarkSeen={() => {}} readerId={null} readSetFor={(id: string) => [id]} doorbellInitials={[]} doorbellCount={0} settled
    onDoorbell={() => {}} onAction={() => {}} onAddTag={() => {}}
    bulk={{ run: () => true, tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => true }}
    older={{ available: false, items: [], loading: false, error: null, exhausted: true, loadMore: () => {} }}
  />
);

function mountRoot(): { host: HTMLElement; render: (node: React.ReactNode) => Promise<void> } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const render = async (node: React.ReactNode): Promise<void> => {
    await act(() => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} now={new Date(ISO)} timeZone="UTC">
          <KeymapProvider>{node}</KeymapProvider>
        </NextIntlClientProvider>,
      );
    });
  };
  return { host, render };
}

/**
 * One frame of the reader's scrolling: set the position, let the window sample and commit. It
 * returns the px that were ASKED for — after the commit `scrollTop` is whatever the window left
 * there, which is exactly what I4 is about.
 */
async function scrollTo(scroller: HTMLElement, px: number): Promise<number> {
  scroller.scrollTop = px;
  await act(async () => {
    scroller.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 40));
  });
  return px;
}

interface Item { index: number; id: string; top: number; height: number }
interface Frame { n: number; s: number; padTop: number; start: number; items: Item[]; drift: number }

/** The layout a browser would give the scroller's column, in document order. */
const read = (scroller: HTMLElement): { items: Item[]; padTop: number; padBottom: number } => {
  const items: Item[] = [];
  let y = 0;
  let padTop = 0;
  let padBottom = 0;
  let seenIndexed = false;
  const walk = (el: HTMLElement): void => {
    if (el.hasAttribute("data-index")) {
      const h = heightOf(el);
      items.push({ index: Number(el.getAttribute("data-index")), id: el.getAttribute("data-id") ?? `label${el.getAttribute("data-index")}`, top: y, height: h });
      y += h;
      seenIndexed = true;
      return;
    }
    if (el.style.height.endsWith("px")) {
      const h = heightOf(el);
      if (el.hasAttribute("aria-hidden")) { if (seenIndexed) padBottom = h; else padTop = h; }
      y += h;
      return;
    }
    if (el.classList.contains("row") || el.classList.contains("grouplabel")) { y += heightOf(el); return; }
    for (const c of [...el.children]) walk(c as HTMLElement);
  };
  for (const c of [...scroller.children]) walk(c as HTMLElement);
  return { items, padTop, padBottom };
};

/**
 * Records one frame per scroll step and asks the five invariants against the previous frame and
 * against the fixture's true heights. `userDelta` is how far the READER scrolled — a compensating
 * window may move `scrollTop` further, and the row on screen must follow the reader, not the
 * window. `allowance` is the one frame a count change is permitted to move the content by: an
 * un-anchored list moves by what arrived.
 */
class Recorder {
  frames: Frame[] = [];
  everRendered = new Set<number>();
  /** Indices this fixture has had drawn, so the window has MEASURED them at the truth below. */
  priced = new Set<number>();
  red: Record<"I1" | "I2" | "I3" | "I4" | "I5" | "RIG", string[]> =
    { I1: [], I2: [], I3: [], I4: [], I5: [], RIG: [] };
  constructor(public name: string, public f: Fixture) {}
  /** A new fixture re-indexes the list: every measurement the window holds is now unattributable. */
  refix(f: Fixture): void { this.f = f; this.priced.clear(); }
  record(scroller: HTMLElement, request: number, userDelta?: number, allowance = 0): void {
    const s = scroller.scrollTop;
    const { items, padTop, padBottom } = read(scroller);
    const n = this.frames.length;
    const start = items.length ? Math.min(...items.map((i) => i.index)) : 0;
    const underTop = items.find((i) => i.top <= s && s < i.top + i.height) ?? null;
    const drift = padTop - (this.f.prefix[start] ?? 0);
    const firstDrawnAbove = items.filter((i) => !this.everRendered.has(i.index) && i.top + i.height <= s);
    const prev = this.frames[n - 1];
    for (const i of items) {
      if (this.f.truth[i.index] !== i.height) this.red.RIG.push(`frame ${n}: truth[${i.index}]=${this.f.truth[i.index]} but the DOM item is ${i.height}px`);
    }
    if (!underTop && s < this.f.total) {
      this.red.I1.push(`frame ${n}: nothing is rendered under scrollTop ${s} (padTop ${padTop}, first item at ${items[0]?.top})`);
    }
    if (prev) {
      const dDrift = drift - prev.drift;
      if (Math.abs(dDrift) >= 0.5 && Math.abs(dDrift) > allowance && firstDrawnAbove.length === 0) {
        this.red.I3.push(`frame ${n}: padTop moved ${dDrift.toFixed(1)}px against the true offsets (start ${prev.start}->${start}, scrollTop ${prev.s}->${s}) with no row above the viewport drawn for the first time`);
      }
      const ud = userDelta ?? s - prev.s;
      let worst = 0;
      let worstId = "";
      for (const i of items) {
        const p = prev.items.find((x) => x.id === i.id);
        if (!p) continue;
        const dev = (i.top - s) - (p.top - prev.s) + ud;
        if (Math.abs(dev) > Math.abs(worst)) { worst = dev; worstId = `${i.id}#${i.index}`; }
      }
      if (Math.abs(worst) >= 1 && Math.abs(worst) > allowance) {
        this.red.I2.push(`frame ${n}: row ${worstId} moved ${worst.toFixed(1)}px on screen beyond the reader's ${ud}px scroll (scrollTop ${prev.s}->${s}, padTop ${prev.padTop}->${padTop})`);
      }
    }
    const reserved = padTop + items.reduce((t, i) => t + i.height, 0) + padBottom;
    this.landed(n, s, request, start, underTop, allowance);
    for (const i of items) this.priced.add(i.index);
    this.honest(n, start, padTop, "the spacer above the slice");
    this.honest(n, this.f.truth.length, reserved, "the whole reserved height");
    for (const i of items) this.everRendered.add(i.index);
    this.frames.push({ n, s, padTop, start, items, drift });
  }

  /**
   * I4. The frame that settles after a position is asked for is AT that position — the window may
   * owe only the overscan rows above the anchor, whose prices are all it can have got wrong — and
   * the slice it renders is CENTRED there: the reader's row is the overscan-th item of it, never
   * one the slice merely happens to cover. Which row is truly at a pixel is not a question a
   * window that has measured a handful of its rows can answer; I5 is what bounds its estimate.
   */
  private landed(n: number, s: number, request: number, start: number, underTop: Item | null, allowance: number): void {
    const off = s - request;
    if (Math.abs(off) > LANDING_PX + allowance) {
      this.red.I4.push(`frame ${n}: a ${request.toFixed(1)}px position settled at scrollTop ${s.toFixed(1)} — ${off.toFixed(1)}px out, past the ${LANDING_PX}px the overscan above the anchor can owe (truly index ${truthIndexAt(this.f, s)} where ${truthIndexAt(this.f, request)} was asked for)`);
    }
    if (underTop && underTop.index - start > OVERSCAN) {
      this.red.I4.push(`frame ${n}: the reader is on index ${underTop.index} and the slice starts at ${start}, ${underTop.index - start} items above it — the window is rendering around somewhere other than the reader`);
    }
  }

  /**
   * I5. A reserved height is the sum of the prices of the items under it. The items this fixture
   * has had drawn are MEASURED, so they cost their true height; what is left over is what the
   * window charged for the rows nobody has drawn, and no row of this list is shorter than a group
   * label or taller than a row with a preview line.
   */
  private honest(n: number, upto: number, reserved: number, what: string): void {
    if (upto <= 0) return;
    let drawn = 0;
    let undrawn = 0;
    for (let i = 0; i < upto; i += 1) {
      if (this.priced.has(i)) drawn += this.f.truth[i] ?? 0;
      else undrawn += 1;
    }
    if (undrawn === 0) {
      const off = reserved - (this.f.prefix[upto] ?? 0);
      if (Math.abs(off) >= 0.5) this.red.I5.push(`frame ${n}: ${what} is ${reserved.toFixed(1)}px where every one of its ${upto} items has been measured at ${(this.f.prefix[upto] ?? 0).toFixed(1)}px`);
      return;
    }
    const price = (reserved - drawn) / undrawn;
    if (price < MIN_ITEM_PX - 0.01 || price > MAX_ITEM_PX + 0.01) {
      this.red.I5.push(`frame ${n}: ${what} is ${reserved.toFixed(1)}px, which prices each of the ${undrawn} items it has not drawn at ${price.toFixed(1)}px — outside the ${MIN_ITEM_PX}-${MAX_ITEM_PX}px an item of this list can be`);
    }
  }

  assertAll(): void {
    expect(this.red.RIG, `${this.name}: the rig's own layout disagrees with the fixture`).toEqual([]);
    for (const k of ["I1", "I2", "I3", "I4", "I5"] as const) {
      const first = this.red[k].slice(0, 3).join("\n  ");
      // Counted in FRAMES, not findings: I4 and I5 each ask two questions of one frame, and a
      // count of findings prints ratios like "122 of 72 frames" at a red.
      const bad = new Set(this.red[k].map((m) => m.slice(0, m.indexOf(":")))).size;
      expect.soft(bad, `${this.name}: ${k} red in ${bad} of ${this.frames.length} frames\n  ${first}`).toBe(0);
    }
  }
}

describe("the Ohbox list holds still under the reader while the window measures rows", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true, get(this: HTMLElement) { return heightOf(this); },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains("scroller") ? VIEWPORT_PX : heightOf(this); },
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true, writable: true,
      value: (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    for (const r of roots) await act(() => r.unmount());
    roots = [];
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  const mountOhbox = async (f: Fixture, name: string) => {
    const { host, render } = mountRoot();
    await render(ohbox(f));
    const scroller = host.querySelector(".list-col .scroller") as HTMLElement;
    const rec = new Recorder(name, f);
    rec.record(scroller, await scrollTo(scroller, 0));
    return { scroller, rec, render };
  };

  /** From the top nothing above the viewport is unmeasured; this path was clean and must stay so. */
  it("fractional wheel steps from the top: every row moves by exactly the scroll", async () => {
    const { scroller, rec } = await mountOhbox(fixture(6), "wheel-33.5px-from-top");
    for (let k = 1; k <= 80; k++) {
      rec.record(scroller, await scrollTo(scroller, scroller.scrollTop + 33.5), 33.5);
    }
    rec.assertAll();
  }, 60_000);

  /**
   * THE REPORTED SHAPE. A jump leaves every row between the measured top and the landing
   * unmeasured; each row the overscan then measures for the first time re-priced them all.
   * MUTATION-WATCHED: pricing unmeasured rows above the slice at the live mean reds I2 and I3
   * here, and so does dropping the `scrollTop` compensation in the measuring effect. Taking the
   * anchor from a row outside the slice sends this jump to the end of the list — I4.
   */
  it("a jump to the middle, then wheeling down: the rows do not slide under the cursor", async () => {
    const f = fixture(6);
    const { scroller, rec } = await mountOhbox(f, "jump-then-down");
    for (let k = 1; k <= 10; k++) rec.record(scroller, await scrollTo(scroller, k * 30));
    rec.record(scroller, await scrollTo(scroller, Math.floor(f.total / 2)));
    for (let k = 1; k <= 60; k++) {
      rec.record(scroller, await scrollTo(scroller, scroller.scrollTop + 30), 30);
    }
    rec.assertAll();
  }, 60_000);

  /** The live wheel-up cell: jump, then wheel UP into the rows the jump skipped. */
  it("a jump to the middle, then wheeling up: the row at the top edge leaves only as it is scrolled out", async () => {
    const f = fixture(6);
    const { scroller, rec } = await mountOhbox(f, "jump-then-up");
    rec.record(scroller, await scrollTo(scroller, Math.floor(f.total / 2)));
    for (let k = 1; k <= 60; k++) {
      rec.record(scroller, await scrollTo(scroller, scroller.scrollTop - 30), -30);
    }
    rec.assertAll();
  }, 60_000);

  /** A fling outruns the overscan by whole rows, then the reader settles into wheel steps. */
  it("a fling from the top, then wheel steps", async () => {
    const { scroller, rec } = await mountOhbox(fixture(6), "fling-then-steps");
    for (let k = 1; k <= 4; k++) rec.record(scroller, await scrollTo(scroller, k * 2400));
    for (let k = 1; k <= 60; k++) {
      rec.record(scroller, await scrollTo(scroller, scroller.scrollTop + 30), 30);
    }
    rec.assertAll();
  }, 60_000);

  /**
   * MAIL ARRIVES WHILE THE READER IS DEEP. Three two-line messages land at the top of "New for
   * you" and every index below shifts by three; then the last New row files under "Earlier" and
   * swaps indices with that label. The window is index-keyed and un-anchored, so the arrival
   * frame may move the content by what arrived, and by nothing more; every other frame is exact.
   */
  it("a count change deep in Earlier moves the content by at most what arrived, and only then", async () => {
    const f0 = fixture(300);
    const { scroller, rec, render } = await mountOhbox(f0, "count-change-deep");
    // 600px steps stay inside viewport + both overscans, so nothing is left unmeasured on the way
    for (let k = 1; k <= 50; k++) rec.record(scroller, await scrollTo(scroller, k * 600));
    const deep = scroller.scrollTop;
    const arrivals = [message(9001, "x1", false), message(9002, "x2", false), message(9003, "x3", false)];
    const f1 = fixture(300, { insertTop: arrivals });
    rec.refix(f1);
    await render(ohbox(f1));
    rec.record(scroller, await scrollTo(scroller, deep), 0, arrivals.length * MAX_ITEM_PX);
    for (let k = 1; k <= 8; k++) {
      rec.record(scroller, await scrollTo(scroller, scroller.scrollTop + 100), 100);
    }
    const f2 = fixture(300, { insertTop: arrivals, moveToEarlier: 1 });
    rec.refix(f2);
    await render(ohbox(f2));
    rec.record(scroller, await scrollTo(scroller, scroller.scrollTop), 0);
    for (let k = 1; k <= 8; k++) {
      rec.record(scroller, await scrollTo(scroller, scroller.scrollTop + 100), 100);
    }
    rec.assertAll();
  }, 60_000);
});
