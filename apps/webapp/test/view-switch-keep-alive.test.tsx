/** @vitest-environment jsdom */
/**
 * A PILE KEPT MOUNTED IS VISITED AGAIN, NOT CONTINUED (`visit.ts`, `kept-piles.tsx`).
 *
 * News and Receipts stay mounted under `<Activity>` while the reader is on another pile, so their
 * state survives a hide and a show — and so does everything a visit owned unless the visit
 * contract lets it go. The hazard is `\Seen`: the leave-commit writes to the person's own IMAP,
 * and a revisit that inherited the last visit's range or scroll could flip a message this visit
 * never put on screen. Every case here drives the REAL views under `<Activity>` with the
 * waterline-leave geometry (200px cards, a 600px port) and states the invariant directly: what a
 * visit commits was on screen during THAT visit, and a visit nobody drove commits nothing.
 *
 * Mutations watched red: drop the range reset at a visit's start (the arrival row, the subset
 * assertion); drop the scroll reset (the lands-at-the-top row, the subset assertion); drop
 * `bar.endVisit` (the lingering row); leave the stream's `pagehide` listener armed while hidden
 * (the pagehide row); never take the arming back on a visit that committed no card (the rapid row);
 * drop the list's scroll reset (the list rows).
 */
import { Activity } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS = {
  escape: (s: string) => s.replace(/["\\]/g, (c) => `\\${c}`),
};

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ── the geometry (waterline-leave's) ──────────────────────────────────────────────────── */

const CARD_H = 200;
const VIEW_H = 600;

class MockIO {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/* The list's geometry, for the list-sweep rows only: 80px rows in a 400px port. */
const ROW_H = 80;
const LIST_H = 400;
let listGeometry = false;
const isList = (el: Element): boolean => listGeometry && (el as HTMLElement).classList?.contains("scroller");
const zero = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };

/** An observer that reports every target on (re)observe, as Chromium and WebKit do. */
class DeliveringIO {
  private pending = new Set<Element>();
  constructor(private cb: IntersectionObserverCallback, private opts: IntersectionObserverInit = {}) {}
  observe(t: Element): void { this.pending.add(t); setTimeout(() => this.flush(), 0); }
  unobserve(t: Element): void { this.pending.delete(t); }
  disconnect(): void { this.pending.clear(); }
  takeRecords(): IntersectionObserverEntry[] { return []; }
  private flush(): void {
    const root = this.opts.root as Element | undefined;
    const targets = [...this.pending].filter((t) => t.isConnected);
    this.pending.clear();
    if (!root || targets.length === 0) return;
    const r = rectFor(root);
    const m = (this.opts.rootMargin ?? "0px").trim().split(/\s+/);
    const cut = (v: string | undefined) => (v?.endsWith("%") ? (parseFloat(v) / 100) * r.height : parseFloat(v ?? "0") || 0);
    const rootBounds = { ...zero, top: r.top - cut(m[0]), bottom: r.bottom + cut(m[2] ?? m[0]) } as DOMRect;
    this.cb(targets.map((target) => {
      const b = rectFor(target);
      const isIntersecting = b.height > 0 && b.bottom > rootBounds.top && b.top < rootBounds.bottom;
      return { target, boundingClientRect: b, rootBounds, isIntersecting, intersectionRatio: isIntersecting ? 0.5 : 0 } as unknown as IntersectionObserverEntry;
    }), this as unknown as IntersectionObserver);
  }
}

const scrollTops = new WeakMap<Element, number>();
const cardsOf = (stream: Element): HTMLElement[] => [...stream.querySelectorAll<HTMLElement>(".scast[data-sid]")];

function rectFor(el: Element): DOMRect {
  const c = (el as HTMLElement).classList;
  if (isList(el)) return { ...zero, top: 0, bottom: LIST_H, height: LIST_H } as DOMRect;
  const list = listGeometry ? (el as HTMLElement).closest?.(".scroller") : null;
  if (list && (el as HTMLElement).hasAttribute("data-window-top")) {
    const top = -(scrollTops.get(list) ?? 0);
    return { ...zero, top, bottom: top } as DOMRect;
  }
  if (list && (el as HTMLElement).dataset.index !== undefined && (el as HTMLElement).dataset.id) {
    const top = Number((el as HTMLElement).dataset.index) * ROW_H - (scrollTops.get(list) ?? 0);
    return { ...zero, top, bottom: top + ROW_H, height: ROW_H } as DOMRect;
  }
  if (c?.contains("stream")) return { ...zero, top: 0, bottom: VIEW_H, height: VIEW_H } as DOMRect;
  if (c?.contains("scast")) {
    const stream = el.closest(".stream");
    if (!stream) return zero as DOMRect;
    const i = cardsOf(stream).indexOf(el as HTMLElement);
    if (i < 0) return zero as DOMRect;
    const top = i * CARD_H - (scrollTops.get(stream) ?? 0);
    return { ...zero, top, bottom: top + CARD_H, height: CARD_H } as DOMRect;
  }
  return zero as DOMRect;
}

/** The cards (or list rows) inside the port right now — what a reader can see. */
function onScreen(stream: Element): string[] {
  if (isList(stream)) {
    return [...stream.querySelectorAll<HTMLElement>("[data-id][data-index]")].filter((row) => {
      const r = rectFor(row);
      return r.bottom > 0 && r.top < LIST_H;
    }).map((row) => row.dataset.id!);
  }
  return cardsOf(stream).filter((c) => {
    const r = rectFor(c);
    return r.bottom > 0 && r.top < VIEW_H;
  }).map((c) => c.dataset.sid!);
}

/** Every id that was on screen in the visit being recorded. */
let displayed = new Set<string>();
const note = (stream: Element): void => { for (const id of onScreen(stream)) displayed.add(id); };

function setScroll(stream: Element, next: number): void {
  const max = isList(stream) ? 100_000 : Math.max(0, cardsOf(stream).length * CARD_H - VIEW_H);
  const clamped = Math.min(Math.max(0, next), max);
  if (clamped === (scrollTops.get(stream) ?? 0)) return;
  scrollTops.set(stream, clamped);
  note(stream);
  stream.dispatchEvent(new Event("scroll"));
}

/* ── the harness ───────────────────────────────────────────────────────────────────────── */

interface Row { id: string; unread: boolean; subject?: string }

function msg(r: Row, folder: string): Record<string, unknown> {
  return {
    id: r.id, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: r.subject ?? `S-${r.id}`, from: { name: r.id, address: `${r.id}@example.com` },
    to: [], cc: [], date: "2026-08-02T09:00:00.000Z", folder, snippet: "preview", unread: r.unread,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

type Pile = "reads" | "receipts";
const NOW = new Date("2026-08-02T09:00:00.000Z");
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let commits: Record<Pile, Array<{ upToId: string; messageIds: string[] }>> = { reads: [], receipts: [] };
/** What the list sweep (and a card's own dwell) marked, per pile. */
let marked: Record<Pile, string[]> = { reads: [], receipts: [] };
let render: (active: Pile | null, rows: Row[], jump?: { pile: Pile; id: string } | null) => Promise<void> = async () => {};

async function mountPiles(rows: Row[]): Promise<void> {
  const { ReadsView } = await import("../app/views/ReadsView.js");
  const { ReceiptsView } = await import("../app/views/ReceiptsView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const bodyOf = (m: { snippet: string }) => ({ text: m.snippet, state: "snippet" });
  render = async (active, list, jump = null) => {
    const reads = h(ReadsView as never, {
      settled: true, owed: false,
      partition: { waterline: null, fresh: list.map((r) => msg(r, "ohmail/News")), seen: [], newCount: 0 },
      tags: [], now: NOW, cur: null, onCur: () => {},
      aiChip: null, chipState: null, onChipState: () => {}, markSeen: (id: string) => { marked.reads.push(id); },
      onLeaveSeen: (c: { upToId: string; messageIds: string[] }) => { commits.reads.push(c); },
      bodyOf, hydrateBody: () => {}, onAction: () => {},
      jumpTo: jump?.pile === "reads" ? jump.id : null, onJumped: () => {},
    } as never);
    const receipts = h(ReceiptsView as never, {
      settled: true, owed: false, messages: list.map((r) => msg(r, "ohmail/Receipts")),
      tags: [], now: NOW, cur: null, onCur: () => {},
      unreadCount: list.filter((r) => r.unread).length, isUnread: (m: { unread: boolean }) => m.unread,
      markSeen: (id: string) => { marked.receipts.push(id); },
      onLeaveSeen: (c: { upToId: string; messageIds: string[] }) => { commits.receipts.push(c); },
      bodyOf, hydrateBody: () => {}, onAction: () => {},
      jumpTo: jump?.pile === "receipts" ? jump.id : null, onJumped: () => {},
    } as never);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(KeymapProvider as never, {
          children: h(React.Fragment, null,
            h(Activity, { mode: active === "reads" ? "visible" : "hidden", children: reads }),
            h(Activity, { mode: active === "receipts" ? "visible" : "hidden", children: receipts })),
        } as never),
      }));
    });
    await act(async () => { vi.advanceTimersByTime(40); });
    const shown = active ? stream(active) : null;
    if (shown) note(shown);
    if (active && listGeometry) note(listOf(active));
  };
}

const stream = (pile: Pile): Element => host!.querySelector(`.view-${pile} .stream`)!;
const listOf = (pile: Pile): Element => host!.querySelector(`.view-${pile} .scroller`)!;

/** A human wheel on a pile's list, then the frames its window and its observer run in. */
async function wheelList(pile: Pile, to: number): Promise<void> {
  const el = listOf(pile);
  await act(async () => {
    el.dispatchEvent(new Event("wheel", { bubbles: true }));
    setScroll(el, to);
  });
  for (let i = 0; i < 4; i += 1) await act(async () => { vi.advanceTimersByTime(40); });
  note(el);
}

/** A human scroll of a stream: the input, then the movement a frame per half card, each with the rAF the measure runs in. */
async function wheel(pile: Pile, to: number): Promise<void> {
  const el = stream(pile);
  await act(async () => { el.dispatchEvent(new Event("wheel", { bubbles: true })); });
  const max = Math.max(0, cardsOf(el).length * CARD_H - VIEW_H);
  const end = Math.min(Math.max(0, to), max);
  let at = scrollTops.get(el) ?? 0;
  while (at !== end) {
    at = end > at ? Math.min(end, at + CARD_H / 2) : Math.max(end, at - CARD_H / 2);
    await act(async () => { setScroll(el, at); });
    await act(async () => { vi.advanceTimersByTime(20); });
  }
  await act(async () => { vi.advanceTimersByTime(40); });
}

let originalGetRect: unknown;
let originalScrollTo: unknown;
let originalScrollIntoView: unknown;
let innerHeight: PropertyDescriptor | undefined;
let scrollTopDesc: PropertyDescriptor | undefined;

beforeEach(() => {
  /* The opening slice is one screen of cards; a tall window opens with the whole pile, as the
     browser's lookahead would mount it. */
  innerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 20 * 220 });
  vi.useFakeTimers();
  vi.stubGlobal("IntersectionObserver", MockIO);
  commits = { reads: [], receipts: [] };
  marked = { reads: [], receipts: [] };
  listGeometry = false;
  displayed = new Set();
  originalGetRect = Element.prototype.getBoundingClientRect;
  originalScrollTo = (Element.prototype as unknown as { scrollTo?: unknown }).scrollTo;
  originalScrollIntoView = (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) { return rectFor(this); };
  (Element.prototype as unknown as { scrollTo: (o: { top?: number }) => void }).scrollTo =
    function scrollTo(this: Element, o: { top?: number }) {
      if ((this as HTMLElement).classList?.contains("stream")) setScroll(this, o?.top ?? 0);
    };
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = function scrollIntoView() {};
  /* The stream's own offset, as the views and the visit read it. */
  scrollTopDesc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) { return (this as HTMLElement).classList?.contains("stream") || isList(this) ? scrollTops.get(this) ?? 0 : 0; },
    set(this: Element, v: number) { if ((this as HTMLElement).classList?.contains("stream") || isList(this)) setScroll(this, v); },
  });
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
  if (innerHeight) Object.defineProperty(window, "innerHeight", innerHeight);
  else delete (window as unknown as { innerHeight?: number }).innerHeight;
  if (scrollTopDesc) Object.defineProperty(Element.prototype, "scrollTop", scrollTopDesc);
  Element.prototype.getBoundingClientRect = originalGetRect as typeof Element.prototype.getBoundingClientRect;
  (Element.prototype as unknown as { scrollTo: unknown }).scrollTo = originalScrollTo;
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const TEN: Row[] = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, unread: true }));

for (const pile of ["reads", "receipts"] as const) {
  const other: Pile = pile === "reads" ? "receipts" : "reads";
  describe(`${pile}: a revisit is its own visit`, () => {
    it("a revisit commits only what that visit put on screen, anchored inside it", async () => {
      await mountPiles(TEN);
      await render(pile, TEN);
      await wheel(pile, 1400); // the whole pile, then away
      await render(other, TEN);
      expect(commits[pile], "control: the first visit commits").toHaveLength(1);
      expect(commits[pile][0]!.upToId, "control: anchored at the top").toBe("r0");
      for (const id of commits[pile][0]!.messageIds) expect(displayed.has(id), `control: ${id} was on screen`).toBe(true);
      // Meanwhile: the first visit's mail is read, a new letter arrives on top, r1 is marked
      // unread on another device.
      const later: Row[] = [{ id: "n0", unread: true }, ...TEN.map((r) => ({ ...r, unread: r.id === "r1" }))];
      await render(other, later);
      displayed = new Set();
      await render(pile, later);
      await wheel(pile, 1600);
      await render(other, later);
      const second = commits[pile][1]!;
      expect(second, "the revisit committed nothing").toBeDefined();
      expect(displayed.has(second.upToId), `the line was anchored on ${second.upToId}, which this visit never showed`).toBe(true);
      for (const id of second.messageIds) {
        expect(displayed.has(id), `${id} was written \\Seen by a visit that never showed it`).toBe(true);
      }
      expect(second.upToId, "the revisit lands where a fresh mount lands: the top").toBe("n0");
    });

    it("a revisit nobody scrolled commits nothing", async () => {
      await mountPiles(TEN);
      await render(pile, TEN);
      await wheel(pile, 800);
      await render(other, TEN);
      expect(commits[pile]).toHaveLength(1);
      await render(pile, TEN);
      await act(async () => { vi.advanceTimersByTime(2500); });
      await render(other, TEN);
      expect(commits[pile], "a visit with no hand on the scroller wrote the waterline").toHaveLength(1);
    });

    it("a revisit lands at the top, where a fresh mount lands", async () => {
      await mountPiles(TEN);
      await render(pile, TEN);
      await wheel(pile, 800);
      expect(scrollTops.get(stream(pile))).toBe(800);
      await render(other, TEN);
      await render(pile, TEN);
      expect(scrollTops.get(stream(pile)) ?? 0, "the revisit opened where the last visit left off").toBe(0);
    });

    it("pagehide commits the pile on screen once, and nothing for a hidden one", async () => {
      await mountPiles(TEN);
      await render(other, TEN);
      await wheel(other, 400);
      await render(pile, TEN); // `other` is hidden now, with a visit behind it
      const before = commits[other].length;
      await wheel(pile, 400);
      await act(async () => { window.dispatchEvent(new Event("pagehide")); });
      expect(commits[pile], "the pile on screen did not commit on pagehide").toHaveLength(1);
      expect(commits[other], "a hidden pile committed on pagehide").toHaveLength(before);
    });

    it("a mirror change while hidden is on screen at the reveal, the old row gone", async () => {
      await mountPiles(TEN);
      await render(pile, TEN);
      await render(other, TEN);
      const changed = TEN.map((r) => (r.id === "r2" ? { ...r, subject: "A new subject" } : r)).filter((r) => r.id !== "r4");
      await render(other, changed);
      await render(pile, changed);
      const view = host!.querySelector(`.view-${pile}`)!;
      expect(view.textContent).toContain("A new subject");
      expect(view.textContent, "the reveal drew a row the mirror no longer holds").not.toContain("S-r4");
      expect(view.textContent).not.toContain("S-r2");
    });
  });
}

describe("what a visit leaves behind", () => {
  it("an earlier card's lingering bar does not outlive the visit", async () => {
    await mountPiles(TEN);
    await render("reads", TEN);
    const card = (id: string) => host!.querySelector<HTMLElement>(`.view-reads .scast[data-sid="${id}"]`)!;
    const bars = () => [...host!.querySelectorAll<HTMLElement>(".view-reads .scast .sc-actions")]
      .map((b) => b.closest<HTMLElement>(".scast")!.dataset.sid);
    await act(async () => { card("r0").click(); });
    await act(async () => { card("r1").click(); });
    expect(bars(), "control: the earlier card on screen keeps its bar while the next opens").toEqual(["r0", "r1"]);
    await render("receipts", TEN);
    await render("reads", TEN);
    expect(bars(), "the earlier card's bar lingered into the next visit").toEqual(["r1"]);
  });

  it("2, 3, 2, 3, 2 ends on News, armed, with nothing committed", async () => {
    await mountPiles(TEN);
    await render(null, TEN);
    for (const p of ["reads", "receipts", "reads", "receipts", "reads"] as const) await render(p, TEN);
    const reads = host!.querySelector<HTMLElement>(".view-reads")!;
    const receipts = host!.querySelector<HTMLElement>(".view-receipts")!;
    expect(reads.style.display, "News is not the pile on screen").not.toBe("none");
    expect(receipts.style.display).toBe("none");
    expect(reads.querySelectorAll(".scast").length, "News never armed its stream").toBeGreaterThan(0);
    expect(commits, "a pile passed through committed something").toEqual({ reads: [], receipts: [] });
  });
});

/* THE LIST READS NOTHING. It once had a sweep of its own: the list kept its offset through
   `display:none`, and a revisit that opened it where the last visit left it marked mail that
   arrived (or was marked unread) meanwhile and was never on screen. The list now marks no row
   (only the stream reads), and a revisit's list still opens at the top, as a fresh mount's does. */
const TWENTY: Row[] = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, unread: true }));

for (const pile of ["reads", "receipts"] as const) {
  const other: Pile = pile === "reads" ? "receipts" : "reads";
  describe(`${pile}: the list's sweep on a revisit`, () => {
    for (const [name, meanwhile] of [
      ["mail that arrived while hidden", (rows: Row[]) => [
        ...Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, unread: true })),
        ...rows,
      ]],
      ["a row marked unread elsewhere", (rows: Row[]) =>
        rows.map((r) => ({ ...r, unread: r.id === "r5" ? true : r.unread }))],
    ] as const) {
      it(`the list marks nothing, and a revisit's list opens at the top: ${name}`, async () => {
        listGeometry = true;
        vi.stubGlobal("IntersectionObserver", DeliveringIO);
        await mountPiles(TWENTY);
        await render(pile, TWENTY);
        await wheelList(pile, 800);
        expect(scrollTops.get(listOf(pile)), "control: the wheel moved the list").toBe(800);
        expect(marked[pile], "the first visit's list wheel marked rows").toEqual([]);
        await render(other, TWENTY);
        const later = meanwhile(TWENTY);
        await render(other, later);
        await render(pile, later);
        const atReveal = scrollTops.get(listOf(pile)) ?? 0;
        await wheelList(pile, atReveal + 40);
        expect(marked[pile], "the revisit's list wheel marked rows").toEqual([]);
        expect(atReveal, "the revisit's list opened where the last visit left it").toBe(0);
      });
    }
  });
}
