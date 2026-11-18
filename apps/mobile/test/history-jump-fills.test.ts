/**
 * HISTORY NEVER STANDS EMPTY OVER MAIL, AND A RAIL PRESS FILLS AROUND ITS LANDING. The suite has no
 * React Native renderer, so the list is driven through React Native's OWN window arithmetic
 * (`computeWindowedRenderLimits` and `ListMetricsAggregator` from the installed
 * `@react-native/virtualized-lists`, Flow types stripped), the shipped walker, the shipped slot
 * ledger and the shipped `HistoryAsks`, over a mailbox spread across three years. A frame is blank when
 * no row cell, filled or placeholder, meets the viewport. What this cannot see is the native layer:
 * Android's detach of clipped rows is a device read (`MailList.tsx`).
 */
import type { EngineMessage } from "@ohmail/wire";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HISTORY_PAGE_CACHE_ROWS, HISTORY_PAGE_ROWS, MemoryMirrorStore, OhmailEngine, StoreTimelineWalker,
  type EngineAdapter, type ListOlderFn, type StoreTimeline, type SyncResponse,
} from "@ohmail/client-engine";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { HistoryAsks } from "../src/ui/history-asks";
import { SlotHeights } from "../src/ui/history-slot";
import { LIST_WINDOW, mountedRowsBound, planSections, sectionItemLayout } from "../src/ui/mail-list-plan";

/* React Native's window code, as the app runs it. */
const req = createRequire(import.meta.url);
const rnDir = dirname(req.resolve("react-native/package.json"));
const listsDir = join(dirname(req.resolve("@react-native/virtualized-lists/package.json", { paths: [rnDir] })), "Lists");
const babel = req(req.resolve("@babel/core", { paths: [rnDir] }));
const plugins = ["@babel/plugin-transform-flow-strip-types", "@babel/plugin-transform-modules-commonjs"].map((p) => req.resolve(p, { paths: [rnDir] }));
const invariant = req(req.resolve("invariant", { paths: [rnDir] }));
const loaded = new Map<string, Record<string, unknown>>();
function rnModule(file: string): Record<string, unknown> {
  const hit = loaded.get(file);
  if (hit) return hit;
  const code = babel.transformSync(readFileSync(join(listsDir, file), "utf8"), { plugins, babelrc: false, configFile: false, filename: file }).code;
  const module = { exports: {} as Record<string, unknown> };
  loaded.set(file, module.exports);
  new Function("require", "module", "exports", code)((m: string) => {
    if (m === "invariant") return invariant;
    // The one flag the window reads; its shipped default (ReactNativeFeatureFlags.js) is false.
    if (m.includes("ReactNativeFeatureFlags")) return { fixVirtualizeListCollapseWindowSize: () => false };
    if (m.startsWith("./")) return rnModule(`${m.slice(2)}.js`);
    throw new Error(`unexpected import ${m}`);
  }, module, module.exports);
  loaded.set(file, module.exports);
  return module.exports;
}
type Range = { first: number; last: number };
const computeWindowedRenderLimits = rnModule("VirtualizeUtils.js").computeWindowedRenderLimits as (...a: unknown[]) => Range;
const ListMetricsAggregator = rnModule("ListMetricsAggregator.js").default as new () => {
  getContentLength(): number;
  getCellMetricsApprox(i: number, p: unknown): { offset: number; length: number };
  notifyCellLayout(a: unknown): boolean;
  notifyListContentLayout(a: unknown): void;
};

/* The mailbox: most rows in one year, some in the next, a few in a third, two undated. */
const NOW = new Date("2026-10-09T12:00:00.000Z");
const idOf = (n: number) => `00000000-0000-4000-8000-${(0xffffff - n).toString(16).padStart(12, "0")}`;
function msg(n: number, date: string | null): EngineMessage {
  return {
    id: idOf(n), accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: `s${n}`,
    from: { name: null, address: "x@example.test" }, to: [], cc: [], date, folder: "INBOX", snippet: "",
    unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date ?? NOW.toISOString(),
  } as EngineMessage;
}
const instant = (d: string | null) => (d ? Date.parse(d) : 0);
/** `count` rows spread evenly between two instants, newest first, for each span; undated last. */
function mailbox(spans: [number, string, string][], undated: number): EngineMessage[] {
  const rows: EngineMessage[] = [];
  let n = 0;
  for (const [count, from, to] of spans) {
    const a = Date.parse(`${from}${"T"}00:00:00Z`), b = Date.parse(`${to}${"T"}00:00:00Z`);
    for (let i = 0; i < count; i++) rows.push(msg(n++, new Date(b - ((b - a) * (i + 0.5)) / count).toISOString()));
  }
  for (let i = 0; i < undated; i++) rows.push(msg(n++, null));
  return rows;
}
function timelineOf(rows: EngineMessage[]): StoreTimeline {
  const months: StoreTimeline["months"] = [];
  let undated = 0;
  for (const m of rows) {
    if (!m.date) { undated += 1; continue; }
    const k = m.date.slice(0, 7);
    const last = months[months.length - 1];
    if (last?.month === k) last.count += 1;
    else months.push({ month: k, count: 1, first: { date: m.date, id: m.id } });
  }
  return { total: rows.length, months, undated };
}
async function walkerOver(rows: EngineMessage[]) {
  const net = { down: false, clock: 0 };
  const listMessages: ListOlderFn = async (_v, o) => {
    await new Promise((r) => setTimeout(r, 0));
    if (net.down && o.startBelow) throw new Error("offline");
    const b = o.startBelow;
    const below = (m: EngineMessage) => {
      const a = instant(m.date), x = b!.date ? Date.parse(b!.date) : 0;
      return a < x || (a === x && m.id < b!.id);
    };
    return { items: (b ? rows.filter(below) : rows).slice(0, o.limit ?? HISTORY_PAGE_ROWS), nextCursor: null };
  };
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: NOW.toISOString() }),
    mutate: async () => ({ changes: [], seq: null }), fetchBody: async () => null,
    listMessages, timeline: async () => timelineOf(rows),
  } as unknown as EngineAdapter;
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({ adapter, store, now: () => NOW });
  return { engine, net, walker: new StoreTimelineWalker(engine, () => net.clock) };
}
const settle = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

/** A row's laid-out height: most rows 113, a wrapped subject 131, a sender line 149. */
const natural = (id: string) => [113, 113, 113, 113, 113, 113, 131, 131, 149, 113][parseInt(id.slice(-4), 16) % 10]!;
/** The fold's viewport under the bar, the list head, and the panel foot plus the tail line. */
const VIEW = 810, HEAD = 214, FOOT = 140;

/**
 * The screen, as `history.tsx` wires it: the slot ledger hands the list its layout, a cell that lays
 * out a row records its height, `HistoryAsks` asks on every scroll, at the press and after every
 * render. The list is React Native's window over a model of the native flow: rendered cells at their
 * drawn heights, spacers sized from the list's own metrics, the position hold, the offset clamped.
 */
class Screen {
  heights = new SlotHeights();
  asks = new HistoryAsks(this.heights);
  win: Range = { first: 0, last: LIST_WINDOW.initialNumToRender - 1 };
  metrics = new ListMetricsAggregator();
  top = 0;
  y = 0;
  content = 0;
  frames = new Map<number, { y: number; h: number }>();
  mountedMax = 0;
  blankFrames: string[] = [];
  constructor(readonly walker: StoreTimelineWalker, readonly what: string) {}

  get n() { return this.walker.length(0); }
  row(i: number) { return this.walker.rowAt(i, []); }
  private props() {
    const n = this.n;
    const sections = planSections([{ key: "history", rows: Array.from({ length: n }, (_, i) => i) }]);
    const getItemLayout = sectionItemLayout(sections, {
      offsetOf: (i) => this.heights.offsetOf(i),
      lengthOf: (i) => (this.row(i) === "gone" ? 0 : this.heights.heightOf(i)),
    }, HEAD)!;
    return { data: sections, getItemCount: () => n + 2, getItem: (_: unknown, i: number) => i, getItemLayout,
      keyExtractor: (i: number) => (i === 0 ? "head" : i === n + 1 ? "foot" : `slot-${i - 1}`) };
  }
  private rendered(): [number, number][] {
    const end = this.n + 1;
    const spans = [[0, Math.min(end, LIST_WINDOW.initialNumToRender - 1)], [this.win.first, Math.min(end, this.win.last)]].sort((a, b) => a[0]! - b[0]!);
    const out: [number, number][] = [];
    for (const [a, b] of spans as [number, number][]) {
      const last = out[out.length - 1];
      if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  }
  /**
   * One render and its layout, to a fixpoint of recorded heights. The position hold
   * (`maintainVisibleContentPosition`, both platforms) keeps the first cell the viewport's top edge
   * meets where it stood, as the native helpers do.
   */
  private flow(): boolean {
    const p = this.props();
    const n = this.n;
    let moved = false;
    const anchor = [...this.frames].filter(([c, f]) => c >= 1 && f.y + f.h > this.y).sort((a, b) => a[1].y - b[1].y)[0];
    for (let pass = 0; pass < 20; pass++) {
      let y = HEAD;
      let at = 0;
      const frames = new Map<number, { y: number; h: number }>();
      const spacer = (a: number, b: number) => {
        const f = this.metrics.getCellMetricsApprox(a, p), l = this.metrics.getCellMetricsApprox(b, p);
        y += l.offset + l.length - f.offset;
      };
      for (const [a, b] of this.rendered()) {
        if (a > at) spacer(at, a - 1);
        for (let c = a; c <= b; c++) {
          const h = c === 0 || c === n + 1 || this.row(c - 1) === "gone" ? 0 : this.heights.heightOf(c - 1);
          frames.set(c, { y, h });
          y += h;
        }
        at = b + 1;
      }
      if (at <= n + 1) spacer(at, n + 1);
      this.content = y + FOOT;
      this.frames = frames;
      this.mountedMax = Math.max(this.mountedMax, frames.size);
      this.metrics.notifyListContentLayout({ orientation: { horizontal: false, rtl: false }, layout: { width: 400, height: this.content } });
      let redraw = false;
      for (const [c, f] of frames) {
        const layout = { x: 0, y: f.y, width: 400, height: f.h };
        if (this.metrics.notifyCellLayout({ cellIndex: c, cellKey: p.keyExtractor(c), orientation: { horizontal: false, rtl: false }, layout })) moved = true;
        if (c === 1) this.top = f.y;
        const m = c >= 1 && c <= n ? this.row(c - 1) : null;
        if (m !== null && m !== "gone" && this.heights.record(c - 1, natural(m.id))) redraw = true;
      }
      if (!redraw) break;
      moved = true;
    }
    const after = anchor ? this.frames.get(anchor[0]) : undefined;
    if (anchor && after && after.y !== anchor[1].y) this.y += after.y - anchor[1].y;
    const clamped = Math.min(Math.max(0, this.content - VIEW), Math.max(0, this.y));
    if (clamped !== this.y) moved = true;
    this.y = clamped;
    return moved;
  }
  /** The list's window and the screen's asks after a scroll, a landing or a render, until still. */
  render(velocity = 0) {
    for (let k = 0; k < 300; k++) {
      const next = this.metrics.getContentLength() > 0
        ? computeWindowedRenderLimits(this.props(), LIST_WINDOW.maxToRenderPerBatch, LIST_WINDOW.windowSize, this.win, this.metrics,
          { dt: 16, offset: this.y, velocity, visibleLength: VIEW, zoomScale: 1 })
        : this.win;
      const windowMoved = next.first !== this.win.first || next.last !== this.win.last;
      this.win = next;
      const flowed = this.flow();
      if (!windowMoved && !flowed) break;
    }
    this.asks.again(this.walker);
    const s = this.shown();
    if (s.rows + s.holes === 0) this.blankFrames.push(`${this.what} @${Math.round(this.y)} window ${this.win.first}-${this.win.last}`);
  }
  scrollEvent() {
    this.asks.scrolled(this.walker, this.y - this.top, VIEW, this.n);
  }
  /** The viewport: filled rows, placeholders, and the months the rows are from. */
  shown() {
    let rows = 0, holes = 0;
    const months = new Set<string>();
    for (const [c, f] of this.frames) {
      if (c < 1 || c > this.n || f.h === 0 || f.y + f.h <= this.y || f.y >= this.y + VIEW) continue;
      const m = this.row(c - 1);
      if (m === null) holes += 1;
      else if (m !== "gone") { rows += 1; months.add(m.date?.slice(0, 4) ?? "undated"); }
    }
    return { rows, holes, months: [...months] };
  }
  async open() {
    this.walker.start();
    await settle(10);
    this.render();
    this.scrollEvent();
    await this.idle(20);
  }
  /** Renders only — no finger on the glass — for `ticks` turns of the event loop. */
  async idle(ticks: number) {
    for (let t = 0; t < ticks; t++) {
      await settle();
      this.render();
    }
  }
  async press(start: number) {
    this.y = this.top + this.asks.jumped(this.walker, start, VIEW, this.n);
    this.render();
    this.scrollEvent();
    this.render();
  }
  /** A swipe of `dy` points read as `events` scroll events (the screen's 100 ms throttle). */
  async swipe(dy: number, events: number) {
    for (let e = 0; e < events; e++) {
      this.y += dy / events;
      this.render(dy / events / 100);
      this.scrollEvent();
      await settle(1);
      this.render();
    }
  }
}

/** The tester's shape: the rows of one year, one on 2 January 2024, two undated. */
const TESTER = () => mailbox([[4037, "2026-01-01", "2026-10-09"], [1, "2024-01-02", "2024-01-03"]], 2);
/** Three years, the middle one long. */
const SPREAD = () => mailbox([[2600, "2026-01-01", "2026-10-09"], [1200, "2025-01-01", "2025-12-31"], [238, "2024-01-02", "2024-12-30"]], 2);
/**
 * December 2025's rows sit above January 2024's: the walk toward the row above the landing ends
 * on a page that starts AT that row, so the rows above it are the screen's to ask again.
 */
const SEAM = () => mailbox([[600, "2026-09-01", "2026-10-09"], [601, "2025-12-01", "2025-12-31"], [40, "2024-01-02", "2024-01-30"]], 0);
const yearStart = (w: StoreTimelineWalker, y: string) => w.segments().find((s) => s.month?.startsWith(y))!.start;

describe("a rail press on the phone fills around its landing", () => {
  it("2024 at the list's end: the rows above it fill with no scroll, and a small swipe back up never blanks", async () => {
    const { walker } = await walkerOver(TESTER());
    const s = new Screen(walker, "tester");
    await s.open();
    await s.press(yearStart(walker, "2024"));
    await s.idle(40);
    const landed = s.shown();
    expect(landed.months).toContain("2024");
    expect(landed.holes, "placeholders left above the landing").toBe(0);
    expect(landed.months, "the rows above it are January 2026's").toContain("2026");
    await s.swipe(-200, 2);
    await s.idle(40);
    expect(s.shown().holes).toBe(0);
    expect(s.shown().rows).toBeGreaterThan(4);
    expect(s.blankFrames, "frames with no row over a mailbox of 4,040").toEqual([]);
    walker.stop();
  });

  it("a year in the middle lands with its rows and the year above filled, and either direction fills", async () => {
    const { walker } = await walkerOver(SPREAD());
    const s = new Screen(walker, "spread");
    await s.open();
    await s.press(yearStart(walker, "2025"));
    await s.idle(40);
    expect(s.shown().months).toEqual(["2025"]);
    expect(s.shown().holes).toBe(0);
    await s.swipe(-300, 2);
    await s.idle(40);
    expect(s.shown().months).toContain("2026");
    expect(s.shown().holes).toBe(0);
    await s.swipe(900, 3);
    await s.idle(40);
    expect(s.shown().holes).toBe(0);
    await s.press(yearStart(walker, "2024"));
    await s.idle(40);
    expect(s.shown().months).toContain("2024");
    expect(s.shown().holes).toBe(0);
    expect(s.blankFrames).toEqual([]);
    walker.stop();
  });

  it("where the walk above ends on the row above the landing, the screen asks the rest of its rows", async () => {
    const rows = SEAM();
    const { walker } = await walkerOver(rows);
    const s = new Screen(walker, "seam");
    await s.open();
    const start = yearStart(walker, "2024");
    const dec = walker.segments().find((x) => x.month === "2025-12")!;
    expect((start - 1 - dec.start) % HISTORY_PAGE_ROWS, "the walk's last page starts at the row above").toBe(0);
    await s.press(start);
    await s.idle(40);
    expect(s.shown().months).toEqual(["2024"]);
    await s.swipe(-250, 1);
    await s.idle(40);
    expect(s.shown().months).toContain("2025");
    expect(s.shown().holes, "the rows above the walk's last page").toBe(0);
    expect(s.blankFrames).toEqual([]);
    walker.stop();
  });
});

describe("rows that cannot load say so, and load once they can", () => {
  it("a press whose pages fail shows the sentence, and the rows fill after the pause with no scroll", async () => {
    const { walker, net } = await walkerOver(TESTER());
    const s = new Screen(walker, "offline");
    await s.open();
    net.down = true;
    await s.press(yearStart(walker, "2024"));
    await s.idle(20);
    expect(s.shown().holes).toBeGreaterThan(0);
    expect(walker.pagesFailing(), "the placeholders say they did not load").toBe(true);
    net.down = false;
    net.clock += 6_000;
    await s.idle(60);
    expect(s.shown().holes).toBe(0);
    expect(s.shown().months).toContain("2024");
    expect(walker.pagesFailing()).toBe(false);
    expect(s.blankFrames).toEqual([]);
    walker.stop();
  });
});

describe("controls", () => {
  it("an ordinary scroll from the top fills each screen, and the list stays windowed", async () => {
    const { walker, engine } = await walkerOver(SPREAD());
    const s = new Screen(walker, "scroll");
    await s.open();
    let cacheMax = 0;
    for (let k = 0; k < 40; k++) {
      await s.swipe(600, 2);
      await s.idle(6);
      cacheMax = Math.max(cacheMax, engine.storePageCacheRows());
      expect(s.shown().holes, `screen ${k}`).toBe(0);
    }
    expect(s.blankFrames).toEqual([]);
    // The window, never the mailbox: RN's own bound over the shortest row, and the page cache's.
    expect(s.mountedMax).toBeLessThanOrEqual(mountedRowsBound(LIST_WINDOW, VIEW, 113) + LIST_WINDOW.initialNumToRender + 2);
    expect(cacheMax).toBeLessThanOrEqual(HISTORY_PAGE_CACHE_ROWS);
    walker.stop();
  });

  it("the screen asks through HistoryAsks on scroll, at the press and after every render", () => {
    const src = withoutComments(readFileSync(fileURLToPath(new URL("../app/history.tsx", import.meta.url)), "utf8"));
    expect(src).toContain("asks.scrolled(h, contentOffset.y - top.current, viewport.current, h.length)");
    expect(src).toContain("scrollTo.current?.(top.current + asks.jumped(h, start, viewport.current, h.length))");
    expect(src).toMatch(/useEffect\(\(\) => \{\s*asks\.again\(h\);\s*\}, \[asks, h\]\);/);
    expect(src).not.toMatch(/\bh\.want\(/);
    expect(src).not.toMatch(/\bh\.jump\(/);
  });

  it("a placeholder whose page did not load says so in the row", () => {
    const src = withoutComments(readFileSync(fileURLToPath(new URL("../app/history.tsx", import.meta.url)), "utf8"));
    expect(src).toContain("m === null && h.pagesFailing ? (");
    expect(src).toContain("{Copy.historyRowsNotLoaded}");
    const views = withoutComments(readFileSync(fileURLToPath(new URL("../src/state/store-views.ts", import.meta.url)), "utf8"));
    expect(views).toContain("pagesFailing: walker ? walker.pagesFailing() : false");
  });
});
