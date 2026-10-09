/**
 * HISTORY AND SEARCH AS THE STORE'S PAGES, framework-free — the one list mechanism both the
 * browser and the phone render. Every row is a slot; rows come from the engine's bounded page
 * cache, placed by every page start and end the walk has seen (positions, never rows). A slot far
 * from any known position is reached by UNCACHED walk steps, so a walk never evicts what is on
 * screen, and a page evicted off screen is asked again from its own position on the way back.
 */
import { errorClassOf, type OhmailEngine, type ServerSearchFacets, type ServerSearchOutcome } from "./engine.js";
import {
  HISTORY_PAGE_ROWS, segmentAt, storeInstantOf, storeKeyOf, storeSearchList, timelineSegments,
  type StoreKeyset, type StoreSearchKey, type StoreTimeline, type TimelineSegment,
} from "./store-pages.js";
import type { EngineMessage } from "./types.js";
import type { SearchPhaseVerdict, WindowSearchPhases } from "./search-phases.js";

/** How long a list waits for the store before it says so — Search's ceiling. */
export const STORE_ANSWER_TIMEOUT_MS = 15_000;

/** A page that failed is asked again no sooner than this, on the window's next move. */
export const STORE_PAGE_RETRY_MS = 5_000;

export type StoreTimelineState = "unavailable" | "loading" | "ready" | "unanswered";

/** One page as a walk reads it: its rows and the position the page after it starts from. */
export type PageAnswer<A> =
  | { state: "ready"; items: readonly EngineMessage[]; next: A | null }
  | { state: "failed" | "unavailable"; errorClass?: string };

/** Where a walk reads its pages: History's keyset pages, Search's cursor pages. */
export interface PageSource<A> {
  ask(anchor: A | null, o: { at: number; transient: boolean }): Promise<PageAnswer<A>>;
  /** The cached page asked at this anchor, or `undefined`. */
  peek(anchor: A | null): readonly EngineMessage[] | undefined;
  /** A row's own position, when rows carry one (a keyset does; a cursor does not). */
  anchorOf?: (m: EngineMessage) => A;
  /** Drop a page's leading rows another held page already shows (a cursor seam can overlap). */
  dedupe?: boolean;
}

interface Run<A> {
  start: number;
  anchor: A | null;
}

/**
 * THE WALK: runs of cached pages at their slots, the anchors every page end has taught, at most
 * one request per direction in flight, a failed position asked again only after
 * {@link STORE_PAGE_RETRY_MS}. Positions are kept for every page seen; rows never are.
 */
export class PagedWalk<A> {
  private runs: Run<A>[] = [];
  private anchors = new Map<number, A | null>([[0, null]]);
  private skips = new Map<number, number>();
  private inFlight = { down: false, up: false };
  /** The newest slot wanted in each lane — asked when the lane frees, so a walk outlives the move that began it. */
  private owed: { down: number | null; up: number | null } = { down: null, up: null };
  /** The last page answered was a failure — the rows it would have filled say so. */
  failing = false;
  private failedAt = new Map<string, number>();
  private epoch = 0;
  private heldKey = "";
  private heldRows: { start: number; items: readonly EngineMessage[] }[] = [];
  /** Rows kept drawn at their slots while a new frame's pages are asked — {@link reframe}. */
  private stand: { start: number; items: readonly EngineMessage[] }[] = [];
  /** Rows placed above every position so far — an answer asked before a move lands that much lower. */
  private moved = 0;
  /** The slot past the last row, once a page answered that it was the last. */
  end: number | null = null;
  /** The furthest slot any page has reached. */
  reached = 0;

  constructor(
    private readonly engine: OhmailEngine,
    private readonly source: PageSource<A>,
    private readonly hooks: {
      clock: () => number;
      rev: () => number;
      changed: () => void;
      /** Is slot `p` inside the list at all — History's timeline bound. */
      inside?: (p: number) => boolean;
      /** The walker's own anchor at or above `p` — History's month starts. */
      extra?: (p: number) => { start: number; anchor: A | null } | null;
      landed?: (start: number, transient: boolean, answer: Extract<PageAnswer<A>, { state: "ready" }>) => void;
      failed?: (start: number, errorClass: string | null) => void;
    },
  ) {}

  /** A new walk: nothing that answers for the old one is read. */
  reset(): void {
    this.epoch += 1;
    this.runs = [];
    this.anchors = new Map([[0, null]]);
    this.skips.clear();
    this.inFlight = { down: false, up: false };
    this.owed = { down: null, up: null };
    this.failing = false;
    this.failedAt.clear();
    this.end = null;
    this.reached = 0;
    this.heldKey = "";
    this.stand = [];
  }

  /** The walk ended: answers still in the air are not read. */
  stop(): void {
    this.epoch += 1;
  }

  /** The cached rows of each live run — recomputed when the walk or the page cache moved. */
  held(): { start: number; items: readonly EngineMessage[] }[] {
    const key = `${this.hooks.rev()}:${this.engine.storePagesRevision()}`;
    if (key === this.heldKey) return this.heldRows;
    const out: { start: number; items: readonly EngineMessage[] }[] = [];
    for (const r of this.runs) {
      const items = this.source.peek(r.anchor);
      if (items !== undefined) out.push({ start: r.start, items: items.slice(this.skips.get(r.start) ?? 0) });
    }
    this.heldKey = key;
    this.heldRows = out;
    return out;
  }

  /** The cached page rows that start at slot `start`, or `undefined`. */
  pageAt(start: number): readonly EngineMessage[] | undefined {
    return this.held().find((h) => h.start === start)?.items;
  }

  /** The row in slot `i`: a message, `"gone"` where it was deleted, `null` not fetched. */
  rowAt(i: number): EngineMessage | "gone" | null {
    const row = this.freshAt(i) ?? this.standingAt(i);
    return row === null ? null : this.engine.storePageRow(row) ?? "gone";
  }

  /** A held page's row at slot `i` — what the walk has read in its present frame. */
  private freshAt(i: number): EngineMessage | null {
    for (const h of this.held()) {
      const k = i - h.start;
      if (k >= 0 && k < h.items.length) return h.items[k]!;
    }
    return null;
  }

  /** Every page drawn now — the held ones and the standing ones — at its slot. */
  drawn(): { start: number; items: readonly EngineMessage[] }[] {
    return [...this.held(), ...this.stand];
  }

  private standingAt(i: number): EngineMessage | null {
    for (const h of this.stand) {
      const k = i - h.start;
      if (k >= 0 && k < h.items.length) return h.items[k]!;
    }
    return null;
  }

  /**
   * THE STORE'S NEW FRAME, TAKEN WHILE THE VISIT IS OPEN — a change below the pages read (an older
   * arrival, a message taken away) moved positions this walk cannot place. Every position goes and
   * page one lands at once; the rows `stand` names stay drawn at their slots until pages asked again
   * cover them, so no mounted slot reads null in between.
   */
  reframe(pageOne: Extract<PageAnswer<A>, { state: "ready" }>, stand: { start: number; items: readonly EngineMessage[] }[]): void {
    this.reset();
    this.stand = stand;
    this.land(0, null, false, pageOne);
  }

  /** Ask the page that starts at `start`, from `anchor`; a `transient` step only learns positions. */
  fetch(start: number, anchor: A | null, dir: "down" | "up", transient = false): void {
    const epoch = this.epoch;
    const moved = this.moved;
    this.inFlight[dir] = true;
    void this.source.ask(anchor, { at: start, transient }).then((out) => {
      if (epoch !== this.epoch) return;
      this.inFlight[dir] = false;
      // Rows arrived above while this was in the air: it lands lower by as many. (Page one's own
      // null anchor is asked by `start` alone, before a visit can move.)
      this.land(start + this.moved - moved, anchor, transient, out);
      // The lane is free: the newest slot wanted in it is asked now (a walk's next step, or a
      // move made while this was in the air), unless a page holds it or this answer taught nothing.
      const owed = this.owed[dir];
      if (owed !== null && out.state === "ready" && out.items.length > 0 && this.freshAt(owed) === null) this.ask(owed, dir);
    });
  }

  /** A page's answer, at slot `start`: its run, the anchor after it, and how far the walk reached. */
  private land(start: number, anchor: A | null, transient: boolean, out: PageAnswer<A>): void {
    const key = JSON.stringify([start, anchor]);
    if (out.state !== "ready") {
      this.failing = out.state === "failed";
      this.failedAt.set(key, this.hooks.clock());
      this.hooks.failed?.(start, out.state === "failed" ? out.errorClass ?? null : null);
      this.hooks.changed();
      return;
    }
    this.failedAt.delete(key);
    this.failing = false;
    const skip = !transient && this.source.dedupe ? this.skipFor(start, out.items) : this.skips.get(start) ?? 0;
    const len = Math.max(0, out.items.length - skip);
    const next = out.next ?? (this.source.anchorOf && out.items.length > 0
      ? this.source.anchorOf(out.items[out.items.length - 1]!) : null);
    if (len > 0 && next !== null) this.anchors.set(start + len, next);
    this.reached = Math.max(this.reached, start + len);
    if (out.next === null && !this.source.anchorOf) this.end = start + len;
    if (!transient) {
      this.skips.set(start, skip);
      // Positions whose page the engine has since evicted go with this one's arrival.
      this.runs = [
        ...this.runs.filter((r) => r.start !== start && this.source.peek(r.anchor) !== undefined),
        { start, anchor },
      ];
      // A standing page goes once every slot it drew is read again.
      if (this.stand.length > 0) {
        this.heldKey = "";
        this.stand = this.stand.filter((h) => h.items.some((_, k) => this.freshAt(h.start + k) === null));
      }
    }
    this.hooks.landed?.(start, transient, out);
    this.hooks.changed();
  }

  /**
   * `k` ROWS ARRIVED ABOVE THE FIRST: every held position moves down by `k`, and a fresh page one
   * is placed at slot 0 in the same step, so no read sees the new rows at the old slots. `null`
   * where page one is not held (the reader is deep): it is asked from slot 0 when the window nears.
   */
  place(k: number, pageOne: Extract<PageAnswer<A>, { state: "ready" }> | null): void {
    const down = <V>(m: Map<number, V>): [number, V][] => [...m].filter(([s]) => s > 0).map(([s, v]) => [s + k, v]);
    this.moved += k;
    this.runs = this.runs.filter((r) => r.start > 0).map((r) => ({ start: r.start + k, anchor: r.anchor }));
    this.anchors = new Map<number, A | null>([[0, null], ...down(this.anchors)]);
    this.skips = new Map(down(this.skips));
    this.owed = { down: this.owed.down === null ? null : this.owed.down + k, up: this.owed.up === null ? null : this.owed.up + k };
    this.failedAt.clear();
    if (this.end !== null) this.end += k;
    this.reached += k;
    this.heldKey = "";
    this.stand = this.stand.map((h) => ({ start: h.start + k, items: h.items }));
    if (pageOne !== null) this.land(0, null, false, pageOne);
    else this.hooks.changed();
  }

  /** How many of a landing page's first rows another held page already shows. */
  private skipFor(start: number, items: readonly EngineMessage[]): number {
    if (this.skips.has(start)) return this.skips.get(start)!;
    const shown = new Set<string>();
    for (const h of this.held()) if (h.start !== start) for (const m of h.items) shown.add(m.id);
    let k = 0;
    while (k < items.length && shown.has(items[k]!.id)) k += 1;
    return k;
  }

  /** The nearest known position at or above slot `p` a page can start from. */
  private anchorFor(p: number): { start: number; anchor: A | null } | null {
    if (this.source.anchorOf) {
      for (const h of this.held()) {
        const k = p - 1 - h.start;
        if (k >= 0 && k < h.items.length) return { start: p, anchor: this.source.anchorOf(h.items[k]!) };
      }
    }
    if (this.hooks.inside && !this.hooks.inside(p)) return null;
    let best: { start: number; anchor: A | null } = { start: 0, anchor: null };
    const extra = this.hooks.extra?.(p);
    if (extra && extra.start >= best.start) best = extra;
    for (const [start, anchor] of this.anchors) {
      if (start <= p && start > best.start) best = { start, anchor };
    }
    return best;
  }

  /** Ask the page holding slot `p` in lane `dir`; a busy lane keeps it as the one it asks next. */
  ask(p: number, dir: "down" | "up"): void {
    if (p < 0) return;
    this.owed[dir] = p;
    if (this.inFlight[dir]) return;
    const a = this.anchorFor(p);
    if (a === null) return;
    const at = this.failedAt.get(JSON.stringify([a.start, a.anchor]));
    if (at !== undefined && this.hooks.clock() - at < STORE_PAGE_RETRY_MS) return;
    // Farther than a page from the anchor: an uncached step that only learns the next anchor.
    const transient = p - a.start >= HISTORY_PAGE_ROWS;
    if (!transient) this.owed[dir] = null;
    this.fetch(a.start, a.anchor, dir, transient);
  }

  /** Ask for the pages covering `[start, hi)` — at most one request per direction in flight. */
  want(start: number, hi: number): void {
    // A standing row is drawn, not read: its slot is asked like one nothing holds.
    let firstHeld = -1;
    for (let i = Math.max(0, start); i < hi; i++) {
      if (this.freshAt(i) !== null) {
        firstHeld = i;
        break;
      }
    }
    const missing = (from: number, to: number, step: 1 | -1): number => {
      for (let i = from; step > 0 ? i < to : i >= to; i += step) if (this.freshAt(i) === null) return i;
      return -1;
    };
    this.ask(missing(firstHeld < 0 ? Math.max(0, start) : firstHeld, hi, 1), "down");
    if (firstHeld > 0) this.ask(missing(firstHeld - 1, Math.max(0, start), -1), "up");
  }

  /** The page after the furthest one, unless the store said that was the last. */
  more(): void {
    if (this.end !== null || this.inFlight.down || !this.anchors.has(this.reached)) return;
    const at = this.failedAt.get(JSON.stringify([this.reached, this.anchors.get(this.reached)]));
    if (at !== undefined && this.hooks.clock() - at < STORE_PAGE_RETRY_MS) return;
    this.fetch(this.reached, this.anchors.get(this.reached)!, "down");
  }
}

const keysetOf = (m: EngineMessage): StoreKeyset => storeKeyOf(m);

/**
 * THE ANCHOR A NEXT PAGE IS ASKED BELOW: the row's HEADER date and its id. A server with the arrival
 * key positions the page on the named row's own key and ignores the date; a server from before it
 * pages by the header date, which is then the right one — so neither version skips or repeats.
 */
const anchorOf = (m: EngineMessage): StoreKeyset => ({ date: m.date ?? null, id: m.id });

/** Does `m` sort before position `k` in the store's order — `key desc, id desc` ({@link storeKeyOf}). */
function newerThan(m: EngineMessage, k: StoreKeyset): boolean {
  const a = storeInstantOf(m);
  const b = k.date === null ? 0 : Date.parse(k.date);
  return a !== b ? a > b : m.id > k.id;
}

/** A render subscription: bumped on every change a render can see. */
class Signal {
  private rev = 0;
  private readonly listeners = new Set<() => void>();
  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  readonly revision = (): number => this.rev;
  bump(): void {
    this.rev += 1;
    for (const fn of this.listeners) fn();
  }
}

/** HISTORY: every message the account owns, placed by the store's month rail. */
export class StoreTimelineWalker {
  private timeline: StoreTimeline | null = null;
  private segs: TimelineSegment[] = [];
  private failed = false;
  /** The first failure's class this visit — see {@link failureCause}. */
  private cause: string | null = null;
  private timedOut = false;
  private pageOne = false;
  private epoch = 0;
  private ceiling: ReturnType<typeof setTimeout> | null = null;
  private readonly signal = new Signal();
  private readonly walk: PagedWalk<StoreKeyset>;
  /** Rows placed above the first one since this walker began — {@link shifted}. */
  private shift = 0;
  /** Slot 0's position when page one was read: where the rows an arrival brings are counted from. */
  private topKey: StoreKeyset | null = null;
  private changesSeen = 0;
  private refreshing = false;
  private refreshOwed = false;
  private unsubscribe: (() => void) | null = null;
  /** The range the view last asked for — what a re-read of the frame asks again at once. */
  private lastWant: [number, number] = [0, 0];

  constructor(private readonly engine: OhmailEngine, clock: () => number = Date.now) {
    this.walk = new PagedWalk<StoreKeyset>(engine, {
      ask: (a, o) => engine.pageStore("all", { ...(a ? { before: a } : {}), ...(o.transient ? { transient: true } : {}), at: o.at })
        .then((out): PageAnswer<StoreKeyset> => (out.state === "ready" ? { state: "ready", items: out.items, next: null }
          : out.state === "failed" ? { state: "failed", errorClass: out.errorClass } : { state: "unavailable" })),
      peek: (a) => engine.peekStorePage("all", a ? { before: a } : {}),
      anchorOf,
    }, {
      clock,
      rev: this.signal.revision,
      changed: () => this.signal.bump(),
      inside: (p) => segmentAt(this.segs, p) !== null,
      extra: (p) => {
        let best: { start: number; anchor: StoreKeyset | null } | null = null;
        for (const s of this.segs) {
          if (s.start > p) break;
          if (best === null || s.start >= best.start) best = { start: s.start, anchor: s.before };
        }
        return best;
      },
      landed: (start, transient, answer) => {
        if (transient || start !== 0 || this.pageOne) return;
        this.pageOne = true;
        this.topKey = answer.items[0] ? keysetOf(answer.items[0]) : null;
        this.refresh();
      },
      failed: (start, errorClass) => {
        if (start !== 0) return;
        this.failed = true;
        if (this.cause === null) this.cause = errorClass;
      },
    });
  }

  /** For `useSyncExternalStore`: bumped on every change a render can see. */
  readonly subscribe = (fn: () => void): (() => void) => this.signal.subscribe(fn);
  readonly revision = (): number => this.signal.revision();
  /** The engine's completed drains — where a visit the wire failed hears the server answer again. */
  readonly drains = {
    completed: (): number => this.engine.drainsCompleted(),
    subscribe: (fn: () => void): (() => void) => this.engine.subscribe(fn),
  };

  /** A visit starts from the store's present: the timeline and page one, together. */
  start(): void {
    this.stop();
    const epoch = ++this.epoch;
    this.timeline = null;
    this.segs = [];
    this.failed = false;
    this.cause = null;
    this.timedOut = false;
    this.pageOne = false;
    this.topKey = null;
    this.refreshing = false;
    this.refreshOwed = false;
    this.walk.reset();
    this.signal.bump();
    if (!this.engine.storePagesAvailable()) return;
    this.changesSeen = this.engine.storeChanges();
    this.unsubscribe = this.engine.subscribe(this.onEngine);
    this.engine.resetStorePages("all");
    void this.engine.timeline().then((out) => {
      if (epoch !== this.epoch) return;
      if (out.state === "ready") {
        this.timeline = out.timeline;
        this.segs = timelineSegments(out.timeline);
      } else {
        this.failed = true;
        if (this.cause === null && out.state === "failed") this.cause = out.errorClass;
      }
      this.signal.bump();
      this.refresh();
    });
    this.walk.fetch(0, null, "down");
    this.ceiling = setTimeout(() => {
      if (epoch !== this.epoch) return;
      this.timedOut = true;
      this.signal.bump();
    }, STORE_ANSWER_TIMEOUT_MS);
  }

  /** The visit ended: nothing that answers after this is read. */
  stop(): void {
    this.epoch += 1;
    this.walk.stop();
    if (this.ceiling !== null) clearTimeout(this.ceiling);
    this.ceiling = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** An applied page changed the store's list (an arrival, a message taken away): the open visit is owed a re-read. */
  private readonly onEngine = (): void => {
    const n = this.engine.storeChanges();
    if (n === this.changesSeen) return;
    this.changesSeen = n;
    this.refreshOwed = true;
    this.refresh();
  };

  /**
   * MAIL REACHED THE STORE WHILE THE VISIT IS OPEN: the timeline and an uncached page one, asked
   * together once the visit is ready — one in flight and one owed at most. A refresh that fails
   * keeps the list on screen; the next arrival asks again.
   */
  private refresh(): void {
    if (!this.refreshOwed || this.refreshing || this.state() !== "ready") return;
    this.refreshOwed = false;
    this.refreshing = true;
    const epoch = this.epoch;
    void Promise.all([this.engine.timeline(), this.engine.pageStore("all", { fresh: true, at: 0 })]).then(([tl, page]) => {
      if (epoch !== this.epoch) return;
      this.refreshing = false;
      if (tl.state === "ready" && page.state === "ready") this.placeTop(tl.timeline, page);
      this.refresh();
    });
  }

  /**
   * THE NEW PAGE ONE, ABOVE WHAT WAS READ. The rows below it move by `s`: where the old page one
   * is held, the last row both pages hold says by how much (a row deleted or added inside it is
   * counted), else the rows newer than the old top. The store's months and total are taken either
   * way: where they agree with the walk its positions move by `s`; a change below the pages read
   * (an older arrival, a message taken away) re-reads the frame, the drawn rows standing meanwhile.
   */
  private placeTop(timeline: StoreTimeline, page: { items: EngineMessage[]; nextCursor: string | null }): void {
    const old = this.engine.peekStorePage("all");
    const items = page.items;
    let s = 0;
    if (old !== undefined) {
      const slot = new Map(old.map((m, i) => [m.id, i]));
      let i = items.length - 1;
      while (i >= 0 && !slot.has(items[i]!.id)) i -= 1;
      s = i >= 0 ? i - slot.get(items[i]!.id)! : items.length;
    } else {
      const top = this.topKey;
      while (s < items.length && (top === null || newerThan(items[s]!, top))) s += 1;
    }
    const was = this.length(0);
    const segs = timelineSegments(timeline);
    const now = segs.reduce((n, x) => n + x.count, 0);
    if (s > 0 && s === items.length) s = Math.max(s, now - was);
    this.topKey = items[0] ? keysetOf(items[0]) : null;
    this.shift += s;
    if (now === was + s || this.segs.length === 0) {
      this.timeline = timeline;
      this.segs = segs;
      // Held only where page one is: a put beside the reader's deep pages would evict them.
      if (old !== undefined) this.engine.holdStorePage("all", {}, page, 0);
      this.walk.place(s, old !== undefined ? { state: "ready", items, next: null } : null);
      return;
    }
    const stand = this.walk.drawn().map((h) => ({ start: h.start + s, items: h.items }));
    this.timeline = timeline;
    this.segs = segs;
    // Every cached page is of the old frame: asked again, never read from the cache.
    this.engine.resetStorePages("all");
    this.engine.holdStorePage("all", {}, page, 0);
    this.walk.reframe({ state: "ready", items, next: null }, stand);
    const [a, b] = this.lastWant;
    this.walk.want(a + s, Math.min(b + s, this.length(0)));
  }

  /** Rows placed above the list's first row since this walker began — what a view holds its reader by. */
  shifted(): number {
    return this.shift;
  }

  state(): StoreTimelineState {
    if (!this.engine.storePagesAvailable()) return "unavailable";
    if (this.timeline !== null && this.pageOne) return "ready";
    return this.failed || this.timedOut ? "unanswered" : "loading";
  }

  /** The store's own count, once it answered. */
  total(): number | null {
    return this.state() === "ready" ? this.timeline!.total : null;
  }

  /** Why the store did not answer this visit: the first failure's class, or `timeout`. */
  failureCause(): string | null {
    if (this.state() !== "unanswered") return null;
    return this.cause ?? (this.timedOut ? "timeout" : null);
  }

  segments(): readonly TimelineSegment[] {
    return this.segs;
  }

  /** Slots in the list: the timeline's once ready, else the mirror's first paint. */
  length(mirrorLength: number): number {
    return this.state() === "ready" ? this.segs.reduce((n, s) => n + s.count, 0) : mirrorLength;
  }

  /** The row in slot `i`: a message, `"gone"` where it was deleted, `null` unfetched. */
  rowAt(i: number, mirrorRows: readonly EngineMessage[]): EngineMessage | "gone" | null {
    if (this.state() !== "ready") return mirrorRows[i] ?? null;
    return this.walk.rowAt(i);
  }

  /** Ask for the pages covering `[start, end)` — at most one request per direction in flight. */
  want(start: number, end: number): void {
    this.lastWant = [start, end];
    if (this.state() !== "ready") return;
    this.walk.want(start, Math.min(end, this.length(0)));
  }

  /**
   * A RAIL PRESS: the page at that month's own anchor, asked at once, and the walk toward the rows
   * just above it begun in the other lane — so the press fills both sides with no scroll.
   */
  jump(start: number): void {
    const seg = this.segs.find((s) => s.start === start);
    if (!seg || this.state() !== "ready") return;
    if (this.walk.rowAt(start) === null) this.walk.fetch(seg.start, seg.before, "down");
    if (start > 0 && this.walk.rowAt(start - 1) === null) this.walk.ask(start - 1, "up");
  }

  /** A page this visit asked did not answer, and none has since — the rows it held say so. */
  pagesFailing(): boolean {
    return this.state() === "ready" && this.walk.failing;
  }
}

export type StoreSearchState = "idle" | "searching" | "ready" | "unanswered" | "unavailable";

/** What the store said about the whole match set: the page's reading, the estimate's, the summary's. */
export interface StoreSearchMeta {
  total: number;
  totalExact: boolean;
  /** While `total` is a lower bound: about how many match, from the estimate; `null` until it says. */
  about: number | null;
  tier: "exact" | "similar";
  ms: number | null;
  bounded: boolean;
  indexed: { done: number; total: number } | null;
  facets: ServerSearchFacets | null;
  /** The store has not taken in the whole mailbox: the latest answer's reading. */
  importing: boolean;
  /** Page one came from a paired desktop's mirror: the verdict is about the mail on this computer. */
  fromMirror: boolean;
}

/**
 * THE EXACT FACETS OVER THE ESTIMATE'S, IN PLACE: the chips keep the order they were drawn in and
 * take the exact counts; a sender or folder only the exact set names follows them, one it lacks goes.
 */
export function facetsInPlace(prev: ServerSearchFacets | null, next: ServerSearchFacets): ServerSearchFacets {
  if (prev === null) return next;
  const drawn = new Set(prev.sender.map((x) => x.address));
  const exact = new Map(next.sender.map((x) => [x.address, x]));
  const sender = [
    ...prev.sender.flatMap((x) => exact.get(x.address) ?? []),
    ...next.sender.filter((x) => !drawn.has(x.address)),
  ];
  const keys = [
    ...Object.keys(prev.folder).filter((k) => Object.hasOwn(next.folder, k)),
    ...Object.keys(next.folder).filter((k) => !Object.hasOwn(prev.folder, k)),
  ];
  return { ...next, sender, folder: Object.fromEntries(keys.map((k) => [k, next.folder[k]!])) };
}

/** How long a question settles before the store is asked — one request per question, not per key. */
export const STORE_SEARCH_DEBOUNCE_MS = 250;

/**
 * How long a TYPED question must stand before its count and facets are asked. The desktop's store
 * has one connection and cannot cancel: a typed prefix's summary, the slowest of the three asks,
 * would hold the next question's page behind it. A settled question (Enter) passes 0.
 */
export const STORE_SEARCH_FOLLOWUP_HOLD_MS = 600;

/**
 * SEARCH: one question's matches, a page at a time by the store's own cursor, on the same walk as
 * History. Under relevance the rows the device painted first keep their places in page one.
 */
export class StoreSearchWalker {
  private key: StoreSearchKey | null = null;
  private status: StoreSearchState = "idle";
  private meta: StoreSearchMeta | null = null;
  private order: string[] | null = null;
  private deviceIds: (tier: "exact" | "similar") => readonly string[] = () => [];
  private cause: string | null = null;
  private epoch = 0;
  /** This question's count and facets, waiting for its hold to end; `null` once asked or free. */
  private heldFollowUp: (() => void) | null = null;
  /** Has this question stood its hold (always true for a settled one)? */
  private followUpFree = true;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private readonly signal = new Signal();
  private readonly walk: PagedWalk<string>;
  /** This question's clock marks (`performance.now()`, the two instants `Date.now()`); see {@link painted}. */
  private marks: {
    epoch: number; start: number; fired: number | null; sent: number | null; sentAt: number | null;
    answered: number | null; answeredAt: number | null; verdict: SearchPhaseVerdict | null; serverMs: number | null;
    told: boolean;
  } | null = null;

  constructor(private readonly engine: OhmailEngine, clock: () => number = Date.now) {
    const askPage = (a: string | null, o: { at: number; transient: boolean }): Promise<PageAnswer<string>> => {
      const key = this.key;
      const epoch = this.epoch;
      if (key === null) return Promise.resolve({ state: "unavailable" });
      const first = a === null && !o.transient;
      const m = first && this.marks?.epoch === epoch && this.marks.sent === null ? this.marks : null;
      if (m) { m.sent = performance.now(); m.sentAt = Date.now(); }
      return engine.pageSearch(key, { cursor: a, at: o.at, transient: o.transient })
        .then((out: ServerSearchOutcome): PageAnswer<string> => {
          const mine = first && epoch === this.epoch;
          if (m) {
            m.answered = performance.now(); m.answeredAt = Date.now();
            m.verdict = out.state !== "ready" ? "failed" : out.fromMirror ? "mirror"
              : out.total === 0 && out.totalExact ? "nothing" : "matched";
            m.serverMs = out.state === "ready" ? out.ms : null;
          }
          if (out.state !== "ready") {
            if (mine && out.state === "unavailable") this.status = "unavailable";
            if (mine && out.state === "failed") this.cause = out.errorClass;
            return { state: out.state };
          }
          if (mine && this.meta === null) this.firstPage(out);
          return { state: "ready", items: out.items, next: out.nextCursor };
        }, (err: unknown): PageAnswer<string> => {
          if (first && epoch === this.epoch) this.cause = errorClassOf(err);
          return { state: "failed" };
        });
    };
    this.walk = new PagedWalk<string>(engine, {
      ask: askPage,
      peek: (a) => (this.key === null ? undefined : engine.peekSearchPage(this.key, a)),
      dedupe: true,
    }, {
      clock,
      rev: this.signal.revision,
      changed: () => this.signal.bump(),
      failed: (start) => {
        if (start === 0 && this.status === "searching" && this.meta === null) this.status = "unanswered";
      },
    });
  }

  readonly subscribe = (fn: () => void): (() => void) => this.signal.subscribe(fn);
  readonly revision = (): number => this.signal.revision();

  /**
   * A NEW QUESTION: the old one's pages go, "searching" at once, the store asked after the
   * debounce, "unanswered" after {@link STORE_ANSWER_TIMEOUT_MS} — a late answer still wins.
   */
  start(
    key: StoreSearchKey, deviceIds: (tier: "exact" | "similar") => readonly string[],
    debounceMs = STORE_SEARCH_DEBOUNCE_MS, followupHoldMs = 0,
  ): void {
    this.stop();
    if (this.key !== null) this.engine.resetStorePages(storeSearchList(this.key));
    this.engine.resetStorePages(storeSearchList(key));
    const epoch = ++this.epoch;
    this.key = key;
    this.deviceIds = deviceIds;
    this.meta = null;
    this.order = null;
    this.cause = null;
    this.walk.reset();
    this.status = this.engine.serverSearchAvailable() ? "searching" : "unavailable";
    this.marks = {
      epoch, start: performance.now(), fired: null, sent: null, sentAt: null, answered: null, answeredAt: null,
      verdict: null, serverMs: null, told: false,
    };
    this.heldFollowUp = null;
    this.followUpFree = followupHoldMs <= 0;
    if (!this.followUpFree) {
      this.timers.push(setTimeout(() => {
        if (epoch !== this.epoch) return;
        this.followUpFree = true;
        const go = this.heldFollowUp;
        this.heldFollowUp = null;
        go?.();
      }, followupHoldMs));
    }
    this.signal.bump();
    if (this.status === "unavailable") return;
    this.timers.push(setTimeout(() => {
      if (epoch !== this.epoch) return;
      if (this.marks?.epoch === epoch) this.marks.fired = performance.now();
      this.walk.fetch(0, null, "down");
    }, debounceMs));
    this.timers.push(setTimeout(() => {
      if (epoch !== this.epoch || this.status !== "searching") return;
      this.status = "unanswered";
      this.cause = "timeout";
      this.signal.bump();
    }, STORE_ANSWER_TIMEOUT_MS));
  }

  /** No question: nothing asked, nothing held. */
  clear(): void {
    this.stop();
    if (this.key !== null) this.engine.resetStorePages(storeSearchList(this.key));
    this.key = null;
    this.meta = null;
    this.order = null;
    this.walk.reset();
    this.status = "idle";
    this.signal.bump();
  }

  /** The visit ended: nothing that answers after this is read. */
  stop(): void {
    this.epoch += 1;
    this.walk.stop();
    for (const t of this.timers.splice(0)) clearTimeout(t);
  }

  private firstPage(out: Extract<ServerSearchOutcome, { state: "ready" }>): void {
    const epoch = this.epoch;
    this.meta = {
      total: out.total, totalExact: out.totalExact, about: null, tier: out.tier, ms: out.ms, bounded: out.bounded,
      indexed: out.indexed, facets: out.facets, importing: out.importing === true, fromMirror: out.fromMirror === true,
    };
    this.status = "ready";
    if ((this.key?.sort ?? "relevance") === "relevance") {
      const ids = new Set(out.items.map((m) => m.id));
      const kept = this.deviceIds(out.tier).filter((id) => ids.has(id));
      const keptSet = new Set(kept);
      this.order = [...kept, ...out.items.filter((m) => !keptSet.has(m.id)).map((m) => m.id)];
    }
    const key = this.key!;
    const filters = key.filters ? { filters: key.filters } : {};
    // THE PAGE, THEN THE ESTIMATE, THEN THE SUMMARY ONLY WHEN THE ESTIMATE WAS CUT: the count and
    // facets follow the page at its cost, and the exact count replaces "about N" when it lands.
    // An estimate that failed (an older store refuses the part) is not exact: the summary follows.
    // A count from the other store (the account's under a mirror page, or the reverse) is not read.
    const sameStore = (o: { fromMirror?: true }): boolean => (o.fromMirror === true) === this.meta?.fromMirror;
    // HELD while a typed question may still change; a new question clears the hold's timer.
    const go = (): void => { if (epoch === this.epoch) this.followUp(key, filters, sameStore); };
    if (this.followUpFree) go();
    else this.heldFollowUp = go;
  }

  /** The count and facets after the page: the estimate, then the summary only when it was cut. */
  private followUp(
    key: StoreSearchKey, filters: { filters?: StoreSearchKey["filters"] }, sameStore: (o: { fromMirror?: true }) => boolean,
  ): void {
    const epoch = this.epoch;
    void this.engine.searchServer(key.query, { parts: "estimate", limit: HISTORY_PAGE_ROWS, ...filters }).then((est) => {
      if (epoch !== this.epoch || this.meta === null) return;
      if (est.state === "ready" && sameStore(est)) {
        this.meta = {
          ...this.meta,
          ...(est.totalExact ? { total: est.total, totalExact: true, about: null } : { about: est.totalEstimate }),
          facets: est.facets ?? this.meta.facets,
          indexed: est.indexed,
          importing: est.importing === true,
        };
        this.signal.bump();
        if (est.totalExact) return;
      }
      void this.engine.searchServer(key.query, { parts: "summary", ...filters }).then((sum) => {
        if (epoch !== this.epoch || sum.state !== "ready" || this.meta === null || !sameStore(sum)) return;
        this.meta = {
          ...this.meta,
          ...(sum.totalExact ? { total: sum.total, totalExact: true, about: null } : {}),
          facets: sum.facets ? facetsInPlace(this.meta.facets, sum.facets) : this.meta.facets,
          indexed: sum.indexed,
          importing: sum.importing === true,
        };
        this.signal.bump();
      }, () => undefined);
    }, () => undefined);
  }

  /**
   * THE VERDICT IS ON SCREEN — the view calls this after committing the render that shows it. Once
   * per question, and only after its first page answered: hands the engine this question's timings
   * ({@link WindowSearchPhases}), which reach a desktop's engine log and nowhere else.
   */
  painted(): void {
    const m = this.marks;
    if (m === null || m.told || m.epoch !== this.epoch || m.fired === null || m.sent === null || m.answered === null
      || m.sentAt === null || m.answeredAt === null || m.verdict === null) return;
    m.told = true;
    const now = performance.now();
    const ms = (a: number, b: number): number => Math.max(0, Math.round(b - a));
    this.engine.reportSearchPhases({
      verdict: m.verdict, debounceMs: ms(m.start, m.fired), sendMs: ms(m.fired, m.sent), roundTripMs: ms(m.sent, m.answered),
      paintMs: ms(m.answered, now), totalMs: ms(m.start, now), serverMs: m.serverMs === null ? null : Math.round(m.serverMs),
      sentAtMs: m.sentAt, answeredAtMs: m.answeredAt,
    } satisfies WindowSearchPhases);
  }

  state(): StoreSearchState {
    return this.status;
  }

  /** Which question the state is about — bumped by every {@link start} and {@link clear}. */
  question(): number {
    return this.epoch;
  }

  /** Why the store did not answer this question: a failure's class, or `timeout`. */
  failureCause(): string | null {
    return this.status === "unanswered" ? this.cause : null;
  }

  /** The store's reading of the match set, once page one answered. */
  info(): StoreSearchMeta | null {
    return this.status === "ready" ? this.meta : null;
  }

  /** Slots walked so far — the list grows as {@link more} reaches further. */
  length(): number {
    return this.status === "ready" ? this.walk.reached : 0;
  }

  /** Has the store said the last page came back? */
  atEnd(): boolean {
    return this.walk.end !== null;
  }

  /** The row in slot `i`: a message, `"gone"` where it was deleted, `null` not fetched. */
  rowAt(i: number): EngineMessage | "gone" | null {
    if (this.status !== "ready") return null;
    if (this.order !== null && i < this.order.length) {
      const page = this.walk.pageAt(0);
      if (page === undefined) return null;
      const m = page.find((x) => x.id === this.order![i]);
      return m ? this.engine.storePageRow(m) ?? "gone" : "gone";
    }
    return this.walk.rowAt(i);
  }

  /** Ask for the pages covering `[start, end)` — evicted pages are re-asked by their cursor. */
  want(start: number, end: number): void {
    if (this.status === "ready") this.walk.want(start, Math.min(end, this.length()));
  }

  /** Near the end of the list: the store's next page. */
  more(): void {
    if (this.status === "ready") this.walk.more();
  }
}
