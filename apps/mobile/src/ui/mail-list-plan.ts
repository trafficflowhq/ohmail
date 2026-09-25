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
