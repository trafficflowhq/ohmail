/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { EngineMessage, TagDTO } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { OhboxView } from "../app/views/OhboxView";
import { KeymapProvider } from "../app/shell/keymap";
import { useListWindow, FULL_RANGE_MAX_ROWS } from "@ohmail/app-logic/lists/list-window";

/**
 * SCROLLING THE OHBOX MOVES THE LIST BY ROWS, IT DOES NOT CUT THEM OFF THE TOP.
 *
 * Reported live on 0.19.1, web and desktop: scrolling the Ohbox hid the messages at the top
 * instead of scrolling them out, with a blank band under the header. `useListWindow` reserved
 * every unrendered row at ONE measured height and Ohbox rows are not equal — a row with a preview
 * line is three lines where one without is two — so the reserved height ran ahead of the real
 * rows. Measured here at `MIXED` rows: the rows reaching the top of the viewport were
 * 0,1,2,3,4,5,6,7,8,10,11,13,14 — rows 9 and 12 were never shown.
 */

/**
 * 0.19.2 bounded that at {@link FULL_RANGE_MAX_ROWS} rows, and a real Ohbox is bigger: the browser
 * cell on ohmail.app read one well past the bound. 0.19.3 closes it for every size — the window measures
 * each item it draws by its `data-index` and reserves the prefix sum of those heights, the running
 * mean for rows nobody has drawn. The cases below run PAST the bound, at `MIXED_LARGE` rows, with the
 * Ohbox's own group header in the same index space as the rows.
 */

/**
 * jsdom has no layout, so this file gives it one: the scroller is a column of blocks, a row is as
 * tall as its lines (a `.prev` line is the third), a spacer is its inline height, a group label is
 * one line, everything else is zero.
 */
const ISO = "2026-08-04T09:00:00.000Z";
const VIEWPORT_PX = 900;
const ROW_TWO_LINE_PX = 64;
const PREVIEW_LINE_PX = 32;
const LABEL_PX = 28;
/** The size the defect was first measured at; past the measured-list floor, so this runs windowed. */
const MIXED = 400;
/** PAST the bound, where the window runs: a size a real Ohbox reaches. */
const MIXED_LARGE = 1200;

const tags: TagDTO[] = [];

/** Every third message carries no snippet, so its row is two lines where the others are three. */
const message = (i: number): EngineMessage =>
  ({
    id: `m${i}`, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `subject of m${i}`, from: { name: `Sender ${i}`, address: `s${i}@x.invalid` },
    to: [], cc: [], date: ISO, folder: "INBOX", snippet: i % 3 === 0 ? null : `snippet of message ${i}`,
    unread: false, hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null,
    labels: [], remoteContent: "none", updatedAt: ISO,
  }) as unknown as EngineMessage;

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

interface Box { index: number; top: number; height: number; label: boolean }

/**
 * Every item in document order with its top — the layout a browser would give this column. A
 * GROUP LABEL IS AN ITEM: it is real content between two rows, so contiguity is asked over the
 * labels too, and only the index sequence filters them out.
 */
const boxes = (scroller: HTMLElement): Box[] => {
  const out: Box[] = [];
  let y = 0;
  const walk = (el: HTMLElement): void => {
    if (el.classList.contains("row")) {
      const h = heightOf(el);
      out.push({ index: Number((el.getAttribute("data-id") ?? "m-1").slice(1)), top: y, height: h, label: false });
      y += h;
      return;
    }
    if (el.classList.contains("grouplabel")) {
      out.push({ index: -1, top: y, height: LABEL_PX, label: true });
      y += LABEL_PX;
      return;
    }
    if (el.style.height.endsWith("px")) { y += Number.parseFloat(el.style.height); return; }
    for (const c of [...el.children]) walk(c as HTMLElement);
  };
  for (const c of [...scroller.children]) walk(c as HTMLElement);
  return out;
};

const rowBoxes = (scroller: HTMLElement): Box[] => boxes(scroller).filter((b) => !b.label);

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} now={new Date(ISO)} timeZone="UTC">
        <KeymapProvider>{node}</KeymapProvider>
      </NextIntlClientProvider>,
    );
  });
  return host;
}

async function scrollTo(scroller: HTMLElement, px: number): Promise<void> {
  scroller.scrollTop = px;
  await act(async () => {
    scroller.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 40));
  });
}

const ohbox = (count: number, first?: number): React.ReactElement => {
  const half = first ?? Math.floor(count / 2);
  return (
    <OhboxView owed={false}
      demo={false}
      newForYou={Array.from({ length: half }, (_, i) => message(i))}
      previouslySeen={Array.from({ length: count - half }, (_, i) => message(i + half))}
      tags={tags} now={new Date(ISO)} selectedId={null} onSelect={() => {}} onEnterReader={() => {}}
      onMarkSeen={() => {}} readerId={null} readSetFor={(id: string) => [id]} doorbellInitials={[]} doorbellCount={0} settled
      onDoorbell={() => {}} onAction={() => {}} onAddTag={() => {}}
      bulk={{ run: () => true, tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => true }}
      older={{ available: false, items: [], loading: false, error: null, exhausted: true, loadMore: () => {} }}
    />
  );
};

/** The window's own idiom, rendered the way a view that stamps no index renders it. */
function Windowed({ count }: { count: number }): React.ReactElement {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const win = useListWindow({ scrollerRef, count });
  return (
    <div ref={scrollerRef} className="scroller" data-testid="w">
      {win.padTop > 0 ? <div aria-hidden style={{ height: win.padTop }} /> : null}
      {Array.from({ length: win.end - win.start }, (_, k) => (
        <div key={win.start + k} className="row" data-id={`m${win.start + k}`} style={{ height: `${ROW_TWO_LINE_PX}px` }} />
      ))}
      {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
    </div>
  );
}

/**
 * The same idiom WITH the index stamped, and rows that can grow after they are first drawn —
 * a preview line arriving. The sums it derives are reported on the scroller so a test can read
 * them: `data-off10` is where item 10 starts, which is a pure prefix of measured heights.
 */
function Measured({ count, grown }: { count: number; grown: number }): React.ReactElement {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const win = useListWindow({ scrollerRef, count });
  return (
    <div ref={scrollerRef} className="scroller" data-off10={win.offsetOf(10)} data-total={win.offsetOf(count)}>
      {win.padTop > 0 ? <div aria-hidden style={{ height: win.padTop }} /> : null}
      {Array.from({ length: win.end - win.start }, (_, k) => {
        const i = win.start + k;
        /* A `.prev` child is the third line — the preview arriving, which is what grows a row. */
        return (
          <div key={i} className="row" data-id={`m${i}`} data-index={i}>
            {i < grown ? <div className="prev" /> : null}
          </div>
        );
      })}
      {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
    </div>
  );
}

describe("the Ohbox list scrolls its rows out of view instead of hiding them", () => {
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

  /**
   * THE REPORTED DEFECT, AS ARITHMETIC. Scroll down by exactly the height of the row at the top of
   * the viewport and the next row must be at the top — one row of scrolling is one row of mail.
   *
   * MUTATION-WATCHED: the height cache disabled reds this case by name (the rows it skips are
   * printed) — the Ohbox stamps its rows, so at this size the window runs.
   */
  it("scrolling by one row's height moves the list on by exactly one row", async () => {
    const host = await mount(ohbox(MIXED));
    const scroller = host.querySelector(".list-col .scroller") as HTMLElement;
    const at = (top: number): { index: number; top: number; height: number } | undefined =>
      rowBoxes(scroller).find((r) => r.top <= top && top < r.top + r.height);

    let s = rowBoxes(scroller)[0]!.top;
    await scrollTo(scroller, s);
    let cur = at(s)!;
    const seen: number[] = [cur.index];
    for (let step = 0; step < 12; step++) {
      s += cur.height;
      await scrollTo(scroller, s);
      const next = at(s);
      expect(next, `scrolled to ${s}px and no row is under the top of the viewport`).toBeDefined();
      seen.push(next!.index);
      cur = next!;
    }
    expect(
      seen,
      `the list skips rows as it scrolls: ${seen.join(",")} — a reader scrolling one row at a ` +
        `time never sees the ones that are missing from that sequence`,
    ).toEqual(Array.from({ length: seen.length }, (_, k) => seen[0]! + k));
  });

  /** No blank band under the header, and no gap between rows, at any depth. */
  it("no blank band above the first row and no gaps between rows", async () => {
    const host = await mount(ohbox(MIXED));
    const scroller = host.querySelector(".list-col .scroller") as HTMLElement;
    for (const top of [0, 1200, 6000, 14000]) {
      await scrollTo(scroller, top);
      const boxes = rowBoxes(scroller).filter((r) => r.top + r.height > top && r.top < top + VIEWPORT_PX);
      expect(boxes.length, `nothing is rendered in the viewport at ${top}px`).toBeGreaterThan(0);
      expect(
        boxes[0]!.top - top,
        `a blank band of ${boxes[0]!.top - top}px stands above the first row at ${top}px`,
      ).toBeLessThanOrEqual(ROW_TWO_LINE_PX + PREVIEW_LINE_PX);
      for (let i = 1; i < boxes.length; i++) {
        expect(
          boxes[i]!.top - (boxes[i - 1]!.top + boxes[i - 1]!.height),
          `a gap between the rows at ${top}px`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  /**
   * AND THE WINDOW IS STILL A WINDOW. History, Folders, Receipts and the rest hold piles no
   * viewport can bound; dropping the window there is an unbounded render, which this product has
   * already paid for once.
   */
  it("a long uniform list still windows: scrolled deep, it mounts its neighbourhood", async () => {
    const host = await mount(<Windowed count={1000} />);
    const scroller = host.querySelector(".scroller") as HTMLElement;
    await scrollTo(scroller, 40000);
    const idx = [...scroller.querySelectorAll(".row[data-id]")].map((n) =>
      Number((n.getAttribute("data-id") ?? "m-1").slice(1)),
    );
    expect(idx[0], "the window no longer windows — it mounts from the top at 40 000px").toBeGreaterThan(0);
    expect(idx.length).toBeLessThan(1000);
    expect(idx).toContain(Math.floor(40000 / ROW_TWO_LINE_PX));
  });

  /** The bound itself, read from the module so a changed value cannot pass here by accident. */
  it(`a list of ${FULL_RANGE_MAX_ROWS} rows is rendered whole, and one row more windows`, async () => {
    const whole = await mount(<Windowed count={FULL_RANGE_MAX_ROWS} />);
    const wholeScroller = whole.querySelector(".scroller") as HTMLElement;
    await scrollTo(wholeScroller, 4000);
    expect(wholeScroller.querySelectorAll(".row[data-id]").length).toBe(FULL_RANGE_MAX_ROWS);
    expect(wholeScroller.querySelectorAll("[aria-hidden]").length).toBe(0);

    const over = await mount(<Windowed count={FULL_RANGE_MAX_ROWS + 1} />);
    const overScroller = over.querySelectorAll(".scroller")[0] as HTMLElement;
    await scrollTo(overScroller, 4000);
    expect(overScroller.querySelectorAll(".row[data-id]").length).toBeLessThan(FULL_RANGE_MAX_ROWS + 1);
  });

  /**
   * THE SAME INVARIANT PAST THE BOUND, where the window actually runs — the size a real Ohbox is
   * (the browser cell read one past it). The scroll position is ACCUMULATED in scroll space,
   * never re-derived from the layout: that is what makes a skipped row visible, because a window
   * whose reserved height is wrong moves the rows under a fixed scroll position.
   *
   * MUTATION-WATCHED: the height cache disabled — every index reserved at one measured height —
   * reds this case by name and prints the rows it skipped.
   */
  it(`scrolling ${MIXED_LARGE} uneven rows moves the list on by exactly one row`, async () => {
    const host = await mount(ohbox(MIXED_LARGE, MIXED_LARGE));
    const scroller = host.querySelector(".list-col .scroller") as HTMLElement;
    const at = (top: number): Box | undefined =>
      rowBoxes(scroller).find((r) => r.top <= top && top < r.top + r.height);

    let s = rowBoxes(scroller)[0]!.top;
    await scrollTo(scroller, s);
    let cur = at(s)!;
    const seen: number[] = [cur.index];
    for (let step = 0; step < 16; step++) {
      s += cur.height;
      await scrollTo(scroller, s);
      const next = at(s);
      expect(next, `scrolled to ${s}px and no row is under the top of the viewport`).toBeDefined();
      seen.push(next!.index);
      cur = next!;
    }
    expect(
      seen,
      `the list skips rows as it scrolls: ${seen.join(",")} — a reader scrolling one row at a ` +
        `time never sees the ones that are missing from that sequence`,
    ).toEqual(Array.from({ length: seen.length }, (_, k) => seen[0]! + k));
  });

  /**
   * AND WITH THE GROUP HEADER IN THE SAME INDEX SPACE. Six rows in "New for you", the rest under
   * "Earlier", so the header is crossed a few rows in: no blank band above the first item and no
   * gap between any two items — the label included, because a label that is reserved in one place
   * and drawn in another is a gap wherever the window happens to be.
   */
  it(`no blank band and no gaps at ${MIXED_LARGE} rows, header and end of list included`, async () => {
    const host = await mount(ohbox(MIXED_LARGE, 6));
    const scroller = host.querySelector(".list-col .scroller") as HTMLElement;
    const content = heightOf(scroller);
    for (const top of [0, 400, 2400, 20000, 60000, Math.max(0, content - VIEWPORT_PX)]) {
      await scrollTo(scroller, top);
      const seen = boxes(scroller).filter((r) => r.top + r.height > top && r.top < top + VIEWPORT_PX);
      expect(seen.length, `nothing is rendered in the viewport at ${top}px`).toBeGreaterThan(0);
      expect(
        seen[0]!.top - top,
        `a blank band of ${seen[0]!.top - top}px stands above the first item at ${top}px`,
      ).toBeLessThanOrEqual(ROW_TWO_LINE_PX + PREVIEW_LINE_PX);
      for (let i = 1; i < seen.length; i++) {
        expect(
          seen[i]!.top - (seen[i - 1]!.top + seen[i - 1]!.height),
          `a gap between the items at ${top}px`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  /**
   * A HEIGHT THAT CHANGES AFTER RENDER. A preview line arrives and the row it is on grows; the
   * sums follow it on the next sample rather than keeping the size it was first drawn at.
   * `data-off10` is where item 10 starts — ten measured rows, no estimate in it at all.
   */
  it("a row that grows after it was drawn is re-measured and the sums follow", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const render = async (grown: number) => {
      await act(() => {
        root.render(
          <NextIntlClientProvider locale="en" messages={messages} now={new Date(ISO)} timeZone="UTC">
            <Measured count={MIXED_LARGE} grown={grown} />
          </NextIntlClientProvider>,
        );
      });
    };
    await render(0);
    const scroller = host.querySelector(".scroller") as HTMLElement;
    await scrollTo(scroller, 0);
    expect(Number(scroller.dataset.off10)).toBe(10 * ROW_TWO_LINE_PX);

    await render(10);
    await scrollTo(scroller, 0);
    expect(
      Number(scroller.dataset.off10),
      "ten rows grew by a preview line and the reserved height did not follow them",
    ).toBe(10 * (ROW_TWO_LINE_PX + PREVIEW_LINE_PX));
  });
});
