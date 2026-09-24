/**
 * HISTORY AND SEARCH AS THE STORE'S PAGES, framework-free — the one list mechanism both the
 * browser and the phone render. Every row is a slot; rows come from the engine's bounded page
 * cache, placed by every page start and end the walk has seen (positions, never rows). A slot far
 * from any known position is reached by UNCACHED walk steps, so a walk never evicts what is on
 * screen, and a page evicted off screen is asked again from its own position on the way back.
 */
import { errorClassOf, type OhmailEngine, type ServerSearchFacets, type ServerSearchOutcome } from "./engine.js";
import {
  HISTORY_PAGE_ROWS, segmentAt, storeSearchList, timelineSegments,
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
  | { state: "failed" | "unavailable" };

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
  private failedAt = new Map<string, number>();
  private epoch = 0;
  private heldKey = "";
  private heldRows: { start: number; items: readonly EngineMessage[] }[] = [];
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
      failed?: (start: number) => void;
    },
  ) {}

  /** A new walk: nothing that answers for the old one is read. */
  reset(): void {
    this.epoch += 1;
    this.runs = [];
    this.anchors = new Map([[0, null]]);
    this.skips.clear();
    this.inFlight = { down: false, up: false };
    this.failedAt.clear();
    this.end = null;
    this.reached = 0;
    this.heldKey = "";
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
    for (const h of this.held()) {
      const k = i - h.start;
      if (k >= 0 && k < h.items.length) return this.engine.storePageRow(h.items[k]!) ?? "gone";
    }
    return null;
  }

  /** Ask the page that starts at `start`, from `anchor`; a `transient` step only learns positions. */
  fetch(start: number, anchor: A | null, dir: "down" | "up", transient = false): void {
    const epoch = this.epoch;
    this.inFlight[dir] = true;
    void this.source.ask(anchor, { at: start, transient }).then((out) => {
      if (epoch !== this.epoch) return;
      this.inFlight[dir] = false;
      const key = JSON.stringify([start, anchor]);
      if (out.state !== "ready") {
        this.failedAt.set(key, this.hooks.clock());
        this.hooks.failed?.(start);
        this.hooks.changed();
        return;
      }
      this.failedAt.delete(key);
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
      }
      this.hooks.landed?.(start, transient, out);
      this.hooks.changed();
    });
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

  private ask(p: number, dir: "down" | "up"): void {
    if (p < 0 || this.inFlight[dir]) return;
    const a = this.anchorFor(p);
    if (a === null) return;
    const at = this.failedAt.get(JSON.stringify([a.start, a.anchor]));
    if (at !== undefined && this.hooks.clock() - at < STORE_PAGE_RETRY_MS) return;
    // Farther than a page from the anchor: an uncached step that only learns the next anchor.
    this.fetch(a.start, a.anchor, dir, p - a.start >= HISTORY_PAGE_ROWS);
  }

  /** Ask for the pages covering `[start, hi)` — at most one request per direction in flight. */
  want(start: number, hi: number): void {
    let firstHeld = -1;
    for (let i = Math.max(0, start); i < hi; i++) {
      if (this.rowAt(i) !== null) {
        firstHeld = i;
        break;
      }
    }
    const missing = (from: number, to: number, step: 1 | -1): number => {
      for (let i = from; step > 0 ? i < to : i >= to; i += step) if (this.rowAt(i) === null) return i;
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

const keysetOf = (m: EngineMessage): StoreKeyset => ({ date: m.date ?? null, id: m.id });

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
  private timedOut = false;
  private pageOne = false;
  private epoch = 0;
  private ceiling: ReturnType<typeof setTimeout> | null = null;
  private readonly signal = new Signal();
  private readonly walk: PagedWalk<StoreKeyset>;

  constructor(private readonly engine: OhmailEngine, clock: () => number = Date.now) {
    this.walk = new PagedWalk<StoreKeyset>(engine, {
      ask: (a, o) => engine.pageStore("all", { ...(a ? { before: a } : {}), ...(o.transient ? { transient: true } : {}), at: o.at })
        .then((out) => (out.state === "ready" ? { state: "ready" as const, items: out.items, next: null } : { state: out.state })),
      peek: (a) => engine.peekStorePage("all", a ? { before: a } : {}),
      anchorOf: keysetOf,
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
      landed: (start, transient) => {
        if (!transient && start === 0) this.pageOne = true;
      },
      failed: (start) => {
        if (start === 0) this.failed = true;
      },
    });
  }

  /** For `useSyncExternalStore`: bumped on every change a render can see. */
  readonly subscribe = (fn: () => void): (() => void) => this.signal.subscribe(fn);
  readonly revision = (): number => this.signal.revision();

  /** A visit starts from the store's present: the timeline and page one, together. */
  start(): void {
    this.stop();
    const epoch = ++this.epoch;
    this.timeline = null;
    this.segs = [];
    this.failed = false;
    this.timedOut = false;
    this.pageOne = false;
    this.walk.reset();
    this.signal.bump();
    if (!this.engine.storePagesAvailable()) return;
    this.engine.resetStorePages("all");
    void this.engine.timeline().then((out) => {
      if (epoch !== this.epoch) return;
      if (out.state === "ready") {
        this.timeline = out.timeline;
        this.segs = timelineSegments(out.timeline);
      } else this.failed = true;
      this.signal.bump();
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
    if (this.state() !== "ready") return;
    this.walk.want(start, Math.min(end, this.length(0)));
  }

  /** A rail press: the page at that month's own anchor, asked at once. */
  jump(start: number): void {
    const seg = this.segs.find((s) => s.start === start);
    if (seg && this.state() === "ready" && this.walk.rowAt(start) === null) this.walk.fetch(seg.start, seg.before, "down");
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
    debounceMs = STORE_SEARCH_DEBOUNCE_MS,
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
      indexed: out.indexed, facets: out.facets, fromMirror: out.fromMirror === true,
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
    void this.engine.searchServer(key.query, { parts: "estimate", limit: HISTORY_PAGE_ROWS, ...filters }).then((est) => {
      if (epoch !== this.epoch || this.meta === null) return;
      if (est.state === "ready" && sameStore(est)) {
        this.meta = {
          ...this.meta,
          ...(est.totalExact ? { total: est.total, totalExact: true, about: null } : { about: est.totalEstimate }),
          facets: est.facets ?? this.meta.facets,
          indexed: est.indexed,
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
