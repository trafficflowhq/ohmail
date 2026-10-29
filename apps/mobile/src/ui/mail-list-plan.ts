/**
 * The virtualized list's arithmetic, renderer-free: what `MailList.tsx` hands `SectionList`, in a
 * module a node test can load (`safe-area.ts`'s reason — a module importing react-native is one
 * this suite cannot). The window is the whole fix: a phone list used to mount every row, and a
 * fold relayout of a large mailbox re-mounted them all at once and ran the Android heap out.
 * Every client passes a WINDOW; `test/mail-list-window.test.ts` pins this one.
 */

/**
 * The window every mail list runs under. No `getItemLayout` — rows are 3–4 lines by content —
 * unless the caller draws its rows at heights it keeps ({@link sectionItemLayout}).
 */
export const LIST_WINDOW = {
  initialNumToRender: 16,
  maxToRenderPerBatch: 12,
  windowSize: 7,
  updateCellsBatchingPeriod: 40,
} as const;

export type ListWindow = { readonly [K in keyof typeof LIST_WINDOW]: number };

/** The first named group's top padding — the screens' own `paddingTop: 18` rule, once. */
export const FIRST_GROUP_TOP = 18;

/** The panel's foot under the last row or the footer — the old `<Panel style={{ paddingBottom: 4 }}>`. */
export const PANEL_FOOT = 4;

/** Within this many points of the top, a content change scrolls back to 0 rather than holding a row. */
export const TOP_HOLD = 8;

export interface ListGroup<T> {
  key: string;
  /** Rendered as a `Section` label above the rows; absent, no header is drawn. */
  title?: string;
  rows: readonly T[];
  /** A caption under the title — a heading that needs a sentence to be honest (Search's SIMILAR
   *  tier says what "similar" means there). Drawn only where there is a title. */
  note?: string;
  /** An untitled group's room above its first row (the Screener's shelves). */
  padTop?: number;
}

const SECTION: unique symbol = Symbol("mail-list-section");

export interface PlannedSection<T> {
  key: string;
  title: string | null;
  note: string | null;
  data: readonly T[];
  padTop: number;
  /** The first titled section wears {@link FIRST_GROUP_TOP}; the others the label's own 16. */
  first: boolean;
  [SECTION]: true;
}

/** Empty groups draw nothing — the screens' `length > 0 ?` rule, in the primitive. */
export function planSections<T>(groups: readonly ListGroup<T>[]): PlannedSection<T>[] {
  const out: PlannedSection<T>[] = [];
  let titled = false;
  for (const g of groups) {
    if (g.rows.length === 0) continue;
    const title = g.title ?? null;
    const first = title !== null && !titled;
    if (title !== null) titled = true;
    out.push({
      key: g.key, title, note: title === null ? null : g.note ?? null,
      data: g.rows, padTop: g.padTop ?? 0, first, [SECTION]: true,
    });
  }
  return out;
}

/** A header or footer cell's `item` is the section itself (VirtualizedSectionList); a row's is the row. */
export function isSection(item: unknown): boolean {
  return typeof item === "object" && item !== null && (item as { [SECTION]?: unknown })[SECTION] === true;
}

/**
 * How many rows the window can hold mounted at once: `windowSize` viewports of rows at `rowPt`,
 * plus one render batch of overshoot. Stated so the suite can pin the design's bound against a
 * row-height floor, and a widened window shows up as a number rather than a feeling.
 */
export function mountedRowsBound(window: ListWindow, viewportPt: number, rowPt: number): number {
  return Math.ceil((window.windowSize * viewportPt) / rowPt) + window.maxToRenderPerBatch;
}

/** A list's rows at the heights its caller draws them at, counted from the first row. */
export interface RowLayout {
  offsetOf(i: number): number;
  lengthOf(i: number): number;
}

export interface CellLayout {
  length: number;
  offset: number;
  index: number;
}

/**
 * EVERY CELL WHERE IT WILL BE DRAWN, for one untitled group whose rows the caller draws at heights
 * it keeps (History's slot ledger). Without it `VirtualizedList` limits its tail spacer to the
 * highest cell it has measured, so a jump below the rows laid out so far stops at their end.
 * SectionList's cells are the section's header, its rows, then its footer; `origin` is where the
 * header cell starts in the scroll content — the list head's height. Any other shape gets none.
 */
export function sectionItemLayout<T>(
  sections: readonly PlannedSection<T>[],
  rows: RowLayout,
  origin: number,
): ((data: unknown, index: number) => CellLayout) | undefined {
  if (sections.length !== 1 || sections[0]!.title !== null) return undefined;
  const n = sections[0]!.data.length;
  const head = sections[0]!.padTop;
  return (_data, index) => {
    if (index <= 0) return { length: head, offset: origin, index };
    const i = index - 1;
    if (i >= n) return { length: 0, offset: origin + head + rows.offsetOf(n), index };
    return { length: rows.lengthOf(i), offset: origin + head + rows.offsetOf(i), index };
  };
}

/** How long after a commit or a return a scroll the list makes on its own is taken as its slip. */
export const PLACE_HOLD_MS = 1000;
/** Scrolls back per commit at most: a view that will not stay there is not chased. */
const PLACE_TRIES = 3;

interface PlaceView {
  y: number;
  height: number;
}

/**
 * THE READER'S PLACE BY ITS ROW: the first row on screen and how far below the view's top it
 * starts, taken from the person's own scrolling. When that row moves (letters arrive above it), or
 * the list slips on its own while the screen is behind another or just after a commit or a return,
 * the list scrolls back to it. Near the top there is no place to keep: arrivals there show
 * (`TOP_HOLD`).
 */
export class PlaceKeeper {
  private frames = new Map<string, { top: number; bottom: number }>();
  private view: PlaceView | null = null;
  private place: { key: string; rel: number } | null = null;
  private by: "app" | "person" = "app";
  /** A begin drag with no end drag yet: a finger is on the list. */
  private touching = false;
  private away = false;
  private holdUntil = 0;
  private tries = PLACE_TRIES;

  constructor(
    private readonly scrollTo: (y: number) => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  frame(key: string, top: number, height: number): void {
    const was = this.frames.get(key);
    this.frames.set(key, { top, bottom: top + height });
    if (key === this.place?.key && was?.top !== top) {
      this.committed();
      this.restore();
    }
  }

  gone(key: string): void {
    this.frames.delete(key);
  }

  /** A commit of the list: the native hold may move the offset in the next moment. */
  committed(): void {
    this.holdUntil = this.now() + PLACE_HOLD_MS;
    this.tries = PLACE_TRIES;
  }

  /** The screen is behind another: what the list does meanwhile is never the reader's place. */
  leave(): void {
    this.away = true;
  }

  /** The screen is in front again: its place comes back. */
  back(): void {
    this.away = false;
    this.committed();
    this.restore();
  }

  drag(): void {
    this.by = "person";
    this.touching = true;
    this.holdUntil = 0;
  }

  /** The finger lifts; a glide may follow, and its landing ends the person's move. */
  lift(v: PlaceView): void {
    this.take(v);
    this.touching = false;
    this.by = "app";
  }

  glide(): void {
    this.by = "person";
  }

  /** A glide's end under a finger that caught it leaves the move the person's until the lift. */
  land(v: PlaceView): void {
    this.take(v);
    if (!this.touching) this.by = "app";
  }

  scroll(v: PlaceView): void {
    if (this.by === "person") this.take(v);
    else if (this.away || this.now() < this.holdUntil) {
      this.view = v;
      this.restore();
    } else this.take(v);
  }

  private take(v: PlaceView): void {
    this.view = v;
    if (this.away) return;
    if (v.y <= TOP_HOLD) {
      this.place = null;
      return;
    }
    let first: { key: string; top: number } | null = null;
    for (const [key, f] of this.frames) {
      if (f.bottom > v.y && f.top < v.y + v.height && (first === null || f.top < first.top)) first = { key, top: f.top };
    }
    this.place = first === null ? null : { key: first.key, rel: first.top - v.y };
  }

  private restore(): void {
    if (this.by === "person" || this.place === null || this.view === null || this.tries <= 0) return;
    const f = this.frames.get(this.place.key);
    if (f === undefined) return;
    const y = f.top - this.place.rel;
    if (Math.abs(y - this.view.y) <= 1) return;
    this.tries -= 1;
    this.view = { ...this.view, y };
    this.scrollTo(y);
  }
}
