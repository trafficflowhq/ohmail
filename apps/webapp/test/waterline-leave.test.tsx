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
/** Lay out the cards' sender lines and texts (the read rule's marks). */
let inner = false;
/** A letter that grows lengthens the pile; a shorter re-measure leaves its height as guessed. */
const shiftBelow = (): number => (shift.from < pileSize ? Math.max(0, shift.by) : 0);

function streamCards(stream: Element): HTMLElement[] {
  return [...stream.querySelectorAll<HTMLElement>(".scast[data-sid]")];
}

/** A letter answered in place is its conversation: taller, and taller still with the dock open. */
const grown = (el: Element): number =>
  !el.classList.contains("in-place") ? 0 : el.querySelector(".reply-dock") ? 700 : 300;
const grownAbove = (stream: Element, i: number): number =>
  [...stream.querySelectorAll<HTMLElement>(".scast.in-place")]
    .filter((c) => Number(c.dataset.sid?.slice(1)) < i)
    .reduce((y, c) => y + grown(c), 0);

/** `.stream` is the viewport; each `.scast` sits at its index times CARD_H, minus the offset. */
function rectFor(el: Element): DOMRect {
  const zero = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
  // A card's sender line [top+16, top+36] and its text [top+70, foot-30], where a test lays them out.
  const part = (el as HTMLElement).classList?.contains("sc-line") ? "line" : (el as HTMLElement).classList?.contains("sc-clip") ? "clip" : null;
  if (inner && part) {
    const card = el.closest(".scast");
    if (!card) return zero as DOMRect;
    const c = rectFor(card);
    const [top, bottom] = part === "line" ? [c.top + 16, c.top + 36] : [c.top + 70, c.bottom - 30];
    return { ...zero, top, bottom, height: bottom - top } as DOMRect;
  }
  if ((el as HTMLElement).classList?.contains("stream")) {
    return { ...zero, top: 0, bottom: VIEW_H, height: VIEW_H } as DOMRect;
  }
  if ((el as HTMLElement).classList?.contains("scast")) {
    const stream = el.closest(".stream");
    if (!stream) return zero as DOMRect;
    // Placed at its PILE index (the ids are r<index>), so the window may mount any run of it.
    const i = Number((el as HTMLElement).dataset.sid?.slice(1));
    if (!Number.isFinite(i)) return zero as DOMRect;
    const top = i * CARD_H + (i >= shift.from ? shift.by : 0) + grownAbove(stream, i) - (scrollTops.get(stream) ?? 0);
    const height = CARD_H + grown(el);
    return { ...zero, top, bottom: top + height, height } as DOMRect;
  }
  return zero as DOMRect;
}

/** Adds the mounted cards inside the viewport now to `displayed`. */
function noteDisplayed(stream: Element): void {
  for (const c of streamCards(stream)) {
    const r = rectFor(c);
    if (r.bottom > 0 && r.top < VIEW_H) displayed.add(c.dataset.sid!);
  }
}

function setStreamScroll(stream: Element, next: number): void {
  const max = Math.max(0, pileSize * CARD_H + shiftBelow() + grownAbove(stream, pileSize) - VIEW_H);
  scrollTops.set(stream, Math.min(Math.max(0, next), max));
  noteDisplayed(stream);
  stream.dispatchEvent(new Event("scroll"));
  for (const io of DeliveringIO.live) io.deliver(stream);
}

/** The timestamp the current frame's callbacks got (`stampFrames`). */
let frameTs = 0;
/** Every callback of one frame gets one timestamp on `performance.now()`'s clock, as a browser hands it. */
function stampFrames(): void {
  const raf = requestAnimationFrame;
  let tick = NaN;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => raf((ts) => {
    if (ts !== tick) { tick = ts; frameTs = performance.now(); }
    cb(frameTs);
  }));
}

/** Reports what the browser would: every target when first observed, and after each move. */
class DeliveringIO {
  static live = new Set<DeliveringIO>();
  /** A report's `time`: when it is recorded (Chromium), or its frame's timestamp (WebKit, Firefox). */
  static stamp: "now" | "frame" = "now";
  private targets = new Set<Element>();
  constructor(private cb: IntersectionObserverCallback, private opts: IntersectionObserverInit = {}) {
    DeliveringIO.live.add(this);
  }
  observe(t: Element): void {
    this.targets.add(t);
    if (this.opts.root) this.take(this.opts.root as Element, [t])();
  }
  unobserve(t: Element): void { this.targets.delete(t); }
  disconnect(): void { this.targets.clear(); }
  takeRecords(): IntersectionObserverEntry[] { return []; }
  deliver(root: Element): void {
    this.take(root)();
  }
  /** Records this frame's report; the call it returns hands it over, as the browser's task does, maybe a frame later. */
  take(root: Element, targets = [...this.targets]): () => void {
    const live = this.opts.root === root ? targets.filter((t) => t.isConnected) : [];
    // Only the bottom margin is ever a percentage here ("0px 0px -62% 0px", "100% 0px").
    const m = (this.opts.rootMargin ?? "0px").trim().split(/\s+/);
    const cut = (v: string | undefined) => (v?.endsWith("%") ? (parseFloat(v) / 100) * VIEW_H : parseFloat(v ?? "0") || 0);
    const band = { top: -cut(m[0]), bottom: VIEW_H + cut(m[2] ?? m[0]) };
    const time = DeliveringIO.stamp === "frame" ? frameTs : performance.now();
    const entries = live.map((target) => {
      const b = rectFor(target);
      const isIntersecting = b.height > 0 && b.bottom > band.top && b.top < band.bottom;
      return { target, boundingClientRect: b, rootBounds: { ...b, top: band.top, bottom: band.bottom }, isIntersecting, time } as unknown as IntersectionObserverEntry;
    });
    return () => { if (entries.length > 0) this.cb(entries, this as unknown as IntersectionObserver); };
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
  opts: { jump?: string; waterline?: { newestSeenId: string; at?: string }; freshCount?: number; full?: boolean } = {},
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
    bodyOf: (m: { snippet: string }) => ({ text: m.snippet, state: opts.full ? "full" : "snippet", html: null, loadedRemoteContent: false }),
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

/** A move with no input event of its own (a scrollbar-thumb drag, or End): one scroll per offset,
 *  then the frames a flight needs to land (the stream holds its window while it flies). */
async function leapStream(...offsets: number[]): Promise<void> {
  for (const top of offsets) {
    await act(async () => { setStreamScroll(streamEl(), top); });
    await act(async () => { vi.advanceTimersByTime(20); });
  }
  for (let i = 0; i < 5; i += 1) await act(async () => { vi.advanceTimersByTime(16); });
  noteDisplayed(streamEl()); // the cards it mounted where it rests
}

/** Renders mountReadsLive's view again, as a body landing does. */
let rerenderLive: () => void = () => {};
/** The mailbox turns a message of mountReadsLive's view read or unread (a Mark unread, as the mirror reports it). */
let setUnreadLive: (id: string, unread: boolean) => void = () => {};

/**
 * A view whose cursor and jump live in the shell, as AppShell holds them: `onCur` and
 * `onJumped` re-render, so the stream re-renders around a jump the way it does in the app.
 */
async function mountReadsLive(rows: Row[], jump: string | null, { full = false, enters = false } = {}): Promise<void> {
  await unmount();
  const { ReadsView } = await import("../app/views/ReadsView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  pileSize = rows.length;
  let cur: string | null = null;
  let jumpTo: string | null = jump;
  let fresh = rows.map((r) => msg(r, "ohmail/News"));
  const tree = (): React.ReactNode => wrap(h(ReadsView as never, {
    settled: true, owed: false,
    partition: { waterline: null, fresh, seen: [], newCount: rows.length },
    tags: [], now: NOW, cur, onCur: (id: string) => { curs.push(id); cur = id; root?.render(tree()); },
    aiChip: null, chipState: null, onChipState: () => {},
    markSeen: (id: string) => { marked.push(id); },
    onLeaveSeen: (c: { upToId: string; messageIds: string[] }) => { commits.push(c); },
    bodyOf: (m: { snippet: string }) => ({ text: m.snippet, state: full ? "full" : "snippet", html: null, loadedRemoteContent: false }),
    hydrateBody: () => {}, onAction: () => {},
    jumpTo, jumpEnters: enters, onJumped: () => { jumpTo = null; root?.render(tree()); },
  } as never), KeymapProvider);
  rerenderLive = () => root?.render(tree());
  setUnreadLive = (id, unread) => {
    fresh = fresh.map((m) => (m.id === id ? { ...m, unread } : m));
    root?.render(tree());
  };
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
  inner = false;
  displayed = new Set();
  shift = { from: Infinity, by: 0 };
  DeliveringIO.live = new Set();
  DeliveringIO.stamp = "now";
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
    configurable: true, get(this: Element) { return isStream(this) ? pileSize * CARD_H + shiftBelow() + grownAbove(this, pileSize) : 0; },
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
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const TEN: Row[] = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, unread: true }));

/** The band reports, the cards' sender lines and texts are laid out and the window has focus: the read rule can read. */
function readable(): void {
  vi.stubGlobal("IntersectionObserver", DeliveringIO);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  inner = true;
}
/** A rest past the rule's 0.7s. */
const rest = async (ms = 800): Promise<void> => { await act(async () => { vi.advanceTimersByTime(ms); }); };

/* ── the guards ────────────────────────────────────────────────────────────────────────── */

describe("leaving commits the waterline — once, anchored, bounded", () => {
  it("THE STRUCTURAL MISS, CLOSED: leave at the bottom ⇒ one commit, anchored at the top, covering the last screenful", async () => {
    // Scroll to the very bottom and leave. The last screenful (r7–r9) never exits through
    // the top, so the observer model alone never marks it — the commit must. The anchor is
    // r0, the newest card the visit displayed, which puts the line above everything.
    // Break `StreamShell`'s unmount cleanup (or the view's range arithmetic) and this is red.
    readable();
    await mountReads(TEN);
    await wheelStream(1400); // max: 10 cards × 200 − 600
    await rest();
    await unmount();
    expect(commits).toEqual([
      { upToId: "r0", messageIds: ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"] },
    ]);
  });

  it("BOUNDED by what was displayed — never the pile", async () => {
    // A partial read: 400px in, the final screen shows r2–r4. The commit covers r0–r4 (the
    // contiguous run the visit displayed) and NOT r5–r9, which never entered the viewport.
    // Widen the slice in the view's leave handler to the whole pile and this goes red.
    readable();
    await mountReads(TEN);
    await wheelStream(400);
    await rest();
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
    readable();
    await mountReads(rows);
    await wheelStream(400);
    await rest();
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
    readable();
    await mountReceipts(TEN);
    await wheelStream(400);
    await rest();
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
    readable();
    await mountReadsLive(FORTY, "r30");
    const landed = scrollTops.get(streamEl()) ?? 0;
    expect(landed, "control: the jump went deep").toBeGreaterThan(5000);
    displayed = onScreen();
    await wheelStream(landed + 100);
    await rest();
    await unmount();
    expect(commits[0]!.messageIds.filter((id) => !displayed.has(id))).toEqual([]);
    // The run starts at the landing (r29 straddles the top at rest, only its foot on screen); r33 shows only its sender line at the foot.
    expect(commits).toEqual([{ upToId: "r29", messageIds: ["r30", "r31", "r32"] }]);
  });

  it("after a far jump and a wheel, the seen observer marks no card mounted above the landing", async () => {
    vi.stubGlobal("IntersectionObserver", DeliveringIO);
    await mountReadsLive(FORTY, "r30");
    const landed = scrollTops.get(streamEl()) ?? 0;
    displayed = onScreen();
    await wheelStream(landed + 100);
    for (let i = 0; i < 10; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    expect(marked.filter((id) => !displayed.has(id))).toEqual([]);
    // What the wheel lifted past the line, from the landed screen: r30 (r29 showed only its foot).
    expect(marked).toEqual(["r30"]);
  });

  it("a scrollbar drag to the end after a wheel commits only the screen it rests on", async () => {
    pileSize = 40;
    readable();
    await mountReads(FORTY);
    await wheelStream(100);
    await leapStream(2400, 4800, 7400);
    await rest();
    await unmount();
    expect(commits[0]!.messageIds.filter((id) => !displayed.has(id))).toEqual([]);
    expect(commits).toEqual([{ upToId: "r37", messageIds: ["r37", "r38", "r39"] }]);
  });

  const drags: Array<{ to: string; path: number[]; after: { curs: string[]; top: number; marked: string[] } }> = [
    { to: "mid-pile", path: [1200, 2400, 3600, 4800, 4840, 4880, 4900], after: { curs: ["r6", "r12", "r18", "r24", "r25"], top: 4986, marked: [] } },
    { to: "the end", path: [2400, 4800, 7000, 7300, 7400], after: { curs: ["r12", "r39"], top: 7400, marked: [] } },
  ];
  for (const { to, path, after } of drags) {
    it(`a scrollbar drag to ${to} rests the cursor on a card of the screen it shows, never one off it, and j starts from there`, async () => {
      await mountReadsLive(FORTY, null);
      await wheelStream(100);
      curs = [];
      await leapStream(...path);
      marked = [];
      await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true })); });
      for (let i = 0; i < 10; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
      expect({ curs, top: scrollTops.get(streamEl()), marked }).toEqual(after);
    });
  }

  it("End over frames moves the cursor once and marks and commits only the end screen", async () => {
    readable();
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
    await rest();
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
    readable();
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
    // Frame by frame: the stream mounts the end window once the flight has rested two frames.
    for (const ms of [16, 16, 16, 16, 20]) await act(async () => { vi.advanceTimersByTime(ms); });
    shift = { from: 37, by: -28 };
    await act(async () => { vi.advanceTimersByTime(20); });
    expect(scrollTops.get(el), "control: the stream's anchoring took it off the end").toBe(7372);
    await act(async () => { vi.advanceTimersByTime(LANDING_QUIET_MS - 100); });
    // r36 shows only its foot.
    expect(marked, "rested while the stream was correcting itself").toEqual(["r37"]);
    for (let i = 0; i < 20; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    expect({ curs, marked }).toEqual({ curs: ["r37"], marked: ["r37"] });
    await rest();
    await unmount();
    expect(commits).toEqual([{ upToId: "r36", messageIds: ["r37", "r38", "r39"] }]);
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
    readable();
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
    await rest();
    await unmount();
    expect(commits).toEqual([{ upToId: "r0", messageIds: [...past, "r13", "r14"] }]);
  });

  it("End after a scroll key commits only the end screen, in Receipts too", async () => {
    pileSize = 40;
    readable();
    await mountReceipts(FORTY);
    // A wheel first: this harness's static mount mounts the end window only once the stream was driven.
    await wheelStream(100);
    await act(async () => { streamEl().dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })); });
    await leapStream(7400);
    await rest();
    await unmount();
    expect(commits).toEqual([{ upToId: "r37", messageIds: ["r37", "r38", "r39"] }]);
  });

  it("a drag back up past unseen cards starts the run where it rests", async () => {
    pileSize = 40;
    readable();
    await mountReads(FORTY);
    await wheelStream(100);
    await leapStream(6000);
    await wheelStream(6100);
    await leapStream(1200);
    await rest();
    await unmount();
    expect(commits).toEqual([{ upToId: "r6", messageIds: ["r6", "r7", "r8"] }]);
  });
});

const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `r${from + i}`);

/** The pane carried by keys the app never hears: one offset per `ms`, then a second to settle. */
async function unheard(el: Element, offsets: number[], ms: number): Promise<void> {
  for (const top of offsets) {
    await act(async () => { setStreamScroll(el, top); });
    await act(async () => { vi.advanceTimersByTime(ms); });
  }
  for (let i = 0; i < 10; i += 1) await act(async () => { vi.advanceTimersByTime(100); });
}

/** r35's letter lands after End rested: everything from r36 down moves 300px, and the next frame re-anchors. */
async function aboveGrows(el: Element): Promise<void> {
  shift = { from: 36, by: 300 };
  await act(async () => { rerenderLive(); });
  for (let i = 0; i < 5; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
  expect(scrollTops.get(el), "control: the stream re-anchored the resting screen").toBe(7700);
}

/** r<letter>'s body still landing: on every frame, after the stream's own, it grows `px` more. Returns its stop,
 *  which leaves no frame callback behind (jsdom runs frames only while none was left over from a test before). */
function stillLanding(letter: number, px: number): () => void {
  let raf = 0;
  const grow = (): void => {
    shift = { from: letter + 1, by: (shift.from === letter + 1 ? shift.by : 0) + px };
    raf = requestAnimationFrame(grow);
  };
  raf = requestAnimationFrame(grow);
  return () => cancelAnimationFrame(raf);
}

describe("WebKit: a scroll from a letter the app cannot hear is judged by the read rule", () => {
  const FORTY: Row[] = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, unread: true }));

  /** A wheel's read down to `top` (a wheel alone at 0, or none), then focus in `card`'s letter, which runs no listener of the app's. */
  async function deafReader(top: number, card = "r0", { wheel = true } = {}): Promise<Element> {
    vi.stubGlobal("IntersectionObserver", DeliveringIO);
    await mountReadsLive(FORTY, null);
    const el = streamEl();
    if (top > 0) await wheelStream(top);
    else if (wheel) await act(async () => { el.dispatchEvent(new Event("wheel", { bubbles: true })); });
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

  for (const wheel of [true, false]) it(`ArrowDown held at a pace that keeps each letter's first lines 0.7s on screen marks them, and the leave covers them${wheel ? "" : ", with no wheel before it"}`, async () => {
    const el = await deafReader(0, "r0", { wheel });
    marked = [];
    await unheard(el, Array.from({ length: 50 }, (_, i) => 40 * (i + 1)), 100);
    expect(marked).toEqual(ids(2, 12));
    await unmount();
    expect(commits).toEqual([{ upToId: "r0", messageIds: ids(2, 12) }]);
  });

  for (const wheel of [true, false]) it(`End marks only the screen it rests on, and the leave covers none of the letters it flew past${wheel ? "" : ", with no wheel before it"}`, async () => {
    const el = await deafReader(0, "r0", { wheel });
    marked = [];
    await unheard(el, [222, 888, 2220, 4070, 5550, 6660, 7178, 7400], 16);
    expect({ curs, marked }).toEqual({ curs: ["r39"], marked: ["r37", "r38", "r39"] });
    await unmount();
    expect(commits).toEqual([{ upToId: "r0", messageIds: ids(37, 39) }]);
  });

  for (const wheel of [true, false]) it(`PageDown pressed six times 120ms apart marks only what stayed 0.7s on screen${wheel ? "" : ", with no wheel before it"}`, async () => {
    const el = await deafReader(0, "r0", { wheel });
    marked = [];
    // Each page (525px) animated over four frames, the next press as it ends.
    await unheard(el, Array.from({ length: 24 }, (_, i) => Math.round(131.25 * (i + 1))), 30);
    expect(marked).toEqual(["r16", "r17", "r18"]);
    await unmount();
    expect(commits).toEqual([{ upToId: "r0", messageIds: ids(16, 18) }]);
  });

  it("what a wheel read before such a scroll stays in the leave", async () => {
    const el = await deafReader(400, "r3");
    expect(marked, "control: the wheel lifted r0-r2 past the band; r3 and r4 wait for the leave").toEqual(ids(0, 2));
    await unheard(el, [622, 1288, 2620, 4470, 5950, 6900, 7300, 7400], 16);
    await unmount();
    expect(commits).toEqual([{ upToId: "r0", messageIds: [...ids(0, 2), ...ids(37, 39)] }]);
  });

  it("a letter above the resting screen that grows as its body lands is not committed", async () => {
    const el = await deafReader(400, "r3");
    await unheard(el, [622, 1288, 2620, 4470, 5950, 6900, 7300, 7400], 16);
    await aboveGrows(el);
    await unmount();
    expect(commits).toEqual([{ upToId: "r0", messageIds: [...ids(0, 2), ...ids(37, 39)] }]);
  });

  it("End's resting screen still turns read when its letters come due while a letter above it is still landing", async () => {
    const el = await deafReader(0, "r0", { wheel: false });
    marked = [];
    for (const top of [222, 888, 2220, 4070, 5550, 6660, 7178, 7400]) {
      await act(async () => { setStreamScroll(el, top); });
      await act(async () => { vi.advanceTimersByTime(16); });
    }
    // The clocks started with the last scroll; r36 lands over the 0.7s they come due at, on each frame
    // pushing r39's first lines off the foot until the stream puts the screen back. Frame by frame: the
    // stream's window may mount the end cards only once the flight has rested.
    for (let i = 0; i < 25; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    const stop = stillLanding(36, 80);
    for (let i = 0; i < 15; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    stop();
    for (let i = 0; i < 10; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    expect(marked).toEqual(ids(37, 39));
    await unmount();
    expect(commits).toEqual([{ upToId: "r0", messageIds: ids(37, 39) }]);
  });
});

describe("a scroll key the pane never hears, after a press in it", () => {
  const FORTY: Row[] = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, unread: true }));

  it("PageDown with nothing focused reads like PageDown on the pane", async () => {
    readable();
    await mountReadsLive(FORTY, null);
    const el = streamEl();
    await act(async () => { vi.advanceTimersByTime(400); });
    await act(async () => { el.querySelector('.scast[data-sid="r0"] h3')!.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    marked = [];
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true })); });
    await unheard(el, [150, 300, 450, 600], 30);
    await rest();
    await unmount();
    expect({ marked, commits }).toEqual({ marked: ids(0, 3), commits: [{ upToId: "r0", messageIds: ids(0, 5) }] });
  });

  it("PageDown typed in a letter the app hears reads the same", async () => {
    readable();
    await mountReadsLive(FORTY, null);
    const el = streamEl();
    await act(async () => { vi.advanceTimersByTime(400); });
    const frame = document.createElement("iframe");
    el.querySelector('.scast[data-sid="r0"]')!.appendChild(frame);
    frame.focus();
    marked = [];
    const letter = frame.contentDocument!;
    await act(async () => { letter.body.dispatchEvent(new (letter.defaultView as typeof window).KeyboardEvent("keydown", { key: "PageDown", bubbles: true })); });
    await unheard(el, [150, 300, 450, 600], 30);
    await rest();
    await unmount();
    expect({ marked, commits }).toEqual({ marked: ids(0, 3), commits: [{ upToId: "r0", messageIds: ids(0, 5) }] });
  });
});

describe("after End rests, a frame the stream has not re-anchored yet is nobody's read", () => {
  const FORTY: Row[] = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, unread: true }));

  /** A wheel read down to r4, a pause, then End heard over frames, resting on r37-r39. */
  async function wheelThenEnd(): Promise<Element> {
    readable();
    await mountReadsLive(FORTY, null);
    const el = streamEl();
    await wheelStream(900);
    await act(async () => { vi.advanceTimersByTime(3000); });
    await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })); });
    await leapStream(1300, 2220, 4070, 5550, 6660, 7178, 7400);
    for (let i = 0; i < 20; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    return el;
  }

  it("a letter above the resting screen that grows as its body lands is not committed", async () => {
    await aboveGrows(await wheelThenEnd());
    await rest();
    await unmount();
    expect(commits).toEqual([{ upToId: "r37", messageIds: ids(37, 39) }]);
  });

  it("control: with no growth the leave commits the resting screen", async () => {
    await wheelThenEnd();
    await rest();
    await unmount();
    expect(commits).toEqual([{ upToId: "r37", messageIds: ids(37, 39) }]);
  });

  it("the band reported on that frame marks nothing", async () => {
    const el = await wheelThenEnd();
    marked = [];
    // r34's letter lands: r35 on move 400px down, and the band is reported before the stream re-anchors.
    shift = { from: 35, by: 400 };
    await act(async () => { for (const io of DeliveringIO.live) io.deliver(el); });
    for (let i = 0; i < 5; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    expect(scrollTops.get(el), "control: the stream re-anchored the resting screen").toBe(7800);
    // The re-anchored frame's own report: r35 and r36 left the band, which they never stood in.
    await act(async () => { for (const io of DeliveringIO.live) io.deliver(el); });
    expect(marked.filter((id) => id === "r35" || id === "r36")).toEqual([]);
  });

  it("a report recorded on that frame and handed over after the stream re-anchored marks nothing", async () => {
    const el = await wheelThenEnd();
    marked = [];
    shift = { from: 35, by: 400 };
    const late = [...DeliveringIO.live].map((io) => io.take(el));
    for (let i = 0; i < 5; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    expect(scrollTops.get(el), "control: the stream re-anchored the resting screen").toBe(7800);
    await act(async () => { for (const deliver of late) deliver(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    expect(marked.filter((id) => id === "r35" || id === "r36")).toEqual([]);
  });

  /** A wheel read, then End heard over frames, with r36 still landing over End's rest: what is read meanwhile. */
  async function endRestsWhileLanding(): Promise<string[]> {
    vi.stubGlobal("IntersectionObserver", DeliveringIO);
    await mountReadsLive(FORTY, null);
    const el = streamEl();
    await wheelStream(900);
    await act(async () => { vi.advanceTimersByTime(3000); });
    marked = [];
    await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })); });
    await leapStream(1300, 2220, 4070, 5550, 6660, 7178, 7400);
    const stop = stillLanding(36, 2); // over End's rest, 150ms after its last scroll
    for (let i = 0; i < 15; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    stop();
    return [...marked];
  }

  it("the band's report at rest, on a frame while a letter above is still landing, is read once the stream re-anchors", async () => {
    expect(await endRestsWhileLanding()).toEqual(["r37"]);
  });

  it("so it is where a report carries its frame's timestamp (WebKit, Firefox), the frame the stream re-anchors in", async () => {
    stampFrames();
    DeliveringIO.stamp = "frame";
    expect(await endRestsWhileLanding()).toEqual(["r37"]);
  });

  it("content that moves while the stream's anchoring rests stays where it is, and the band reads that frame", async () => {
    vi.stubGlobal("IntersectionObserver", DeliveringIO);
    await mountReadsLive(FORTY, null);
    const el = streamEl();
    await wheelStream(400);
    await act(async () => { vi.advanceTimersByTime(3000); });
    marked = [];
    shift = { from: 2, by: -180 }; // r1 lays out shorter (a late font), and nothing wakes the anchoring
    await act(async () => { for (const io of DeliveringIO.live) io.deliver(el); });
    for (let i = 0; i < 5; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    expect({ top: scrollTops.get(el), marked }).toEqual({ top: 400, marked: ["r3"] });
  });
});

describe("the read rule over every card on screen, after the reader's own scroll, press or open", () => {
  const FORTY: Row[] = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, unread: true }));
  async function laidOut(): Promise<Element> {
    vi.stubGlobal("IntersectionObserver", DeliveringIO);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    inner = true;
    await mountReadsLive(FORTY, null, { full: true });
    marked = [];
    return streamEl();
  }

  it("a press on a card's heading, no scroll: the cards whose first lines and sender line stood 0.7s turn read", async () => {
    const el = await laidOut();
    const h3 = el.querySelector('.scast[data-sid="r1"] h3')!;
    await act(async () => { h3.dispatchEvent(new Event("pointerdown", { bubbles: true })); (h3 as HTMLElement).click(); });
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(marked, "before the dwell").toEqual([]);
    for (let i = 0; i < 10; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    expect(marked).toEqual(["r0", "r1", "r2"]);
  });

  it("no press and no scroll: the first screen stays unread", async () => {
    await laidOut();
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(marked).toEqual([]);
  });

  it("a wheel that leaves a card whole on screen below the band and off the reading line: it turns read after 0.7s", async () => {
    await laidOut();
    await wheelStream(100);
    expect(marked, "control: the band took r0").toEqual(["r0"]);
    await act(async () => { vi.advanceTimersByTime(800); });
    expect(marked).toEqual(["r0", "r1", "r2"]);
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(marked.includes("r3"), "r3's first lines never stood on screen").toBe(false);
  });

  /** A letter in `card` whose document runs no listener of the app's (WebKit), with focus in it. */
  function deafLetter(el: Element, card: string): HTMLIFrameElement {
    const frame = document.createElement("iframe");
    const doc = document.implementation.createHTMLDocument("letter");
    Object.defineProperty(doc, "addEventListener", { value: () => {} });
    Object.defineProperty(frame, "contentDocument", { configurable: true, get: () => doc });
    el.querySelector(`.scast[data-sid="${card}"]`)!.appendChild(frame);
    return frame;
  }

  it("a press inside a letter (focus moves into its frame) enters the visit like a press on the card", async () => {
    const el = await laidOut();
    const frame = deafLetter(el, "r1");
    // As both engines report a press inside a letter: focus moves into its frame and the window blurs.
    await act(async () => { frame.focus(); window.dispatchEvent(new Event("blur")); });
    await act(async () => { vi.advanceTimersByTime(800); });
    expect(marked).toEqual(["r0", "r1", "r2"]);
  });

  it("a judged End commits only what the visit read: cards that flashed on screen at mount stay unread", async () => {
    const el = await laidOut();
    // r0's letter lands 100ms after the mount: r1 on move 1400px down, off the screen they flashed on.
    await act(async () => { vi.advanceTimersByTime(100); });
    shift = { from: 1, by: 1400 };
    await act(async () => { rerenderLive(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    const frame = deafLetter(el, "r0");
    await act(async () => { frame.focus(); window.dispatchEvent(new Event("blur")); });
    await act(async () => { vi.advanceTimersByTime(800); });
    expect(marked, "the letter read in place, by the rule").toEqual(["r0"]);
    const max = 40 * CARD_H + 1400 - VIEW_H;
    for (const top of [222, 888, 2220, 4070, 5550, 6660, 8100, max]) {
      await act(async () => { setStreamScroll(el, top); });
      await act(async () => { vi.advanceTimersByTime(16); });
    }
    for (let i = 0; i < 10; i += 1) await act(async () => { vi.advanceTimersByTime(100); });
    await unmount();
    expect(commits).toEqual([{ upToId: "r0", messageIds: ["r0", "r37", "r38", "r39"] }]);
  });

  it("↵ opening the card under the cursor enters the visit like a press", async () => {
    await laidOut();
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await act(async () => { vi.advanceTimersByTime(800); });
    expect(marked).toEqual(["r0", "r1", "r2"]);
  });

  it("↵ in Receipts enters the visit the same way", async () => {
    vi.stubGlobal("IntersectionObserver", DeliveringIO);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    inner = true;
    await mountReceipts(TEN, { full: true });
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(marked, "control: nothing before ↵").toEqual([]);
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await act(async () => { vi.advanceTimersByTime(800); });
    expect(marked).toEqual(["r0", "r1", "r2"]);
  });

  it("a letter marked unread before anything entered the visit stays unread once a press enters it", async () => {
    vi.stubGlobal("IntersectionObserver", DeliveringIO);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    inner = true;
    // A search opens r1, already read: the landing reads only its card, and enters nothing.
    await mountReadsLive(FORTY.map((r) => ({ ...r, unread: r.id !== "r1" })), "r1", { full: true, enters: true });
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(marked, "control: nothing read before the press").toEqual([]);
    await act(async () => { setUnreadLive("r1", true); });
    const clip = streamEl().querySelector<HTMLElement>('.scast[data-sid="r1"] .sc-clip')!;
    await act(async () => { clip.dispatchEvent(new Event("pointerdown", { bubbles: true })); clip.click(); });
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(marked.includes("r1"), "the Mark unread holds for the visit").toBe(false);
    expect(marked, "control: the press entered the visit").toEqual(["r2", "r3"]);
  });

  it("a press on a control in the stream, or j alone, enters nothing", async () => {
    const el = await laidOut();
    const hint = el.querySelector(".stream-hints");
    expect(hint, "control: the stream's hints, no card").not.toBeNull();
    await act(async () => { hint!.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true })); });
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(marked, "j reads only the letter it rests on, by the rule").toEqual(["r1"]);
  });

  /* The measured runs: keys only, nothing clicked and no wheel, j with nothing focused. */
  const press = async (key: string): Promise<void> => {
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
  };

  it("j j j 80ms apart, then a 2.5s rest: only the letter it stops on turns read", async () => {
    await laidOut();
    for (let i = 0; i < 3; i += 1) {
      await press("j");
      await act(async () => { vi.advanceTimersByTime(80); });
    }
    expect(marked, "r1 and r2 were current for 80ms each").toEqual([]);
    await rest(2500);
    expect(marked).toEqual(["r3"]);
  });

  it("j three times 2.5s apart: nothing at a press, each letter it rests on read by the rule, nothing else on screen", async () => {
    await laidOut();
    for (const id of ["r1", "r2", "r3"]) {
      await press("j");
      expect(marked.includes(id), `${id} at the press`).toBe(false);
      await rest(2500);
      expect(marked.at(-1), `${id} after resting on it`).toBe(id);
    }
    // r0 stood on screen from the open, r4 below the last one: a step enters nothing.
    expect(marked).toEqual(["r1", "r2", "r3"]);
  });

  it("after a wheel armed the stream, j j j 80ms apart marks nothing on the way; the rule then reads the screen it rests on", async () => {
    await laidOut();
    await wheelStream(40);
    await rest(3000);
    expect(marked, "control: the wheel's screen, by the rule").toEqual(["r0", "r1", "r2"]);
    marked = [];
    for (let i = 0; i < 3; i += 1) {
      await press("j");
      await act(async () => { vi.advanceTimersByTime(80); });
    }
    expect(marked, "the pass").toEqual([]);
    await rest(2500);
    expect([...marked].sort()).toEqual(["r3", "r4", "r5"]);
  });

  it("after a wheel armed the stream, j onto a snippet card marks nothing; the reader's next wheel reads it as it rises", async () => {
    readable();
    await mountReadsLive(FORTY, null); // snippet cards: the rule reads none of them live
    await wheelStream(40);
    await rest(3000);
    expect(marked, "control: the band took r0").toEqual(["r0"]);
    marked = [];
    await press("j");
    await act(async () => { vi.advanceTimersByTime(80); });
    expect(marked, "at the press").toEqual([]);
    await rest(2500);
    expect(marked, "at rest").toEqual([]);
    await wheelStream(CARD_H - 14 + 100);
    expect(marked).toEqual(["r1"]);
  });


  it("End heard on the stream after a wheel: the screen it rests on turns read by the rule, with nothing else moving", async () => {
    const el = await laidOut();
    await wheelStream(100);
    await act(async () => { vi.advanceTimersByTime(3000); });
    marked = [];
    await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })); });
    for (const top of [222, 888, 2220, 4070, 5550, 6660, 7178, 7400]) {
      await act(async () => { setStreamScroll(el, top); });
      await act(async () => { vi.advanceTimersByTime(16); });
    }
    for (let i = 0; i < 12; i += 1) await act(async () => { vi.advanceTimersByTime(100); });
    expect(marked.filter((id) => !["r37", "r38", "r39"].includes(id)), "nothing End flew past").toEqual([]);
    expect([...marked].sort()).toEqual(["r37", "r38", "r39"]);
  });

  it("a row click opens its letter: it and the letters whole on screen below it turn read after 0.7s, the one above does not", async () => {
    const el = await laidOut();
    const row = host!.querySelector<HTMLElement>('.view-reads .row[data-id="r5"]');
    expect(row, "control: the row is mounted").not.toBeNull();
    await act(async () => { row!.click(); });
    for (let i = 0; i < 10; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    expect(scrollTops.get(el), "control: r5 at the reading line").toBe(5 * CARD_H - 14);
    expect(marked, "a click reads nothing by itself").toEqual([]);
    await rest(900);
    expect(marked).toEqual(["r5", "r6", "r7"]);
    await rest(3000);
    expect(marked.includes("r4"), "r4 shows only its foot").toBe(false);
  });

  it("two row clicks 80ms apart: only the screen the second rests on turns read", async () => {
    await laidOut();
    const click = async (id: string): Promise<void> => {
      await act(async () => { host!.querySelector<HTMLElement>(`.view-reads .row[data-id="${id}"]`)!.click(); });
    };
    await click("r5");
    await act(async () => { vi.advanceTimersByTime(80); });
    await click("r9");
    for (let i = 0; i < 10; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    expect(marked, "nothing at either click").toEqual([]);
    await rest(3000);
    expect(marked).toEqual(["r9", "r10", "r11"]);
  });

  it("a far row click with no wheel before it: the landed screen turns read by the rule, not the card above it", async () => {
    const el = await laidOut();
    const row = host!.querySelector<HTMLElement>('.view-reads .row[data-id="r30"]');
    expect(row, "control: the row is mounted").not.toBeNull();
    await act(async () => { row!.click(); });
    for (let i = 0; i < 20; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    expect(scrollTops.get(el), "control: a far landing").toBeGreaterThan(5000);
    await rest(1000);
    expect(marked).toEqual(["r30", "r31", "r32"]);
  });

  it("a row click in Receipts enters the visit the same way", async () => {
    readable();
    pileSize = 10;
    await mountReceipts(TEN, { full: true });
    marked = [];
    const row = host!.querySelector<HTMLElement>('.view-receipts .row[data-id="r2"]');
    expect(row, "control: the row is mounted").not.toBeNull();
    await act(async () => { row!.click(); });
    for (let i = 0; i < 10; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    expect(marked, "a click reads nothing by itself").toEqual([]);
    await rest(900);
    expect(marked).toEqual(["r2", "r3", "r4"]);
  });

  for (const key of ["ArrowDown", "j"]) it(`${key} ×3 80ms apart in the list marks nothing; resting 0.8s on the third reads only it`, async () => {
    await laidOut();
    const row = host!.querySelector<HTMLElement>('.view-reads .row[data-id="r0"]')!;
    await act(async () => { row.focus(); });
    for (let i = 0; i < 3; i += 1) {
      await act(async () => { row.ownerDocument.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
      await act(async () => { vi.advanceTimersByTime(80); });
    }
    expect(marked, "a fast pass reads nothing").toEqual([]);
    await rest(800);
    expect(marked).toEqual(["r3"]);
    await rest(3000);
    expect(marked, "the step entered nothing").toEqual(["r3"]);
  });

  it("↓ in the Receipts list marks nothing at the press; resting 0.8s reads only its target", async () => {
    readable();
    pileSize = 10;
    await mountReceipts(TEN, { full: true });
    marked = [];
    const row = host!.querySelector<HTMLElement>('.view-receipts .row[data-id="r0"]')!;
    await act(async () => { row.focus(); row.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    await act(async () => { vi.advanceTimersByTime(80); });
    expect(marked).toEqual([]);
    await rest(3000);
    expect(marked).toEqual(["r1"]);
  });

  /** r3, read before the visit, rests at the reading line and is marked unread there. */
  async function unreadAtLine(): Promise<void> {
    vi.stubGlobal("IntersectionObserver", DeliveringIO);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    inner = true;
    await mountReadsLive(FORTY.map((r) => ({ ...r, unread: r.id !== "r3" })), null, { full: true });
    await wheelStream(3 * CARD_H - 14);
    await rest(500);
    marked = [];
    await act(async () => { setUnreadLive("r3", true); });
  }

  it("a Mark unread while the stream's dwell ticks holds", async () => {
    await unreadAtLine();
    await rest(2500);
    expect(marked.includes("r3")).toBe(false);
  });

  it("a Mark unread holds when the stream comes back to it at the reading line", async () => {
    await unreadAtLine();
    // Far enough that the window slides and observes r3 again: back up, it crosses the band whole.
    await wheelStream(6000);
    await wheelStream(3 * CARD_H - 14);
    await rest(2500);
    expect(marked.includes("r3")).toBe(false);
  });

  it("a Mark unread holds when an upward wheel shows only its foot", async () => {
    await unreadAtLine();
    // Far enough that the window slides and observes r3 again.
    await wheelStream(6000);
    await rest(2500);
    await wheelStream(4 * CARD_H - 14);
    await rest(2500);
    expect(marked.includes("r3")).toBe(false);
  });

  it("a Mark unread holds when j steps away and k comes back to it", async () => {
    vi.stubGlobal("IntersectionObserver", DeliveringIO);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    inner = true;
    // As measured: r2 read before the visit; j r1, j r2, Mark unread r2, j r3, k back to r2, a rest.
    await mountReadsLive(FORTY.map((r) => ({ ...r, unread: r.id !== "r2" })), null, { full: true });
    marked = [];
    const step = async (key: string): Promise<void> => {
      await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
      await rest(1000);
    };
    await step("j");
    await step("j");
    await act(async () => { setUnreadLive("r2", true); });
    await step("j");
    await step("k");
    expect(curs.at(-1), "control: the cursor is back on r2").toBe("r2");
    expect(marked).toEqual(["r1", "r3"]);
  });

  it("after a far open, an upward wheel that leaves the opened card's head on screen: the cursor stays on it", async () => {
    const el = await laidOut();
    await act(async () => { host!.querySelector<HTMLElement>('.view-reads .row[data-id="r30"]')!.click(); });
    for (let i = 0; i < 20; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    const landed = scrollTops.get(el)!;
    expect(landed, "control: r30 at the reading line").toBe(30 * CARD_H - 14);
    await rest(3000);
    await wheelStream(landed - 81);
    await rest(2500);
    expect(curs.at(-1)).toBe("r30");
    expect(marked.includes("r29")).toBe(false);
  });

  it("after a far leap, an upward wheel that leaves the card above 95px of its foot: its dwell reads nothing", async () => {
    const el = await laidOut();
    const landed = 30 * CARD_H - 14;
    await leapStream(landed);
    expect(scrollTops.get(el), "control: r30 at the reading line").toBe(landed);
    await rest(3000);
    // r29 shows its bottom 95px and r30's top stands at 95, past the scroll-spy's 90px line.
    await wheelStream(landed - 81);
    await rest(2500);
    expect(curs.at(-1), "control: the cursor moved to r29, and its dwell came due").toBe("r29");
    expect(marked.includes("r29"), "r29's sender line and first lines were never on screen").toBe(false);
  });

  it("the card a wheel settles on, its first lines on screen, is read by its dwell after 2s", async () => {
    readable();
    await mountReadsLive(FORTY, null); // snippet cards: the rule reads none of them live
    await wheelStream(150);
    expect(marked, "control: the band took r0; the cursor is on r1, its foot below the band").toEqual(["r0"]);
    await rest(1700);
    expect(marked, "before the dwell").toEqual(["r0"]);
    await rest(500);
    expect(marked).toEqual(["r0", "r1"]);
  });

  it("the same settle after a press, with no hand on the stream: the dwell reads nothing", async () => {
    readable();
    await mountReadsLive(FORTY, null);
    const el = streamEl();
    // The press enters the visit, so the rule looks and sees r1's first lines; the scroll is the app's own.
    await act(async () => { el.querySelector('.scast[data-sid="r0"] h3')!.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    await act(async () => { setStreamScroll(el, 150); });
    await rest(2500);
    expect(curs.at(-1), "control: the scroll-spy put the cursor on r1").toBe("r1");
    expect(marked).toEqual([]);
  });

  it("a letter read and then marked unread stays out of the leave", async () => {
    await laidOut();
    await wheelStream(100);
    await rest(900);
    expect(marked, "control: the rule read r1 and r2").toEqual(["r0", "r1", "r2"]);
    await act(async () => { setUnreadLive("r1", false); });
    await act(async () => { setUnreadLive("r1", true); });
    await rest(900);
    await unmount();
    expect(commits).toEqual([{ upToId: "r0", messageIds: ["r0", "r2"] }]);
  });

  it("marked unread, then scrolled through the band again: still out of the leave", async () => {
    await laidOut();
    await wheelStream(100);
    await rest(900);
    expect(marked, "control: the rule read r1 and r2").toEqual(["r0", "r1", "r2"]);
    await act(async () => { setUnreadLive("r1", false); });
    await act(async () => { setUnreadLive("r1", true); });
    await wheelStream(0);
    await wheelStream(400);
    await rest(900);
    await unmount();
    expect(commits).toHaveLength(1);
    expect(commits[0]!.messageIds.includes("r1"), "the Mark unread outlives the band and the leave").toBe(false);
  });

  it("leaving after a wheel leaves the letter at the foot, its sender line alone on screen, unread", async () => {
    await laidOut();
    await wheelStream(40);
    await rest(3000);
    expect(marked.includes("r3"), "the rule never read r3").toBe(false);
    await unmount();
    expect(commits).toEqual([{ upToId: "r0", messageIds: ["r0", "r1", "r2"] }]);
  });

  it("leaving after PageDown typed in a letter leaves the foot letter unread too", async () => {
    const el = await laidOut();
    const frame = document.createElement("iframe");
    el.querySelector('.scast[data-sid="r0"]')!.appendChild(frame);
    frame.focus();
    const letter = frame.contentDocument!;
    await act(async () => { letter.body.dispatchEvent(new (letter.defaultView as typeof window).KeyboardEvent("keydown", { key: "PageDown", bubbles: true })); });
    await unheard(el, [20, 40], 30);
    await rest(3000);
    expect(marked.includes("r3"), "the rule never read r3").toBe(false);
    await unmount();
    expect(commits).toHaveLength(1);
    expect(commits[0]!.upToId).toBe("r0");
    expect(commits[0]!.messageIds.includes("r3"), "r3's text was never on screen").toBe(false);
  });

  it("Receipts snippet cards are read by the leave alone, by the same rule; the foot card is not", async () => {
    readable();
    await mountReceipts(TEN);
    marked = [];
    await wheelStream(40);
    await rest(900);
    expect(marked, "the band took r0 live; the rule reads no snippet card live").toEqual(["r0"]);
    await unmount();
    expect(commits).toEqual([{ upToId: "r0", messageIds: ["r0", "r1", "r2"] }]);
  });

  it("a snippet card on screen under 0.7s is not read by the leave", async () => {
    readable();
    await mountReceipts(TEN);
    await wheelStream(40);
    await rest(300);
    await unmount();
    expect(commits).toEqual([{ upToId: "r0", messageIds: ["r0"] }]);
  });

  it("a far list click after a wheel: once the landing rests, the screen it shows turns read by the rule", async () => {
    const el = await laidOut();
    await wheelStream(100);
    await act(async () => { vi.advanceTimersByTime(3000); });
    marked = [];
    const row = host!.querySelector<HTMLElement>('.view-reads .row[data-id="r30"]');
    expect(row, "control: the row is mounted").not.toBeNull();
    await act(async () => { row!.click(); });
    for (let i = 0; i < 20; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    expect(scrollTops.get(el), "control: a far landing").toBeGreaterThan(5000);
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(marked, "r29 shows only its foot").toEqual(["r30", "r31", "r32"]);
    await wheelStream(29 * CARD_H - 14);
    await rest(3000);
    expect(marked.includes("r28"), "an upward wheel shows only r28's foot").toBe(false);
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

/* ── a letter answered in place ─────────────────────────────────────────────────────────── */

/** The view under the chrome the shell answers with: `replyTo`, the send lanes, the cursor. */
let answer: { replyTo: string | null; phases: Record<string, string>; curs: string[] };
let rerender: () => Promise<void> = async () => {};

async function mountAnswering(view: "reads" | "receipts"): Promise<void> {
  await unmount();
  const { ReadsView } = await import("../app/views/ReadsView.js");
  const { ReceiptsView } = await import("../app/views/ReceiptsView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");
  answer = { replyTo: null, phases: {}, curs: [] };
  const body = (m: { snippet: string }) => ({
    text: m.snippet, state: "full", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
  });
  const common = {
    settled: true, owed: false, tags: [], now: NOW, cur: "r1", onCur: (id: string) => { answer.curs.push(id); },
    markSeen: (id: string) => { marked.push(id); },
    onLeaveSeen: (c: { upToId: string; messageIds: string[] }) => { commits.push(c); },
    bodyOf: body, hydrateBody: () => {}, jumpTo: null, onJumped: () => {}, onAction: () => {},
  };
  const node = () => view === "reads"
    ? h(ReadsView as never, {
      ...common, aiChip: null, chipState: null, onChipState: () => {},
      partition: { waterline: null, fresh: TEN.map((r) => msg(r, "ohmail/News")), seen: [] },
    } as never)
    : h(ReceiptsView as never, {
      ...common, messages: TEN.map((r) => msg(r, "ohmail/Receipts")), waterline: null,
      unreadCount: TEN.length, isUnread: (m: { unread: boolean }) => m.unread,
    } as never);
  const tree = () => wrap(h(MessageChromeProvider as never, {
    value: {
      nowAt: () => NOW, ownAddresses: [], absoluteTime: false, onToggleAbsoluteTime: () => {},
      replyTo: answer.replyTo, replyBody: { text: "", html: "" },
      onReplyBody: () => {}, closeReply: () => {}, sendReply: () => {},
      replyEnvelope: null, replyFromId: null, replyAttachments: [], replySubjectEdit: null,
      replySig: { mode: "following" }, replySendShowing: null,
      replySendState: (lane: string) => ({ phase: answer.phases[lane] ?? "idle" }),
      openSenderMenu: () => {}, openAttachmentPreview: () => {},
      conversationOf: () => [], bodyOf: body, hydrateBody: () => {}, hydrateThread: () => {},
    },
    children: node(),
  } as never), KeymapProvider);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  rerender = async () => { await act(async () => { root!.render(tree()); await Promise.resolve(); }); };
  await rerender();
  await rerender();
}

/** Lets the stream's frames run: the reveal, the hold, the scroll-spy. */
const frames = async (n = 10) => { for (let i = 0; i < n; i += 1) await act(async () => { vi.advanceTimersByTime(20); }); };
/** The editor's typing surface, once the editor has loaded in the letter's place. */
const editorIn = async (sid: string): Promise<Element> => {
  const sel = `.scast[data-sid='${sid}'].in-place .reply .rte-surface`;
  await vi.waitFor(async () => {
    await act(async () => { vi.advanceTimersByTime(20); });
    expect(host!.querySelector(sel), "the editor in place, inside the stream").not.toBeNull();
  }, { timeout: 5000, interval: 20 });
  return host!.querySelector(sel)!;
};
const topOf = (sid: string): number => host!.querySelector(`.scast[data-sid='${sid}']`)!.getBoundingClientRect().top;

describe("a letter answered in place", () => {
  it("typing its reply scrolls nothing: leaving writes no \\Seen, a later app scroll marks nothing", async () => {
    vi.stubGlobal("IntersectionObserver", DeliveringIO);
    for (const view of ["reads", "receipts"] as const) {
      commits = [];
      marked = [];
      await mountAnswering(view);
      answer.replyTo = "r1";
      await rerender();
      const surface = await editorIn("r1");
      for (const k of ["o", " ", "End"]) {
        await act(async () => { surface.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
      }
      answer.replyTo = null;
      await rerender();
      await act(async () => { setStreamScroll(streamEl(), 800); });
      await frames(5);
      expect(marked, view).toEqual([]);
      await unmount();
      expect(commits, view).toEqual([]);
    }
  });

  /* The letter straddles the port's top edge: a close that held the card below would pull it down
     past the reading line and hand the cursor to the letter above. */
  const answeredAbove = async (): Promise<void> => {
    await mountAnswering("reads");
    await act(async () => { setStreamScroll(streamEl(), 400); });
    answer.replyTo = "r1";
    await rerender();
    await frames();
    expect(topOf("r1"), "the dock's end revealed, the letter's head above the port").toBeLessThan(0);
    // The person writes for a while: the open's own hold has long run out.
    await act(async () => { vi.advanceTimersByTime(5000); });
    await frames();
    answer.curs = [];
  };

  it("after Send the cursor stays on the answered letter and its top stays where it was", async () => {
    await answeredAbove();
    const top = topOf("r1");
    answer.replyTo = null;
    answer.phases = { r1: "sending" };
    await rerender();
    await frames();
    expect(host!.querySelector(".scast[data-sid='r1'].in-place"), "still its conversation").not.toBeNull();
    expect(topOf("r1")).toBe(top);
    expect(answer.curs.filter((id) => id !== "r1"), "the cursor moved").toEqual([]);
  });

  it("after Esc the card comes back at the reading line, the cursor still on it", async () => {
    await answeredAbove();
    answer.replyTo = null;
    await rerender();
    await frames();
    expect(host!.querySelector(".scast[data-sid='r1'].in-place")).toBeNull();
    expect(topOf("r1"), "its head at the reading line").toBe(14);
    expect(answer.curs.filter((id) => id !== "r1"), "the cursor moved").toEqual([]);
  });

  /** The card on the scroll-spy's reading line, 90px down: where the cursor is. */
  const onLine = (): string | null => {
    let at: string | null = null;
    for (const c of streamCards(streamEl())) {
      if (c.getBoundingClientRect().top > 90) break;
      at = c.dataset.sid!;
    }
    return at;
  };
  /* The person read on below the answered letter with its dock still open: the letter is wholly
     above the port and the cursor is on r3. Closing the dock must not take them back to it. */
  const readOnBelow = async (): Promise<number> => {
    await mountAnswering("reads");
    answer.replyTo = "r1";
    await rerender();
    await frames();
    await wheelStream(1300);
    await act(async () => { vi.advanceTimersByTime(5000); });
    await frames();
    expect(onLine(), "read on to r3").toBe("r3");
    expect(answer.curs.at(-1), "the cursor followed").toBe("r3");
    expect(topOf("r2"), "the letter wholly above the port").toBeLessThan(0);
    answer.curs = [];
    return topOf("r3");
  };

  it("read on below it, Esc leaves the stream on the card being read, the cursor with it", async () => {
    const top = await readOnBelow();
    answer.replyTo = null;
    await rerender();
    await frames();
    expect(host!.querySelector(".scast[data-sid='r1'].in-place")).toBeNull();
    expect(onLine(), "the card on the reading line").toBe("r3");
    expect(topOf("r3"), "the stream jumped").toBe(top);
    expect(answer.curs.filter((id) => id !== "r3"), "the cursor moved").toEqual([]);
  });

  it("read on below it, a handed-off Send leaves the stream on the card being read", async () => {
    const top = await readOnBelow();
    answer.replyTo = null;
    answer.phases = { r1: "sending" };
    await rerender();
    await frames();
    expect(host!.querySelector(".scast[data-sid='r1'].in-place"), "still its conversation").not.toBeNull();
    expect(onLine(), "the card on the reading line").toBe("r3");
    expect(topOf("r3"), "the stream jumped").toBe(top);
    expect(answer.curs.filter((id) => id !== "r3"), "the cursor moved").toEqual([]);
  });
});
