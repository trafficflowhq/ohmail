/** @vitest-environment jsdom */
/**
 * THE LEAVE-COMMIT (R10-5) — the waterline's reliability floor, against the real views.
 *
 * The old model marked `\Seen` only through per-card observer hits: a card that exited
 * through the TOP of the stream marked itself, the card the scroll settled on dwelled, and
 * the LAST SCREENFUL — which never exits through the top — structurally never marked. The
 * fix is not a better observer; it is that LEAVING the view commits the waterline to the
 * top of what was on screen, in ONE anchored `feed_mark_seen`, bounded by what the visit
 * actually displayed.
 *
 * "Leaving" is DEFINED here as component unmount — which, because both views are
 * conditionally rendered on the route, is exactly "route-change away from the view".
 * Tab-hide is deliberately not leaving (it fires on every cmd-tab), and closing the tab
 * commits nothing (conservative: a line that failed to advance shows old mail as new,
 * never the reverse).
 *
 * jsdom has no layout, so this file gives the stream real geometry: every `.scast` card is
 * CARD_H tall, the `.stream` viewport VIEW_H, and `getBoundingClientRect` answers from the
 * emulated scroll offset — which is what `StreamShell.measure()` reads.
 */
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

/* ── geometry the views believe ─────────────────────────────────────────────────────────── */

const CARD_H = 200;
const VIEW_H = 600; // three cards per screen

class MockIO {
  cb: unknown;
  constructor(cb: unknown) { this.cb = cb; }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const scrollTops = new WeakMap<Element, number>();
/** How many cards the pile holds: the stream's scroll height, whatever the window mounts. */
let pileSize = 10;
/** Every card that was inside the viewport at some offset the stream rested on. */
let displayed = new Set<string>();
/** Cards re-measured above: every card from index `from` on sits `by` px off its slot. */
let shift = { from: Infinity, by: 0 };

function streamCards(stream: Element): HTMLElement[] {
  return [...stream.querySelectorAll<HTMLElement>(".scast[data-sid]")];
}

/** `.stream` is the viewport; each `.scast` sits at its index times CARD_H, minus the offset. */
function rectFor(el: Element): DOMRect {
  const zero = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
  if ((el as HTMLElement).classList?.contains("stream")) {
    return { ...zero, top: 0, bottom: VIEW_H, height: VIEW_H } as DOMRect;
  }
  if ((el as HTMLElement).classList?.contains("scast")) {
    const stream = el.closest(".stream");
    if (!stream) return zero as DOMRect;
    // Placed at its PILE index (the ids are r<index>), so the window may mount any run of it.
    const i = Number((el as HTMLElement).dataset.sid?.slice(1));
    if (!Number.isFinite(i)) return zero as DOMRect;
    const top = i * CARD_H + (i >= shift.from ? shift.by : 0) - (scrollTops.get(stream) ?? 0);
    return { ...zero, top, bottom: top + CARD_H, height: CARD_H } as DOMRect;
  }
  return zero as DOMRect;
}

function setStreamScroll(stream: Element, next: number): void {
  const max = Math.max(0, pileSize * CARD_H - VIEW_H);
  scrollTops.set(stream, Math.min(Math.max(0, next), max));
  for (const c of streamCards(stream)) {
    const r = rectFor(c);
    if (r.bottom > 0 && r.top < VIEW_H) displayed.add(c.dataset.sid!);
  }
  stream.dispatchEvent(new Event("scroll"));
  for (const io of DeliveringIO.live) io.deliver(stream);
}

/** Reports what the browser would: every target when first observed, and after each move. */
class DeliveringIO {
  static live = new Set<DeliveringIO>();
  private targets = new Set<Element>();
  constructor(private cb: IntersectionObserverCallback, private opts: IntersectionObserverInit = {}) {
    DeliveringIO.live.add(this);
  }
  observe(t: Element): void {
    this.targets.add(t);
    const root = this.opts.root as Element | undefined;
    if (root) this.report(root, [t]);
  }
  unobserve(t: Element): void { this.targets.delete(t); }
  disconnect(): void { this.targets.clear(); }
  takeRecords(): IntersectionObserverEntry[] { return []; }
  deliver(root: Element): void {
    if (this.opts.root === root) this.report(root, [...this.targets]);
  }
  private report(root: Element, targets: Element[]): void {
    const live = targets.filter((t) => t.isConnected);
    if (live.length === 0) return;
    // Only the bottom margin is ever a percentage here ("0px 0px -62% 0px", "100% 0px").
    const m = (this.opts.rootMargin ?? "0px").trim().split(/\s+/);
    const cut = (v: string | undefined) => (v?.endsWith("%") ? (parseFloat(v) / 100) * VIEW_H : parseFloat(v ?? "0") || 0);
    const band = { top: -cut(m[0]), bottom: VIEW_H + cut(m[2] ?? m[0]) };
    this.cb(live.map((target) => {
      const b = rectFor(target);
      const isIntersecting = b.height > 0 && b.bottom > band.top && b.top < band.bottom;
      return { target, boundingClientRect: b, rootBounds: { ...b, top: band.top, bottom: band.bottom }, isIntersecting } as unknown as IntersectionObserverEntry;
    }), this as unknown as IntersectionObserver);
  }
}

/* ── the harness ───────────────────────────────────────────────────────────────────────── */

interface Row { id: string; unread: boolean }

function msg(r: Row, folder: string): Record<string, unknown> {
  return {
    id: r.id,
    accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `S-${r.id}`,
    from: { name: r.id, address: `${r.id}@example.com` },
    to: [], cc: [],
    date: "2026-08-02T09:00:00.000Z",
    folder,
    snippet: "preview",
    unread: r.unread,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** Every commit the view handed up on its way out — the thing under test. */
let commits: Array<{ upToId: string; messageIds: string[] }> = [];
let marked: string[] = [];
let curs: string[] = [];

const NOW = new Date("2026-08-02T09:00:00.000Z");

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
}

function wrap(children: React.ReactNode, KeymapProvider: unknown): React.ReactNode {
  return h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: NOW,
    children: h(KeymapProvider as never, { children } as never),
  });
}

async function mountReads(rows: Row[], opts: { jump?: string } = {}): Promise<void> {
  await unmount();
  const { ReadsView } = await import("../app/views/ReadsView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  const node = h(ReadsView as never, {
    settled: true, owed: false,
    partition: { waterline: null, fresh: rows.map((r) => msg(r, "ohmail/News")), seen: [] },
    tags: [], now: NOW, cur: null, onCur: () => {},
    aiChip: null, chipState: null, onChipState: () => {},
    markSeen: (id: string) => { marked.push(id); },
    onLeaveSeen: (c: { upToId: string; messageIds: string[] }) => { commits.push(c); },
    bodyOf: (m: { snippet: string }) => ({ text: m.snippet, state: "snippet" }),
    hydrateBody: () => {},
    jumpTo: opts.jump ?? null, onJumped: () => {},
  } as never);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(wrap(node, KeymapProvider)); });
}

async function mountReceipts(
  rows: Row[],
  opts: { jump?: string; waterline?: { newestSeenId: string; at?: string }; freshCount?: number } = {},
): Promise<void> {
  await unmount();
  const { ReceiptsView } = await import("../app/views/ReceiptsView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  const node = h(ReceiptsView as never, {
    settled: true, owed: false,
    messages: rows.map((r) => msg(r, "ohmail/Receipts")),
    waterline: opts.waterline ?? null,
    freshCount: opts.freshCount,
    tags: [], now: NOW, cur: null, onCur: () => {},
    unreadCount: rows.filter((r) => r.unread).length,
    isUnread: (m: { unread: boolean }) => m.unread,
    markSeen: (id: string) => { marked.push(id); },
    onLeaveSeen: (c: { upToId: string; messageIds: string[] }) => { commits.push(c); },
    bodyOf: (m: { snippet: string }) => ({ text: m.snippet, state: "snippet" }),
    hydrateBody: () => {},
    jumpTo: opts.jump ?? null, onJumped: () => {},
  } as never);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(wrap(node, KeymapProvider)); });
}

const streamEl = (): Element => host!.querySelector(".stream")!;

/** A real user scroll of the STREAM: the input a human produces, then the movement, a frame per half card. */
async function wheelStream(to: number): Promise<void> {
  const el = streamEl();
  await act(async () => { el.dispatchEvent(new Event("wheel", { bubbles: true })); });
  let at = scrollTops.get(el) ?? 0;
  while (at !== to) {
    at = to > at ? Math.min(to, at + CARD_H / 2) : Math.max(to, at - CARD_H / 2);
    await act(async () => { setStreamScroll(el, at); });
    await act(async () => { vi.advanceTimersByTime(20); });
  }
  // The measure runs inside the scroll handler's rAF; let it land (but stay under the 2s dwell).
  await act(async () => { vi.advanceTimersByTime(40); });
}

/** A move with no input event of its own (a scrollbar-thumb drag, or End): one scroll per offset. */
async function leapStream(...offsets: number[]): Promise<void> {
  for (const top of offsets) {
    await act(async () => { setStreamScroll(streamEl(), top); });
    await act(async () => { vi.advanceTimersByTime(20); });
  }
}

/**
 * A view whose cursor and jump live in the shell, as AppShell holds them: `onCur` and
 * `onJumped` re-render, so the stream re-renders around a jump the way it does in the app.
 */
async function mountReadsLive(rows: Row[], jump: string | null): Promise<void> {
  await unmount();
  const { ReadsView } = await import("../app/views/ReadsView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  pileSize = rows.length;
  let cur: string | null = null;
  let jumpTo: string | null = jump;
  const fresh = rows.map((r) => msg(r, "ohmail/News"));
  const tree = (): React.ReactNode => wrap(h(ReadsView as never, {
    settled: true, owed: false,
    partition: { waterline: null, fresh, seen: [], newCount: rows.length },
    tags: [], now: NOW, cur, onCur: (id: string) => { curs.push(id); cur = id; root?.render(tree()); },
    aiChip: null, chipState: null, onChipState: () => {},
    markSeen: (id: string) => { marked.push(id); },
    onLeaveSeen: (c: { upToId: string; messageIds: string[] }) => { commits.push(c); },
    bodyOf: (m: { snippet: string }) => ({ text: m.snippet, state: "snippet" }),
    hydrateBody: () => {}, onAction: () => {},
    jumpTo, onJumped: () => { jumpTo = null; root?.render(tree()); },
  } as never), KeymapProvider);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(tree()); });
  // The far landing runs over frames; let it settle.
  for (let i = 0; i < 20; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
}

let originalGetRect: unknown;
let originalScrollTo: unknown;
let originalScrollIntoView: unknown;
let streamSize: Record<string, PropertyDescriptor | undefined> = {};

/* The stream opens one screen of cards (`stream-window.ts`), sized by the window's height where
   nothing lays out; this emulator's port is 600px of 200px cards, so it is handed a screen tall
   enough to open with the whole pile, as the browser's lookahead would mount it. */
let innerHeight: PropertyDescriptor | undefined;

beforeEach(() => {
  innerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 20 * 220 });
  vi.useFakeTimers();
  vi.stubGlobal("IntersectionObserver", MockIO);
  commits = [];
  marked = [];
  pileSize = 10;
  displayed = new Set();
  shift = { from: Infinity, by: 0 };
  DeliveringIO.live = new Set();
  // The port's own size, which the stream's jump reads to tell a near landing from a far one.
  const isStream = (el: Element) => (el as HTMLElement).classList?.contains("stream");
  streamSize = {
    clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight"),
    scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight"),
    scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop"),
  };
  Object.defineProperty(Element.prototype, "clientHeight", {
    configurable: true, get(this: Element) { return isStream(this) ? VIEW_H : 0; },
  });
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true, get(this: Element) { return isStream(this) ? pileSize * CARD_H : 0; },
  });
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) { return isStream(this) ? scrollTops.get(this) ?? 0 : 0; },
    set(this: Element, v: number) { if (isStream(this)) setStreamScroll(this, v); },
  });
  originalGetRect = Element.prototype.getBoundingClientRect;
  originalScrollTo = (Element.prototype as unknown as { scrollTo?: unknown }).scrollTo;
  originalScrollIntoView = (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
    return rectFor(this);
  };
  (Element.prototype as unknown as { scrollTo: (o: { top?: number }) => void }).scrollTo =
    function scrollTo(this: Element, o: { top?: number }) {
      if ((this as HTMLElement).classList?.contains("stream")) setStreamScroll(this, o?.top ?? 0);
    };
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView =
    function scrollIntoView() { /* the list pane's follow — no geometry to keep here */ };
});

afterEach(async () => {
  await unmount();
  for (const [k, d] of Object.entries(streamSize)) {
    if (d) Object.defineProperty(Element.prototype, k, d);
    else delete (Element.prototype as unknown as Record<string, unknown>)[k];
  }
  if (innerHeight) Object.defineProperty(window, "innerHeight", innerHeight);
  else delete (window as unknown as { innerHeight?: number }).innerHeight;
  Element.prototype.getBoundingClientRect = originalGetRect as typeof Element.prototype.getBoundingClientRect;
  (Element.prototype as unknown as { scrollTo: unknown }).scrollTo = originalScrollTo;
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const TEN: Row[] = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, unread: true }));

/* ── the guards ────────────────────────────────────────────────────────────────────────── */

describe("leaving commits the waterline — once, anchored, bounded", () => {
  it("THE STRUCTURAL MISS, CLOSED: leave at the bottom ⇒ one commit, anchored at the top, covering the last screenful", async () => {
    // Scroll to the very bottom and leave. The last screenful (r7–r9) never exits through
    // the top, so the observer model alone never marks it — the commit must. The anchor is
    // r0, the newest card the visit displayed, which puts the line above everything.
    // Break `StreamShell`'s unmount cleanup (or the view's range arithmetic) and this is red.
    await mountReads(TEN);
    await wheelStream(1400); // max: 10 cards × 200 − 600
    await unmount();
    expect(commits).toEqual([
      { upToId: "r0", messageIds: ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"] },
    ]);
  });

  it("BOUNDED by what was displayed — never the pile", async () => {
    // A partial read: 400px in, the final screen shows r2–r4. The commit covers r0–r4 (the
    // contiguous run the visit displayed) and NOT r5–r9, which never entered the viewport.
    // Widen the slice in the view's leave handler to the whole pile and this goes red.
    await mountReads(TEN);
    await wheelStream(400);
    await unmount();
    expect(commits).toEqual([
      { upToId: "r0", messageIds: ["r0", "r1", "r2", "r3", "r4"] },
    ]);
  });

  it("only UNREAD ids ride the commit — the anchor still stands for the range", async () => {
    // r1 and r3 are already read (\Seen on the server); flipping them again is a request
    // the wire does not need. The anchor is unchanged: the line is about what was SEEN,
    // not about what this commit had to flip.
    const rows = TEN.map((r, i) => ({ ...r, unread: i !== 1 && i !== 3 }));
    await mountReads(rows);
    await wheelStream(400);
    await unmount();
    expect(commits).toEqual([
      { upToId: "r0", messageIds: ["r0", "r2", "r4"] },
    ]);
  });

  it("PROGRAMMATIC NAVIGATION WRITES NOTHING — the userHasDriven gate holds at the exit too", async () => {
    // A jump from Search scrolls the stream to r5 and the reader leaves without ever
    // touching the scroller. `\Seen` writes to the user's real IMAP server and the line is
    // the pile's only newness signal: a visit nobody drove may move neither. Delete the
    // `drove` check in the view's leave handler (or report `true` from `StreamShell`) and
    // this goes red with a commit nobody earned.
    await mountReads(TEN, { jump: "r5" });
    await act(async () => { vi.advanceTimersByTime(40); });
    await unmount();
    expect(commits).toEqual([]);
    expect(marked).toEqual([]);
  });

  it("Receipts commits through ITS OWN seam, same shape", async () => {
    // The engine-side guard proves view independence (a receipts commit cannot move Reads'
    // line); this proves the Receipts VIEW actually produces the commit — anchored and
    // bounded exactly as Reads' — so the pair `AppShell` binds (`commitFeedSeen("receipts")`)
    // has something real arriving at it.
    await mountReceipts(TEN);
    await wheelStream(400);
    await unmount();
    expect(commits).toEqual([
      { upToId: "r0", messageIds: ["r0", "r1", "r2", "r3", "r4"] },
    ]);
  });
});

describe("a far jump ends the tracked run: nothing the visit never displayed is marked", () => {
  /** The cards on screen at the offset the stream rests on now. */
  const onScreen = (): Set<string> => new Set(streamCards(streamEl()).filter((c) => {
    const r = rectFor(c);
    return r.bottom > 0 && r.top < VIEW_H;
  }).map((c) => c.dataset.sid!));
  const FORTY: Row[] = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, unread: true }));

  it("leave after a far jump and one wheel commits only what was on screen after the landing", async () => {
    await mountReadsLive(FORTY, "r30");
    const landed = scrollTops.get(streamEl()) ?? 0;
    expect(landed, "control: the jump went deep").toBeGreaterThan(5000);
    displayed = onScreen();
    await wheelStream(landed + 100);
    await unmount();
    expect(commits[0]!.messageIds.filter((id) => !displayed.has(id))).toEqual([]);
    // The run starts at the landing (r29 straddles the top at rest) and ends with the wheel's screen.
    expect(commits).toEqual([{ upToId: "r29", messageIds: ["r29", "r30", "r31", "r32", "r33"] }]);
  });

  it("after a far jump and a wheel, the seen observer marks no card mounted above the landing", async () => {
    vi.stubGlobal("IntersectionObserver", DeliveringIO);
    await mountReadsLive(FORTY, "r30");
    const landed = scrollTops.get(streamEl()) ?? 0;
    displayed = onScreen();
    await wheelStream(landed + 100);
    for (let i = 0; i < 10; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    expect(marked.filter((id) => !displayed.has(id))).toEqual([]);
    // What the wheel lifted past the line, from the landed screen: r29 and r30.
    expect(marked).toEqual(["r29", "r30"]);
  });

  it("a scrollbar drag to the end after a wheel commits only the screen it rests on", async () => {
    pileSize = 40;
    await mountReads(FORTY);
    await wheelStream(100);
    await leapStream(2400, 4800, 7400);
    await unmount();
    expect(commits[0]!.messageIds.filter((id) => !displayed.has(id))).toEqual([]);
    expect(commits).toEqual([{ upToId: "r37", messageIds: ["r37", "r38", "r39"] }]);
  });

  it("End over frames moves the cursor once and marks and commits only the end screen", async () => {
    vi.stubGlobal("IntersectionObserver", DeliveringIO);
    await mountReadsLive(FORTY, null);
    curs = [];
    marked = [];
    const el = streamEl();
    await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })); });
    for (const top of [222, 888, 2220, 4070, 5550, 6660, 7178, 7400]) {
      await act(async () => { setStreamScroll(el, top); });
      await act(async () => { vi.advanceTimersByTime(16); });
    }
    for (let i = 0; i < 20; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    const endScreen = ["r37", "r38", "r39"];
    expect({ curs, offScreen: marked.filter((id) => !endScreen.includes(id)) }).toEqual({ curs: ["r39"], offScreen: [] });
    await unmount();
    expect(commits).toEqual([{ upToId: "r37", messageIds: endScreen }]);
  });

  /**
   * End with focus in r0's letter, over frames; 100ms after its last scroll the cards from r37 on
   * re-measure 28px shorter above, and the stream's own anchoring takes it 28px back up, off the end.
   * The landing still rests 150ms after End's last scroll, on the screen there: r36's foot to r39.
   */
  async function endInLetter(frame: HTMLIFrameElement): Promise<void> {
    const { LANDING_QUIET_MS } = await import("@ohmail/ui");
    vi.stubGlobal("IntersectionObserver", DeliveringIO);
    await mountReadsLive(FORTY, null);
    const el = streamEl();
    await act(async () => { el.dispatchEvent(new Event("wheel", { bubbles: true })); });
    for (let i = 0; i < 20; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    el.querySelector('.scast[data-sid="r0"]')!.appendChild(frame);
    frame.focus();
    expect(document.activeElement, "control: focus is in the letter's frame").toBe(frame);
    curs = [];
    marked = [];
    const doc = frame.contentDocument!;
    const End = () => new (doc.defaultView as typeof window).KeyboardEvent("keydown", { key: "End", bubbles: true });
    await act(async () => { doc.body.dispatchEvent(End()); });
    for (const top of [222, 888, 2220, 4070, 5550, 6660, 7178, 7400]) {
      await act(async () => { setStreamScroll(el, top); });
      await act(async () => { vi.advanceTimersByTime(16); });
    }
    await act(async () => { vi.advanceTimersByTime(84); });
    shift = { from: 37, by: -28 };
    await act(async () => { vi.advanceTimersByTime(20); });
    expect(scrollTops.get(el), "control: the stream's anchoring took it off the end").toBe(7372);
    await act(async () => { vi.advanceTimersByTime(LANDING_QUIET_MS - 100); });
    expect(marked, "rested while the stream was correcting itself").toEqual(["r36", "r37"]);
    for (let i = 0; i < 20; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    expect({ curs, marked }).toEqual({ curs: ["r37"], marked: ["r36", "r37"] });
    await unmount();
    expect(commits).toEqual([{ upToId: "r36", messageIds: ["r36", "r37", "r38", "r39"] }]);
  }

  it("a dwell that comes due while End is in flight marks nothing End carried off the screen", async () => {
    vi.stubGlobal("IntersectionObserver", DeliveringIO);
    await mountReadsLive(FORTY, null);
    const el = streamEl();
    await wheelStream(150); // the cursor settles on r1, its foot still below the line: its 2s dwell starts
    expect(marked, "control: the band marked r0, not r1").toEqual(["r0"]);
    marked = [];
    await act(async () => { vi.advanceTimersByTime(1800); });
    await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })); });
    for (const top of [222, 888, 2220, 4070, 5550, 6660, 7178, 7400]) {
      await act(async () => { setStreamScroll(el, top); });
      await act(async () => { vi.advanceTimersByTime(16); });
    }
    for (let i = 0; i < 20; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    expect(marked.filter((id) => !["r37", "r38", "r39"].includes(id))).toEqual([]);
  });

  it("End typed inside a letter's frame lands on the screen it rests on, though the stream corrects it off the end", async () => {
    await endInLetter(document.createElement("iframe"));
  });

  it("a wheel over a letter with focus in it marks and commits the cards it scrolls past", async () => {
    vi.stubGlobal("IntersectionObserver", DeliveringIO);
    await mountReadsLive(FORTY, null);
    const el = streamEl();
    await act(async () => { el.dispatchEvent(new Event("wheel", { bubbles: true })); });
    for (let i = 0; i < 20; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    const frame = document.createElement("iframe");
    el.querySelector('.scast[data-sid="r0"]')!.appendChild(frame);
    frame.focus();
    marked = [];
    // Chromium hands a wheel over a letter to the letter's own document; the stream only scrolls.
    const letter = frame.contentDocument!;
    for (let top = 100; top <= 2400; top += 100) {
      await act(async () => { letter.body.dispatchEvent(new (letter.defaultView as typeof window).WheelEvent("wheel", { bubbles: true })); });
      await act(async () => { setStreamScroll(el, top); });
      await act(async () => { vi.advanceTimersByTime(16); });
    }
    for (let i = 0; i < 20; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    const past = Array.from({ length: 13 }, (_, i) => `r${i}`);
    expect(marked).toEqual(past);
    await unmount();
    expect(commits).toEqual([{ upToId: "r0", messageIds: [...past, "r13", "r14"] }]);
  });

  it("End after a scroll key commits only the end screen, in Receipts too", async () => {
    pileSize = 40;
    await mountReceipts(FORTY);
    await act(async () => { streamEl().dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })); });
    await leapStream(7400);
    await unmount();
    expect(commits).toEqual([{ upToId: "r37", messageIds: ["r37", "r38", "r39"] }]);
  });

  it("a drag back up past unseen cards starts the run where it rests", async () => {
    pileSize = 40;
    await mountReads(FORTY);
    await wheelStream(100);
    await leapStream(6000);
    await wheelStream(6100);
    await leapStream(1200);
    await unmount();
    expect(commits).toEqual([{ upToId: "r6", messageIds: ["r6", "r7", "r8"] }]);
  });
});

describe("WebKit: a scroll from a letter the app cannot hear is judged by the read rule", () => {
  const FORTY: Row[] = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, unread: true }));
  const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `r${from + i}`);

  /** A wheel's read down to `top` (a wheel alone at 0), then focus in `card`'s letter, which runs no listener of the app's. */
  async function deafReader(top: number, card = "r0"): Promise<Element> {
    vi.stubGlobal("IntersectionObserver", DeliveringIO);
    await mountReadsLive(FORTY, null);
    const el = streamEl();
    if (top > 0) await wheelStream(top);
    else await act(async () => { el.dispatchEvent(new Event("wheel", { bubbles: true })); });
    await act(async () => { vi.advanceTimersByTime(400); });
    const frame = document.createElement("iframe");
    const doc = document.implementation.createHTMLDocument("letter");
    Object.defineProperty(doc, "addEventListener", { value: () => {} });
    Object.defineProperty(frame, "contentDocument", { configurable: true, get: () => doc });
    el.querySelector(`.scast[data-sid="${card}"]`)!.appendChild(frame);
    frame.focus();
    expect(document.activeElement, "control: focus is in the letter's frame").toBe(frame);
    curs = [];
    return el;
  }

  /** The pane carried by keys the app never hears: one offset per `ms`, then a second to settle. */
  async function unheard(el: Element, offsets: number[], ms: number): Promise<void> {
    for (const top of offsets) {
      await act(async () => { setStreamScroll(el, top); });
      await act(async () => { vi.advanceTimersByTime(ms); });
    }
    for (let i = 0; i < 10; i += 1) await act(async () => { vi.advanceTimersByTime(100); });
  }

  it("ArrowDown held at a pace that keeps each letter's first lines 0.7s on screen marks them, and the leave covers them", async () => {
    const el = await deafReader(0);
    marked = [];
    await unheard(el, Array.from({ length: 50 }, (_, i) => 40 * (i + 1)), 100);
    expect(marked).toEqual(ids(2, 12));
    await unmount();
    expect(commits).toEqual([{ upToId: "r0", messageIds: ids(0, 12) }]);
  });

  it("End marks only the screen it rests on, and the leave covers none of the letters it flew past", async () => {
    const el = await deafReader(0);
    marked = [];
    await unheard(el, [222, 888, 2220, 4070, 5550, 6660, 7178, 7400], 16);
    expect({ curs, marked }).toEqual({ curs: ["r39"], marked: ["r37", "r38", "r39"] });
    await unmount();
    expect(commits).toEqual([{ upToId: "r0", messageIds: [...ids(0, 2), ...ids(37, 39)] }]);
  });

  it("PageDown pressed six times 120ms apart marks only what stayed 0.7s on screen", async () => {
    const el = await deafReader(0);
    marked = [];
    // Each page (525px) animated over four frames, the next press as it ends.
    await unheard(el, Array.from({ length: 24 }, (_, i) => Math.round(131.25 * (i + 1))), 30);
    expect(marked).toEqual(["r16", "r17", "r18"]);
    await unmount();
    expect(commits).toEqual([{ upToId: "r0", messageIds: [...ids(0, 2), ...ids(15, 18)] }]);
  });

  it("what a wheel read before such a scroll stays in the leave", async () => {
    const el = await deafReader(400, "r3");
    expect(marked, "control: the wheel lifted r0-r2 past the band; r3 and r4 wait for the leave").toEqual(ids(0, 2));
    await unheard(el, [622, 1288, 2620, 4470, 5950, 6900, 7300, 7400], 16);
    await unmount();
    expect(commits).toEqual([{ upToId: "r0", messageIds: [...ids(0, 4), ...ids(37, 39)] }]);
  });
});

describe("the streams are dotless; the sweep's attribute survives", () => {
  it("Reads renders NO unread dot anywhere — rows and cards keep data-unseen for the observer", async () => {
    await mountReads(TEN);
    expect(host!.querySelectorAll(".dot-unread")).toHaveLength(0);
    // The eventual \Seen sweep still has its hook: every unread row and card is observable.
    expect(host!.querySelectorAll(".row[data-unseen]").length).toBeGreaterThan(0);
    expect(host!.querySelectorAll(".scast[data-unseen]").length).toBeGreaterThan(0);
  });

  it("Receipts renders NO unread dot either, and draws ITS OWN waterline at the junction", async () => {
    await mountReceipts(TEN, { waterline: { newestSeenId: "r5", at: "2026-08-01T18:40:00.000Z" }, freshCount: 5 });
    expect(host!.querySelectorAll(".dot-unread")).toHaveLength(0);
    expect(host!.querySelectorAll(".row[data-unseen]").length).toBeGreaterThan(0);
    // One line in the list, one in the stream — the single newness signal, now in Receipts too.
    expect(host!.querySelectorAll(".waterline").length).toBe(2);
  });

  it("the Ohbox's row contract is untouched: without `dotless` the dot renders", async () => {
    // The shared row component still dots — dropping the dot is the STREAMS' choice, made
    // at their call sites, not a change to what every other list renders.
    const { MessageRow } = await import("@ohmail/ui");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(MessageRow as never, { id: "x", from: "A", subject: "s", unread: true } as never));
    });
    expect(host!.querySelectorAll(".dot-unread")).toHaveLength(1);
    expect(host!.querySelector(".row[data-unseen]")).not.toBeNull();
  });
});
