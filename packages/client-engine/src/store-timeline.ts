/**
 * HISTORY AS THE STORE'S TIMELINE, framework-free — the one walker both the browser and the phone
 * render. Every message the account owns is a slot, newest first; rows come from the engine's
 * bounded page cache, placed by the month anchors and by every page end it has seen (positions,
 * never rows). A slot far from any anchor is reached by UNCACHED walk steps, so a walk never
 * evicts what is on screen. The mirror only paints first, and page one replaces it in place.
 */
import type { OhmailEngine } from "./engine.js";
import {
  HISTORY_PAGE_ROWS, segmentAt, timelineSegments,
  type StoreKeyset, type StoreTimeline, type TimelineSegment,
} from "./store-pages.js";
import type { EngineMessage } from "./types.js";

/** How long History waits for the store before it says so — Search's ceiling. */
export const STORE_ANSWER_TIMEOUT_MS = 15_000;

/** A page that failed is asked again no sooner than this, on the window's next move. */
export const STORE_PAGE_RETRY_MS = 5_000;

export type StoreTimelineState = "unavailable" | "loading" | "ready" | "unanswered";

interface Run {
  start: number;
  before: StoreKeyset | null;
}

const keysetOf = (m: EngineMessage): StoreKeyset => ({ date: m.date ?? null, id: m.id });

export class StoreTimelineWalker {
  private timeline: StoreTimeline | null = null;
  private segs: TimelineSegment[] = [];
  private failed = false;
  private timedOut = false;
  private pageOne = false;
  private runs: Run[] = [];
  private anchors = new Map<number, StoreKeyset | null>([[0, null]]);
  private inFlight = { down: false, up: false };
  private failedAt = new Map<string, number>();
  private epoch = 0;
  private ceiling: ReturnType<typeof setTimeout> | null = null;
  private rev = 0;
  private heldAt = -1;
  private heldRows: { start: number; items: EngineMessage[] }[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly engine: OhmailEngine, private readonly clock: () => number = Date.now) {}

  /** For `useSyncExternalStore`: bumped on every change a render can see. */
  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  readonly revision = (): number => this.rev;

  private changed(): void {
    this.rev += 1;
    for (const fn of this.listeners) fn();
  }

  /** A visit starts from the store's present: the timeline and page one, together. */
  start(): void {
    this.stop();
    const epoch = ++this.epoch;
    this.timeline = null;
    this.segs = [];
    this.failed = false;
    this.timedOut = false;
    this.pageOne = false;
    this.runs = [];
    this.anchors = new Map([[0, null]]);
    this.inFlight = { down: false, up: false };
    this.failedAt.clear();
    this.changed();
    if (!this.engine.storePagesAvailable()) return;
    this.engine.resetStorePages();
    void this.engine.timeline().then((out) => {
      if (epoch !== this.epoch) return;
      if (out.state === "ready") {
        this.timeline = out.timeline;
        this.segs = timelineSegments(out.timeline);
      } else this.failed = true;
      this.changed();
    });
    this.fetchRun(0, null, "down");
    this.ceiling = setTimeout(() => {
      if (epoch !== this.epoch) return;
      this.timedOut = true;
      this.changed();
    }, STORE_ANSWER_TIMEOUT_MS);
  }

  /** The visit ended: nothing that answers after this is read. */
  stop(): void {
    this.epoch += 1;
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

  /** The cached rows of each live run — recomputed only when a page landed. */
  private held(): { start: number; items: EngineMessage[] }[] {
    if (this.heldAt === this.rev) return this.heldRows;
    const out: { start: number; items: EngineMessage[] }[] = [];
    for (const r of this.runs) {
      const items = this.engine.peekStorePage("all", r.before ? { before: r.before } : {});
      if (items !== undefined) out.push({ start: r.start, items });
    }
    this.heldAt = this.rev;
    this.heldRows = out;
    return out;
  }

  private storeRowAt(i: number): EngineMessage | "gone" | null {
    for (const h of this.held()) {
      const k = i - h.start;
      if (k >= 0 && k < h.items.length) return this.engine.storePageRow(h.items[k]!) ?? "gone";
    }
    return null;
  }

  /** The row in slot `i`: a message, `"gone"` where the mirror records it deleted, `null` unfetched. */
  rowAt(i: number, mirrorRows: readonly EngineMessage[]): EngineMessage | "gone" | null {
    if (this.state() !== "ready") return mirrorRows[i] ?? null;
    return this.storeRowAt(i);
  }

  private fetchRun(start: number, before: StoreKeyset | null, dir: "down" | "up", transient = false): void {
    const epoch = this.epoch;
    this.inFlight[dir] = true;
    void this.engine.pageStore("all", {
      ...(before ? { before } : {}), ...(transient ? { transient } : {}), at: start,
    }).then((out) => {
      if (epoch !== this.epoch) return;
      this.inFlight[dir] = false;
      const key = JSON.stringify([start, before]);
      if (out.state !== "ready") {
        this.failedAt.set(key, this.clock());
        if (start === 0) this.failed = true;
        this.changed();
        return;
      }
      this.failedAt.delete(key);
      const last = out.items[out.items.length - 1];
      if (last) this.anchors.set(start + out.items.length, keysetOf(last));
      if (!transient) {
        if (start === 0) this.pageOne = true;
        // Positions whose page the engine has since evicted go with this one's arrival.
        this.runs = [
          ...this.runs.filter((r) => r.start !== start
            && this.engine.peekStorePage("all", r.before ? { before: r.before } : {}) !== undefined),
          { start, before },
        ];
      }
      this.changed();
    });
  }

  /** The nearest known position at or above slot `p` a strict page can start from. */
  private anchorFor(p: number): { start: number; before: StoreKeyset | null } | null {
    for (const h of this.held()) {
      const k = p - 1 - h.start;
      if (k >= 0 && k < h.items.length) return { start: p, before: keysetOf(h.items[k]!) };
    }
    if (segmentAt(this.segs, p) === null) return null;
    let best: { start: number; before: StoreKeyset | null } = { start: 0, before: null };
    for (const s of this.segs) {
      if (s.start > p) break;
      if (s.start >= best.start) best = { start: s.start, before: s.before };
    }
    for (const [start, before] of this.anchors) {
      if (start <= p && start > best.start) best = { start, before };
    }
    return best;
  }

  /** Ask for the pages covering `[start, end)` — at most one request per direction in flight. */
  want(start: number, end: number): void {
    if (this.state() !== "ready") return;
    const hi = Math.min(end, this.length(0));
    let firstHeld = -1;
    for (let i = Math.max(0, start); i < hi; i++) {
      if (this.storeRowAt(i) !== null) {
        firstHeld = i;
        break;
      }
    }
    const missing = (from: number, to: number, step: 1 | -1): number => {
      for (let i = from; step > 0 ? i < to : i >= to; i += step) if (this.storeRowAt(i) === null) return i;
      return -1;
    };
    const ask = (p: number, dir: "down" | "up") => {
      if (p < 0 || this.inFlight[dir]) return;
      const a = this.anchorFor(p);
      if (a === null) return;
      const at = this.failedAt.get(JSON.stringify([a.start, a.before]));
      if (at !== undefined && this.clock() - at < STORE_PAGE_RETRY_MS) return;
      // Farther than a page from the anchor: an uncached step that only learns the next anchor.
      this.fetchRun(a.start, a.before, dir, p - a.start >= HISTORY_PAGE_ROWS);
    };
    ask(missing(firstHeld < 0 ? Math.max(0, start) : firstHeld, hi, 1), "down");
    if (firstHeld > 0) ask(missing(firstHeld - 1, Math.max(0, start), -1), "up");
  }

  /** A rail press: the page at that month's own anchor, asked at once. */
  jump(start: number): void {
    const seg = this.segs.find((s) => s.start === start);
    if (seg && this.state() === "ready" && this.storeRowAt(start) === null) this.fetchRun(seg.start, seg.before, "down");
  }
}
