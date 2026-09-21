/**
 * The virtualized list's arithmetic, renderer-free: what `MailList.tsx` hands `SectionList`, in a
 * module a node test can load (`safe-area.ts`'s reason — a module importing react-native is one
 * this suite cannot). The window is the whole fix: a phone list used to mount every row, and a
 * fold relayout of a large mailbox re-mounted them all at once and ran the Android heap out.
 * Every client passes a WINDOW; `test/mail-list-window.test.ts` pins this one.
 */

/** The window every mail list runs under. No `getItemLayout`: rows are 3–4 lines by content. */
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
  /** An untitled group's room above its first row (the Screener's shelves). */
  padTop?: number;
}

const SECTION: unique symbol = Symbol("mail-list-section");

export interface PlannedSection<T> {
  key: string;
  title: string | null;
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
    out.push({ key: g.key, title, data: g.rows, padTop: g.padTop ?? 0, first, [SECTION]: true });
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
