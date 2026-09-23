/**
 * THE STORE'S TIMELINE — History as paged reads of the store, never of the mirror. The mirror
 * keeps its window for the live views; every message the account owns is reached here a keyset
 * page at a time (`GET /messages?view=all`) and placed by the month rail (`GET /messages/timeline`).
 * Pages are held in ONE bounded cache ({@link HISTORY_PAGE_CACHE_ROWS}) and never written into the
 * mirror: a page row has no seq, so no delta could update or remove it there.
 */
import type { EngineMessage } from "./types.js";

/** Rows one store page asks for — the server's own ceiling on `GET /messages`. */
export const HISTORY_PAGE_ROWS = 50;

/** Rows the page cache may hold, across every page — three pages; the farthest goes first. */
export const HISTORY_PAGE_CACHE_ROWS = 150;

/** A position in `date desc nulls last, id desc` — the store's reading order. */
export interface StoreKeyset {
  date: string | null;
  id: string;
}

/** One month of the timeline: its count and its newest row, which is where a jump lands. */
export interface StoreTimelineMonth {
  /** `YYYY-MM`. */
  month: string;
  count: number;
  first: StoreKeyset;
}

/** `GET /messages/timeline` — months newest first, undated rows counted apart at the end. */
export interface StoreTimeline {
  total: number;
  months: StoreTimelineMonth[];
  undated: number;
}

export type StoreTimelineFn = () => Promise<StoreTimeline | null>;

export type StoreTimelineOutcome =
  | { state: "unavailable" }
  | { state: "ready"; timeline: StoreTimeline }
  | { state: "failed"; errorClass: string };

/** One page: strictly below `before` (a keyset), or after the server's own `cursor`. */
export interface StorePageOpts {
  before?: StoreKeyset;
  cursor?: string;
  limit?: number;
  /** A step of a walk toward a far slot: answered, never cached — it would evict what is on screen. */
  transient?: boolean;
  /** The slot the page starts at in the caller's list — what "farthest" is measured in. */
  at?: number;
}

export type StorePageOutcome =
  | { state: "unavailable" }
  | { state: "ready"; items: EngineMessage[]; nextCursor: string | null }
  | { state: "failed"; errorClass: string };

/** One page as the cache holds it. */
export interface StorePage {
  items: EngineMessage[];
  nextCursor: string | null;
}

/** Above every real id: v4 and v7 uuids never carry an `f` version nibble. */
export const UUID_MAX = "ffffffff-ffff-ffff-ffff-ffffffffffff";

/**
 * The id one above `id` in uuid order, so the strict keyset `(date, id) < (d, next)` starts AT the
 * row `(d, id)` — how a jump lands on a month's newest message instead of one below it. Postgres
 * orders uuids by their bytes, which is the order of the lower-case hex.
 */
export function uuidSuccessor(id: string): string {
  const hex = id.toLowerCase().replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(hex)) return id;
  const digits = hex.split("");
  let i = digits.length - 1;
  while (i >= 0 && digits[i] === "f") {
    digits[i] = "0";
    i -= 1;
  }
  if (i < 0) return UUID_MAX;
  digits[i] = (parseInt(digits[i]!, 16) + 1).toString(16);
  const s = digits.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** Where one month (or the undated tail) starts in the flat newest-first index space. */
export interface TimelineSegment {
  /** `YYYY-MM`, or `null` for the undated tail. */
  month: string | null;
  start: number;
  count: number;
  /** The keyset whose strict page begins with this segment's first row. */
  before: StoreKeyset;
}

/** The timeline as index ranges. Empty months are dropped; the undated tail comes last. */
export function timelineSegments(t: StoreTimeline): TimelineSegment[] {
  const out: TimelineSegment[] = [];
  let start = 0;
  for (const m of t.months) {
    if (m.count <= 0) continue;
    out.push({ month: m.month, start, count: m.count, before: { date: m.first.date, id: uuidSuccessor(m.first.id) } });
    start += m.count;
  }
  if (t.undated > 0) out.push({ month: null, start, count: t.undated, before: { date: null, id: UUID_MAX } });
  return out;
}

/** The segment holding index `i` — binary search over the starts. `null` past the end. */
export function segmentAt(segments: readonly TimelineSegment[], i: number): TimelineSegment | null {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid]!;
    if (i < s.start) hi = mid - 1;
    else if (i >= s.start + s.count) lo = mid + 1;
    else return s;
  }
  return null;
}

/** A page's place for "farthest": its slot in the list, else its top row's date (undated last). */
function positionOf(items: readonly EngineMessage[], at?: number): number {
  if (at !== undefined) return at;
  const t = Date.parse(items[0]?.date ?? "");
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

function distance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Number.isNaN(d) ? 0 : d;
}

/**
 * THE ONE BOUND ON PAGE ROWS IN MEMORY. A put evicts the page farthest from the page just put —
 * in the caller's slots where it named them, else in time; the least recently read on a tie —
 * until the rows fit the ceiling; the page just put is never the one evicted.
 */
export class StorePageCache {
  private readonly pages = new Map<string, { page: StorePage; at: number; used: number }>();
  private tick = 0;

  constructor(private readonly ceiling: number) {}

  get(key: string): StorePage | undefined {
    const held = this.pages.get(key);
    if (held === undefined) return undefined;
    held.used = ++this.tick;
    return held.page;
  }

  put(key: string, page: StorePage, slot?: number): void {
    const at = positionOf(page.items, slot);
    this.pages.set(key, { page, at, used: ++this.tick });
    while (this.rows() > this.ceiling && this.pages.size > 1) {
      let victim: string | null = null;
      let far = -1;
      let used = Number.POSITIVE_INFINITY;
      for (const [k, p] of this.pages) {
        if (k === key) continue;
        const d = distance(p.at, at);
        if (d > far || (d === far && p.used < used)) {
          victim = k;
          far = d;
          used = p.used;
        }
      }
      if (victim === null) break;
      this.pages.delete(victim);
    }
  }

  /** The held row with this id, in any cached page. */
  find(id: string): EngineMessage | undefined {
    for (const p of this.pages.values()) {
      const hit = p.page.items.find((m) => m.id === id);
      if (hit) return hit;
    }
    return undefined;
  }

  rows(): number {
    let n = 0;
    for (const p of this.pages.values()) n += p.page.items.length;
    return n;
  }

  clear(): void {
    this.pages.clear();
  }
}

/** The cache key for one page request — JSON, never a joined string. */
export function storePageKey(view: "all", opts: StorePageOpts, limit: number): string {
  return JSON.stringify([
    view, opts.before ? [opts.before.date, opts.before.id] : null, opts.cursor ?? null, limit,
  ]);
}

/** A timeline as the wire sent it, read defensively; `null` when it is not one. */
export function readTimelineWire(wire: unknown): StoreTimeline | null {
  if (typeof wire !== "object" || wire === null) return null;
  const w = wire as { total?: unknown; months?: unknown; undated?: unknown };
  if (typeof w.total !== "number" || !Array.isArray(w.months)) return null;
  const months: StoreTimelineMonth[] = [];
  for (const m of w.months as unknown[]) {
    const x = m as { month?: unknown; count?: unknown; first?: { date?: unknown; id?: unknown } } | null;
    if (!x || typeof x.month !== "string" || !/^\d{4}-\d{2}$/.test(x.month)) continue;
    if (typeof x.count !== "number" || !x.first || typeof x.first.id !== "string") continue;
    const date = typeof x.first.date === "string" ? x.first.date : null;
    months.push({ month: x.month, count: x.count, first: { date, id: x.first.id } });
  }
  return { total: w.total, months, undated: typeof w.undated === "number" ? w.undated : 0 };
}
