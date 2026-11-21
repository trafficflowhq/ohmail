/** @vitest-environment jsdom */
/**
 * The waterline leave commit through the registered mail frame.
 *
 * The old model marked `\Seen` only through per-card observer hits: a card that exited
 * through the TOP of the stream marked itself, the card the scroll settled on dwelled, and
 * the LAST SCREENFUL — which never exits through the top — structurally never marked. The
 * fix is not a better observer; it is that LEAVING the view commits the waterline to the
 * top of what was on screen, in ONE anchored `feed_mark_seen`, bounded by what the visit
 * actually displayed.
 *
 * Leaving means navigating from either stream to the Ohbox. jsdom has no layout,
 * so the fixture supplies the viewport, card positions and read-line geometry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import type { EngineMutation, FeedView } from "@ohmail/wire";
import * as batch from "@ohmail/app-logic/reading/seen-batch";
import * as streamScroll from "../../../packages/app-logic/src/streams/stream-scroll.js";
import catalogue from "../messages/en.json";
import { waterlineIdOf } from "@ohmail/client-engine";
import { hitAt, issue, mountStreamFrame, receipt } from "../../../packages/app/test/streams/registered-world.js";

const isStream = (el: Element): boolean =>
  el.matches(".oh-sheet-scroll") && Boolean(el.closest('[aria-label="News stream"], [aria-label="Receipts stream"]'));

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
  return [...stream.querySelectorAll<HTMLElement>("[data-stream-item]")];
}

/** Each card sits at its index times CARD_H, minus the scroll offset. */
function rectFor(el: Element): DOMRect {
  const zero = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
  // A card's sender line [top+16, top+36] and its text [top+70, foot-30], where a test lays them out.
  const part = el.matches("[data-sender-line]") ? "line" : el.matches(".oh-message-clip, .oh-message-body, [data-read-body]") ? "clip" : null;
  if (inner && part) {
    const card = el.closest("[data-stream-item]");
    if (!card) return zero as DOMRect;
    const c = rectFor(card);
    const [top, bottom] = part === "line" ? [c.top + 16, c.top + 36] : [c.top + 70, c.bottom - 30];
    return { ...zero, top, bottom, height: bottom - top } as DOMRect;
  }
  if (isStream(el)) {
    return { ...zero, top: 0, bottom: VIEW_H, height: VIEW_H } as DOMRect;
  }
  if (el.matches("[data-stream-item], [data-stream-window-item]")) {
    const stream = el.closest(".oh-sheet-scroll");
    if (!stream) return zero as DOMRect;
    // Placed at its PILE index (the ids are r<index>), so the window may mount any run of it.
    const i = Number(((el as HTMLElement).dataset.streamItem ?? (el as HTMLElement).dataset.streamWindowItem)?.slice(1));
    if (!Number.isFinite(i)) return zero as DOMRect;
    const top = i * CARD_H + (i >= shift.from ? shift.by : 0) - (scrollTops.get(stream) ?? 0);
    const height = CARD_H;
    return { ...zero, top, bottom: top + height, height } as DOMRect;
  }
  return zero as DOMRect;
}

/** Adds the mounted cards inside the viewport now to `displayed`. */
function noteDisplayed(stream: Element): void {
  for (const c of streamCards(stream)) {
    const r = rectFor(c);
    if (r.bottom > 0 && r.top < VIEW_H) displayed.add(c.dataset.streamItem!);
  }
}

function setStreamScroll(stream: Element, next: number): void {
  if (!Number.isFinite(next)) throw new Error("Non-finite scroll offset");
  const max = Math.max(0, pileSize * CARD_H + shiftBelow() - VIEW_H);
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

let world: ReturnType<typeof mountStreamFrame> | null = null;
let host: HTMLElement | null = null;
let commits: Array<{ upToId: string; messageIds: string[] }> = [];
let marked: string[] = [];
let curs: string[] = [];
let view: FeedView = "reads";

function anchoredWrites(current: NonNullable<typeof world>): EngineMutation[] {
  return current.mail.mutations.filter((m) => m.kind === "feed_mark_seen" && m.upToId !== undefined);
}

async function leave(): Promise<void> {
  const current = world!;
  await act(async () => current.address.visit("#/ohbox"));
  const writes = anchoredWrites(current);
  const feedWrites = current.mail.mutations.filter((mutation) => mutation.kind === "feed_mark_seen");
  expect(feedWrites.every((mutation) => mutation.view === view)).toBe(true);
  commits = writes.flatMap((m) => m.kind === "feed_mark_seen"
    ? [{ upToId: m.upToId!, messageIds: [...(m.messageIds ?? [])] }]
    : []);
  expect(writes).toEqual(commits.map((commit) => ({ kind: "feed_mark_seen", view, ...commit })));
  const frame = within(current.page.container);
  expect(current.page.container.isConnected).toBe(true);
  expect(frame.getByRole("button", { name: /^Ohbox/, current: "page" })).toBeTruthy();
  expect(frame.queryByRole("region", { name: /^(News|Receipts) stream$/ })).toBeNull();
}

async function teardown(): Promise<void> {
  if (!world) return;
  const current = world;
  world = null;
  host = null;
  const before = [...anchoredWrites(current)];
  current.page.unmount();
  expect(anchoredWrites(current)).toEqual(before);
}

function liveGlances(): string[] {
  return world!.mail.mutations.flatMap((mutation) =>
    mutation.kind === "feed_mark_seen" && mutation.view === "reads" && mutation.upToId === undefined
      ? mutation.messageIds ?? []
      : [],
  );
}

type Visit = { jump?: string | null; full?: boolean; enters?: boolean; waterline?: { newestSeenId: string; at?: string } };
async function mountFeed(feed: FeedView, rows: Row[], opts: Visit = {}): Promise<void> {
  await teardown();
  pileSize = rows.length;
  view = feed;
  const make = feed === "reads" ? issue : receipt;
  const letters = rows.map((row, i) =>
    make(row.id, 20 - i, { subject: `S-${row.id}`, snippet: "preview", unread: row.unread, body: undefined }),
  );
  const bodies = opts.full
    ? Object.fromEntries(rows.map(({ id }) => [id, { state: "ready", text: "Full letter text.", html: null, loadedRemoteContent: false }]))
    : undefined;
  const extra = opts.waterline ? { [`view_meta:${waterlineIdOf(feed)}`]: opts.waterline } : undefined;
  const place = feed === "reads" ? "news" : "receipts";
  const hit = opts.enters && opts.jump ? hitAt(place, opts.jump) : undefined;
  world = mountStreamFrame({
    at: hit ? "#/search" : `#/${feed}${opts.jump ? `/m/${opts.jump}` : ""}`,
    letters, bodies, rows: extra, catalogue, hit,
  });
  host = world.page.container;
  if (hit) await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open the hit" })));
  await act(async () => { vi.advanceTimersByTime(32); });
  await act(async () => fireEvent.scroll(streamEl()));
  for (let i = 0; i < 20; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
}


function loadLetter(el: Element, card: string, frame: HTMLIFrameElement): void {
  el.querySelector(`[data-stream-item="${card}"]`)!.appendChild(frame);
  fireEvent.load(frame);
}

async function openWithEnter(): Promise<void> {
  const row = screen.getByRole("option", { selected: true });
  row.focus();
  await act(async () => fireEvent.keyDown(row, { key: "Enter" }));
}
const mountReads = (rows: Row[], opts: Visit = {}) => mountFeed("reads", rows, opts);
const mountReceipts = (rows: Row[], opts: Visit = {}) => mountFeed("receipts", rows, opts);
const streamEl = (): HTMLElement => screen
  .getByRole("region", { name: view === "reads" ? "News stream" : "Receipts stream" })
  .querySelector<HTMLElement>(".oh-sheet-scroll")!;

/** A real user scroll of the STREAM: the input a human produces, then the movement, a frame per half card. */
async function wheelStream(to: number): Promise<void> {
  const el = streamEl();
  let at = scrollTops.get(el) ?? 0;
  await act(async () => fireEvent.wheel(el, { deltaY: Math.sign(to - at) || 1 }));
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

const rerenderLive = () => world?.mail.patch("r0", {});
const setUnreadLive = (id: string, unread: boolean) => world?.mail.patch(id, { unread });
const mountReadsLive = (rows: Row[], jump: string | null, opts: Visit = {}) =>
  mountFeed("reads", rows, { ...opts, jump });

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
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance", "requestAnimationFrame", "cancelAnimationFrame"] });
  vi.stubGlobal("IntersectionObserver", MockIO);
  commits = [];
  marked = [];
  // The old assertions time the decision to read, before the transport batches it.
  // Record when the stream queues each glance while the real batch still reaches the engine.
  const createSeenBatcher = batch.createSeenBatcher;
  vi.spyOn(batch, "createSeenBatcher").mockImplementation((...args) => {
    const seen = createSeenBatcher(...args);
    return { ...seen, add: (id) => { marked.push(id); seen.add(id); } };
  });
  curs = [];
  const useStreamScroll = streamScroll.useStreamScroll;
  vi.spyOn(streamScroll, "useStreamScroll").mockImplementation((options) => useStreamScroll({
    ...options,
    onCurrentChange(id, byHand) {
      curs.push(id);
      options.onCurrentChange(id, byHand);
    },
  }));
  pileSize = 10;
  inner = false;
  displayed = new Set();
  shift = { from: Infinity, by: 0 };
  DeliveringIO.live = new Set();
  DeliveringIO.stamp = "now";
  // The port's own size, which the stream's jump reads to tell a near landing from a far one.
  streamSize = {
    clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight"),
    scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight"),
    scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop"),
  };
  Object.defineProperty(Element.prototype, "clientHeight", {
    configurable: true, get(this: Element) { return isStream(this) ? VIEW_H : 0; },
  });
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true, get(this: Element) { return isStream(this) ? pileSize * CARD_H + shiftBelow() : 0; },
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
      if (isStream(this)) setStreamScroll(this, o?.top ?? 0);
    };
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView =
    function scrollIntoView() { /* the list pane's follow — no geometry to keep here */ };
});

afterEach(async () => {
  if (world && world.address.read() !== "#/ohbox") await leave();
  await teardown();
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
  it("BOUNDED by what was displayed — never the pile", async () => {
    // A partial read: 400px in, the final screen shows r2–r4. The commit covers r0–r4 (the
    // contiguous run the visit displayed) and NOT r5–r9, which never entered the viewport.
    // Widen the slice in the view's leave handler to the whole pile and this goes red.
    readable();
    await mountReads(TEN);
    await wheelStream(400);
    await rest();
    await leave();
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
    await leave();
    expect(commits).toEqual([
      { upToId: "r0", messageIds: ["r0", "r2", "r4"] },
    ]);
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
    await leave();
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
  }).map((c) => c.dataset.streamItem!));
  const FORTY: Row[] = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, unread: true }));

  it("leave after a far jump and one wheel commits only what was on screen after the landing", async () => {
    readable();
    await mountReadsLive(FORTY, "r30");
    const landed = scrollTops.get(streamEl()) ?? 0;
    expect(landed, "control: the jump went deep").toBeGreaterThan(5000);
    displayed = onScreen();
    await wheelStream(landed + 100);
    await rest();
    await leave();
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
    await leave();
    expect(commits[0]!.messageIds.filter((id) => !displayed.has(id))).toEqual([]);
    expect(commits).toEqual([{ upToId: "r37", messageIds: ["r37", "r38", "r39"] }]);
  });

  it("a scrollbar jump after a wheel leaves a skipped band card unread", async () => {
    readable();
    await mountReadsLive(FORTY, null);
    await wheelStream(0);
    await rest(500);
    await leapStream(600);
    await rest(1200);
    expect.soft(liveGlances(), "live News mutation").not.toContain("r2");
    await leave();
    expect(commits).toHaveLength(1);
    expect(commits[0]!.messageIds, "anchored News mutation").not.toContain("r2");
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
    await leave();
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
    await act(async () => { fireEvent.wheel(el, { deltaY: 1 }); });
    for (let i = 0; i < 20; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    loadLetter(el, "r0", frame);
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
    await leave();
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
    await act(async () => { fireEvent.wheel(el, { deltaY: 1 }); });
    for (let i = 0; i < 20; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    const frame = document.createElement("iframe");
    loadLetter(el, "r0", frame);
    frame.focus();
    marked = [];
    // Chromium hands a wheel over a letter to the letter's own document; the stream only scrolls.
    const letter = frame.contentDocument!;
    for (let top = 100; top <= 2400; top += 100) {
      await act(async () => { letter.body.dispatchEvent(new (letter.defaultView as typeof window).WheelEvent("wheel", { bubbles: true, deltaY: 1 })); });
      await act(async () => { setStreamScroll(el, top); });
      await act(async () => { vi.advanceTimersByTime(16); });
    }
    for (let i = 0; i < 20; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    const past = Array.from({ length: 13 }, (_, i) => `r${i}`);
    expect(marked).toEqual(past);
    await rest();
    await leave();
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
    await leave();
    expect(commits).toEqual([{ upToId: "r37", messageIds: ["r37", "r38", "r39"] }]);
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
    else if (wheel) await act(async () => { fireEvent.wheel(el, { deltaY: 1 }); });
    await act(async () => { vi.advanceTimersByTime(400); });
    const frame = document.createElement("iframe");
    const doc = document.implementation.createHTMLDocument("letter");
    Object.defineProperty(doc, "addEventListener", { value: () => {} });
    Object.defineProperty(frame, "contentDocument", { configurable: true, get: () => doc });
    loadLetter(el, card, frame);
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
    await leave();
    expect(commits).toEqual([{ upToId: "r0", messageIds: ids(2, 12) }]);
  });

  for (const wheel of [true, false]) it(`End marks only the screen it rests on, and the leave covers none of the letters it flew past${wheel ? "" : ", with no wheel before it"}`, async () => {
    const el = await deafReader(0, "r0", { wheel });
    marked = [];
    await unheard(el, [222, 888, 2220, 4070, 5550, 6660, 7178, 7400], 16);
    expect({ curs, marked }).toEqual({ curs: ["r39"], marked: ["r37", "r38", "r39"] });
    await leave();
    expect(commits).toEqual([{ upToId: "r0", messageIds: ids(37, 39) }]);
  });

  for (const wheel of [true, false]) it(`PageDown pressed six times 120ms apart marks only what stayed 0.7s on screen${wheel ? "" : ", with no wheel before it"}`, async () => {
    const el = await deafReader(0, "r0", { wheel });
    marked = [];
    // Each page (525px) animated over four frames, the next press as it ends.
    await unheard(el, Array.from({ length: 24 }, (_, i) => Math.round(131.25 * (i + 1))), 30);
    expect(marked).toEqual(["r16", "r17", "r18"]);
    await leave();
    expect(commits).toEqual([{ upToId: "r0", messageIds: ids(16, 18) }]);
  });

  it("an unheard End grants no reads to a later scroll without input", async () => {
    const el = await deafReader(0, "r0", { wheel: false });
    await unheard(el, [222, 888, 2220, 4070, 5550, 6660, 7178, 7400], 16);
    await rest(batch.SEEN_QUIET_MS);
    expect(liveGlances(), "the end screen earned reads").toEqual(ids(37, 39));
    screen.getByRole("option", { selected: true }).focus();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const before = liveGlances();
    await leapStream(6800);
    await rest(1200);
    expect.soft(liveGlances(), "no live glance for the later viewport").toEqual(before);
    await leave();
    expect(commits).toHaveLength(1);
    expect(commits[0]!.messageIds, "no later viewport letters in the leave").toEqual([]);
  });

  it("what a wheel read before such a scroll stays in the leave", async () => {
    const el = await deafReader(400, "r3");
    expect(marked, "control: the wheel lifted r0-r2 past the band; r3 and r4 wait for the leave").toEqual(ids(0, 2));
    await unheard(el, [622, 1288, 2620, 4470, 5950, 6900, 7300, 7400], 16);
    await leave();
    expect(commits).toEqual([{ upToId: "r0", messageIds: [...ids(0, 2), ...ids(37, 39)] }]);
  });

  it("a letter above the resting screen that grows as its body lands is not committed", async () => {
    const el = await deafReader(400, "r3");
    await unheard(el, [622, 1288, 2620, 4470, 5950, 6900, 7300, 7400], 16);
    await aboveGrows(el);
    await leave();
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
    await leave();
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
    await act(async () => { el.querySelector('[data-stream-item="r0"] h2')!.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    marked = [];
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true })); });
    await unheard(el, [150, 300, 450, 600], 30);
    await rest();
    await leave();
    expect({ marked, commits }).toEqual({ marked: ids(0, 3), commits: [{ upToId: "r0", messageIds: ids(0, 5) }] });
  });

  it("PageDown typed in a letter the app hears reads the same", async () => {
    readable();
    await mountReadsLive(FORTY, null);
    const el = streamEl();
    await act(async () => { vi.advanceTimersByTime(400); });
    const frame = document.createElement("iframe");
    loadLetter(el, "r0", frame);
    frame.focus();
    marked = [];
    const letter = frame.contentDocument!;
    await act(async () => { letter.body.dispatchEvent(new (letter.defaultView as typeof window).KeyboardEvent("keydown", { key: "PageDown", bubbles: true })); });
    await unheard(el, [150, 300, 450, 600], 30);
    await rest();
    await leave();
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
    await leave();
    expect(commits).toEqual([{ upToId: "r37", messageIds: ids(37, 39) }]);
  });

  it("control: with no growth the leave commits the resting screen", async () => {
    await wheelThenEnd();
    await rest();
    await leave();
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
  async function laidOut(): Promise<HTMLElement> {
    vi.stubGlobal("IntersectionObserver", DeliveringIO);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    inner = true;
    await mountReadsLive(FORTY, null, { full: true });
    marked = [];
    return streamEl();
  }

  it("a press on a card's heading, no scroll: the cards whose first lines and sender line stood 0.7s turn read", async () => {
    const el = await laidOut();
    const h3 = el.querySelector('[data-stream-item="r1"] h2')!;
    await act(async () => { h3.dispatchEvent(new Event("pointerdown", { bubbles: true })); (h3 as HTMLElement).click(); });
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(marked, "before the dwell").toEqual([]);
    for (let i = 0; i < 10; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    expect(marked).toEqual(["r0", "r1", "r2"]);
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
    loadLetter(el, card, frame);
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
    await leave();
    expect(commits).toEqual([{ upToId: "r0", messageIds: ["r0", "r37", "r38", "r39"] }]);
  });

  it("↵ opening the card under the cursor enters the visit like a press", async () => {
    await laidOut();
    await openWithEnter();
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
    await openWithEnter();
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
    const clip = streamEl().querySelector<HTMLElement>('[data-stream-item="r1"] .oh-message-clip')!;
    await act(async () => { clip.dispatchEvent(new Event("pointerdown", { bubbles: true })); clip.click(); });
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(marked.includes("r1"), "the Mark unread holds for the visit").toBe(false);
    expect(marked, "control: the press entered the visit").toEqual(["r2", "r3"]);
  });

  it("a press on a control in the stream, or j alone, enters nothing", async () => {
    const el = await laidOut();
    const hint = within(el).getAllByRole("button", { name: /Expand/ })[0];
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
    await mountReadsLive(FORTY, null, { full: false }); // snippet cards: the rule reads none of them live
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
    const row = host!.querySelector<HTMLElement>('[role="option"][data-id="r5"]');
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
      await act(async () => { host!.querySelector<HTMLElement>(`[role="option"][data-id="${id}"]`)!.click(); });
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
    const row = host!.querySelector<HTMLElement>('[role="option"][data-id="r30"]');
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
    const row = host!.querySelector<HTMLElement>('[role="option"][data-id="r2"]');
    expect(row, "control: the row is mounted").not.toBeNull();
    await act(async () => { row!.click(); });
    for (let i = 0; i < 10; i += 1) await act(async () => { vi.advanceTimersByTime(20); });
    expect(marked, "a click reads nothing by itself").toEqual([]);
    await rest(900);
    expect(marked).toEqual(["r2", "r3", "r4"]);
  });

  it("the card a wheel settles on, its first lines on screen, is read by its dwell after 2s", async () => {
    readable();
    await mountReadsLive(FORTY, null, { full: false }); // snippet cards: the rule reads none of them live
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
    await act(async () => { el.querySelector('[data-stream-item="r0"] h2')!.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    await act(async () => { setStreamScroll(el, 150); });
    await rest(2500);
    expect(curs.at(-1), "control: the scroll-spy put the cursor on r1").toBe("r1");
    expect(screen.getByRole("option", { selected: true }).getAttribute("data-id")).toBe("r1");
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
    await leave();
    expect(commits).toEqual([{ upToId: "r0", messageIds: ["r0", "r2"] }]);
  });

  it("leaving after a wheel leaves the letter at the foot, its sender line alone on screen, unread", async () => {
    await laidOut();
    await wheelStream(40);
    await rest(3000);
    expect(marked.includes("r3"), "the rule never read r3").toBe(false);
    await leave();
    expect(commits).toEqual([{ upToId: "r0", messageIds: ["r0", "r1", "r2"] }]);
  });

  it("leaving after PageDown typed in a letter leaves the foot letter unread too", async () => {
    const el = await laidOut();
    const frame = document.createElement("iframe");
    loadLetter(el, "r0", frame);
    frame.focus();
    const letter = frame.contentDocument!;
    await act(async () => { letter.body.dispatchEvent(new (letter.defaultView as typeof window).KeyboardEvent("keydown", { key: "PageDown", bubbles: true })); });
    await unheard(el, [20, 40], 30);
    await rest(3000);
    expect(marked.includes("r3"), "the rule never read r3").toBe(false);
    await leave();
    expect(commits).toHaveLength(1);
    expect(commits[0]!.upToId).toBe("r0");
    expect(commits[0]!.messageIds.includes("r3"), "r3's text was never on screen").toBe(false);
  });

  it("a far list click after a wheel: once the landing rests, the screen it shows turns read by the rule", async () => {
    const el = await laidOut();
    await wheelStream(100);
    await act(async () => { vi.advanceTimersByTime(3000); });
    marked = [];
    const row = host!.querySelector<HTMLElement>('[role="option"][data-id="r30"]');
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
    expect(host!.querySelectorAll(".oh-avatar > .oh-dot")).toHaveLength(0);
    // The eventual \Seen sweep still has its hook: every unread row and card is observable.
    expect(host!.querySelectorAll('[role="option"][data-unseen]').length).toBeGreaterThan(0);
    expect(host!.querySelectorAll("[data-stream-item][data-unseen]").length).toBeGreaterThan(0);
  });

  it("Receipts renders NO unread dot either, and draws ITS OWN waterline at the junction", async () => {
    await mountReceipts(TEN, { waterline: { newestSeenId: "r5", at: "2026-08-01T18:40:00.000Z" } });
    expect(host!.querySelectorAll(".oh-avatar > .oh-dot")).toHaveLength(0);
    expect(host!.querySelectorAll('[role="option"][data-unseen]').length).toBeGreaterThan(0);
    // One line in the list, one in the stream — the single newness signal, now in Receipts too.
    expect(within(host!).getAllByRole("heading", { name: /Seen up to here/i })).toHaveLength(2);
  });

  it("the Ohbox's row contract is untouched: without `dotless` the dot renders", () => {
    const mounted = mountStreamFrame({
      at: "#/ohbox", catalogue,
      letters: [issue("x", 20, { folder: "INBOX", from: { name: "Ben", address: "ben@kiln.example" } })],
    });
    try {
      const rows = within(screen.getByRole("region", { name: "Messages" }));
      const row = rows.getByRole("option", { name: /Issue 20/ });
      expect(row.querySelectorAll(".oh-avatar > .oh-dot")).toHaveLength(1);
      expect(row.hasAttribute("data-unseen")).toBe(true);
    } finally {
      mounted.page.unmount();
    }
  });
});
