/**
 * THE FRAME IS AS TALL AS ITS DOCUMENT and never scrolls itself, so the reader is always one page.
 * JavaScript stays off: the patched WebView reports the document's height as onScroll's
 * `contentSize.height` (`patches/react-native-webview@13.16.1.patch`), never less than its own height,
 * so at one width the height only GROWS. A new width re-measures at the seed's size, with a SPACER
 * holding the old height as the reader's floor; it settles on its latest seed-size reading, never on
 * the floor. What cannot be drawn as one page reads as TEXT: past {@link FRAME_MAX_DP}, a runaway
 * (`vh`), more than {@link FRAME_MAX_READINGS} readings at one width, or no reading at all.
 *
 * A DOCUMENT WIDER THAN ITS FRAME IS DRAWN SCALED TO IT ({@link frameFit}), as a phone's mail app draws a
 * fixed-width newsletter. The document pins its scale at 1 (`minimum-scale=1`), so a reading is in the
 * frame's own units; a reading wider than the frame records the width and grows nothing, and the frame
 * then draws the document zoomed by the frame's width over it. A fit below {@link FRAME_MIN_FIT} would
 * not be legible, and a fit no narrower reading ever answers was undone by the letter's own sheet:
 * both read as text (`wide`).
 */

/** Where a frame starts, and the size it re-measures at when the width changes. */
export const FRAME_SEED_DP = 220;
/** A reading this close to the current height is rounding creep, not growth; also the "near-constant" tolerance. */
export const FRAME_GROW_STEP_DP = 4;
/** The tallest frame. A mail at the frame budget measured 112,960 dp at a 411 dp column (~129k at 360). */
export const FRAME_MAX_DP = 160_000;
/** A `min-height:100vh` mail grows by its padding on every reading; more grows like that is a loop. */
export const FRAME_RUNAWAY_GROWS = 20;
/** Readings that moved the frame at one width; more is a layout feeding on its own frame. Rig corpus: 1. */
export const FRAME_MAX_READINGS = 200;
/** A re-measure settles this long after its latest seed-size reading… */
export const FRAME_SETTLE_MS = 500;
/** …and at most this long after its first one, whatever keeps reporting. */
export const FRAME_SETTLE_BOUND_MS = 2_000;
/** A frame with no reading at its width this long after its document loaded reads as text. */
export const FRAME_UNANSWERED_MS = 5_000;

/** A reading this much wider than its frame is still the frame's width (rounding). */
export const FRAME_FIT_SLACK_DP = 1;
/** The smallest zoom drawn: a 640 px card at a 360 dp phone's pane reads about 0.49; a 120-column line 0.27. */
export const FRAME_MIN_FIT = 0.45;

export type FrameText = "ceiling" | "runaway" | "readings" | "unanswered" | "wide";

export interface FrameHeight {
  readonly key: string;
  /** The window width this state belongs to. */
  readonly width: number;
  readonly dp: number;
  /** The last grow's size, and how many grows in a row were that size within the tolerance. */
  readonly step: number;
  readonly streak: number;
  /** Readings that moved the frame at this width, and whether any reading came at all. */
  readonly readings: number;
  readonly answered: boolean;
  /** Set: the message reads as text, and why. */
  readonly text: FrameText | null;
  /** Re-measuring at a new width: the spacer's target (the old height). Never the frame's height. */
  readonly floor: number | null;
  /** Re-measuring: the latest seed-size reading, and when the first one came. */
  readonly measured: number | null;
  readonly firstMeasuredAt: number | null;
  /**
   * The document read wider than its frame before it was fitted: its width, and the frame's, in dp;
   * `pending` until a reading of the fitted document answers a fit taller than the frame.
   */
  readonly wide: { readonly doc: number; readonly frame: number; readonly pending: boolean } | null;
}

/** A reading's widths: the document's (the scroll range) and the frame's own, in dp. */
export interface FrameWidths {
  readonly doc: number;
  readonly frame: number;
}

const fresh = (key: string, width: number, floor: number | null): FrameHeight => ({
  key, width, dp: FRAME_SEED_DP, step: 0, streak: 0, readings: 0, answered: false, text: null, floor, measured: null, firstMeasuredAt: null, wide: null,
});
const asText = (s: FrameHeight, text: FrameText): FrameHeight => ({ ...s, text });

/** What to draw: the frame's height, and the spacer under it that holds the reader's floor. */
export function frameLayout(s: FrameHeight): { frame: number; spacer: number } {
  return s.floor === null ? { frame: s.dp, spacer: 0 } : { frame: FRAME_SEED_DP, spacer: Math.max(0, s.floor - FRAME_SEED_DP) };
}

/** The state for `key` at `width`: this one, else the remembered one, else the seed; a new width re-measures. */
export function frameHeightFor(state: FrameHeight | null, key: string, width: number, remembered: FrameHeight | null = null): FrameHeight {
  const known = state !== null && state.key === key ? state : remembered !== null && remembered.key === key ? remembered : null;
  if (known === null) return fresh(key, width, null);
  if (known.width === width || (known.text !== null && known.text !== "unanswered" && known.text !== "wide")) return known;
  return fresh(key, width, known.floor ?? known.dp);
}

/** The zoom the document is drawn at: the frame's width over the document's, once it read wider; else 1. */
export function frameFit(s: FrameHeight): number {
  return s.wide === null ? 1 : Math.min(1, s.wide.frame / s.wide.doc);
}

/**
 * A reading wider than its frame, from the document as written: its width is recorded and its height
 * grows nothing. Null for a reading that fits, or for the fitted document's own: its height counts.
 */
function readWide(base: FrameHeight, reportedDp: number, viewDp: number, widths: FrameWidths | undefined, now: number): FrameHeight | null {
  if (widths === undefined || !Number.isFinite(widths.doc) || !(widths.frame > 0)) return null;
  if (widths.doc <= widths.frame + FRAME_FIT_SLACK_DP) return null;
  const was = base.wide;
  // As wide as the document as written: read late, or the fit did not take (a pending fit's bound decides).
  if (was !== null && Math.abs(widths.doc - was.doc) <= FRAME_FIT_SLACK_DP) return base;
  // Narrower than the document as written: the fitted one, still a little wide (drawn, height counts).
  if (was !== null && widths.doc < was.doc) return null;
  if (!(widths.frame / widths.doc >= FRAME_MIN_FIT)) return asText(base, "wide");
  if (base.readings + 1 > FRAME_MAX_READINGS) return asText(base, "readings");
  // Taller than the frame: only a narrower reading shows the fit took. No taller: the fitted one may never report.
  const pending = reportedDp > viewDp + FRAME_GROW_STEP_DP;
  const next = { ...base, wide: { doc: Math.ceil(widths.doc), frame: widths.frame, pending }, answered: true, readings: base.readings + 1 };
  if (base.floor === null || pending) return next;
  // Re-measuring: the fitted document reads no taller than the seed, so a settle is armed now.
  return { ...next, measured: base.measured ?? FRAME_SEED_DP, firstMeasuredAt: base.firstMeasuredAt ?? now };
}

/** A reading of the fitted document (or one that fits) answers a pending fit. */
const fitAnswered = (s: FrameHeight): FrameHeight => (s.wide?.pending === true ? { ...s, wide: { ...s.wide, pending: false } } : s);

/**
 * The state after a reading made at `viewDp` (the frame's own height then), with the reading's widths
 * when the WebView gives them; the SAME object when nothing changes.
 */
export function nextFrameHeight(given: FrameHeight, reportedDp: number, viewDp: number, now: number, widths?: FrameWidths): FrameHeight {
  if (given.text !== null || !Number.isFinite(reportedDp) || reportedDp <= 0) return given;
  if (given.floor !== null) {
    // Re-measuring: only a reading made at the seed's size is this width's document.
    if (Math.abs(viewDp - FRAME_SEED_DP) > 1) return given;
    const wide = readWide(given, reportedDp, viewDp, widths, now);
    if (wide !== null) return wide;
    const base = fitAnswered(given);
    if (reportedDp > FRAME_MAX_DP) return asText(base, "ceiling");
    const dp = Math.max(FRAME_SEED_DP, Math.ceil(reportedDp));
    if (base.measured === dp) return base;
    if (base.readings + 1 > FRAME_MAX_READINGS) return asText(base, "readings");
    return { ...base, measured: dp, firstMeasuredAt: base.firstMeasuredAt ?? now, readings: base.readings + 1, answered: true };
  }
  const wide = readWide(given, reportedDp, viewDp, widths, now);
  if (wide !== null) return wide;
  const base = fitAnswered(given);
  const answered = base.answered ? base : { ...base, answered: true };
  if (reportedDp <= base.dp + FRAME_GROW_STEP_DP) return answered;
  if (reportedDp > FRAME_MAX_DP) return asText(answered, "ceiling");
  if (base.readings + 1 > FRAME_MAX_READINGS) return asText(answered, "readings");
  const dp = Math.ceil(reportedDp);
  const step = dp - base.dp;
  const streak = Math.abs(step - base.step) <= FRAME_GROW_STEP_DP ? base.streak + 1 : 1;
  const next = { ...answered, dp, step, streak, readings: base.readings + 1 };
  return streak > FRAME_RUNAWAY_GROWS ? asText(next, "runaway") : next;
}

/** The frame's height is its document's (a reading came, no re-measure is open), or it reads as text. */
export function frameFinal(s: FrameHeight, asText: boolean): boolean {
  return asText || s.text !== null || (s.answered && s.floor === null && s.wide?.pending !== true);
}

/** What the unanswered bound waits on, keyed so a new fit re-arms it: no reading yet, or a pending fit. */
export function frameAwaits(s: FrameHeight): string | null {
  if (s.text !== null) return null;
  if (!s.answered) return `${s.key}@${s.width}`;
  return s.wide?.pending === true ? `${s.key}@${s.width}:fit${s.wide.doc}` : null;
}

/** When a re-measure settles: null with no seed-size reading at this width (no settle is armed). */
export function settleDelayMs(s: FrameHeight, now: number): number | null {
  if (s.floor === null || s.measured === null || s.firstMeasuredAt === null) return null;
  return Math.max(0, Math.min(FRAME_SETTLE_MS, s.firstMeasuredAt + FRAME_SETTLE_BOUND_MS - now));
}

/** The end of a re-measure: its latest seed-size reading becomes the height; the floor never does. */
export function settleFrameHeight(s: FrameHeight): FrameHeight {
  if (s.floor === null || s.measured === null) return s;
  return { ...s, dp: s.measured, floor: null, measured: null, firstMeasuredAt: null, step: 0, streak: 0 };
}

/** No reading at this width, or no fitted one, {@link FRAME_UNANSWERED_MS} after the load or the fit: text, never a blank or a clip. */
export function unansweredFrameHeight(s: FrameHeight): FrameHeight {
  if (s.text !== null) return s;
  if (!s.answered) return asText(s, "unanswered");
  return s.wide?.pending === true ? asText(s, "wide") : s;
}

/** One timer, cancelled by what it returns: the settle and the unanswered bound are armed only through it. */
export function armFrameTimer(delayMs: number | null, fire: () => void, clock: Pick<typeof globalThis, "setTimeout" | "clearTimeout"> = globalThis): () => void {
  if (delayMs === null) return () => undefined;
  const timer = clock.setTimeout(fire, delayMs);
  return () => clock.clearTimeout(timer);
}

const CAP = 64;
const remembered = new Map<string, FrameHeight>();

/** Kept outside the tree like `pane-memory`'s offsets, the newest {@link CAP}: only a SETTLED reading at its own width. */
export function rememberFrameHeight(state: FrameHeight): void {
  if (state.floor !== null || !state.answered || state.text === "unanswered" || state.wide?.pending === true) return;
  remembered.delete(state.key);
  remembered.set(state.key, state);
  if (remembered.size > CAP) {
    const oldest = remembered.keys().next().value;
    if (oldest !== undefined) remembered.delete(oldest);
  }
}

export function rememberedFrameHeight(key: string): FrameHeight | null {
  return remembered.get(key) ?? null;
}
