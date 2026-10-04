/**
 * THE FRAME DRAWS ONLY A DOCUMENT WHOSE OWN TREE WAS COUNTED. A sanitized document can re-parse into a
 * far larger tree (an inner `<p>` re-opens every unclosed `<b>`), so the frame mounts a document only
 * after the spec's tree builder has read that very string under {@link FRAME_BUDGET}, a step per
 * macrotask. The string is the one the WebView is handed in the consent state it is drawn in: a picture
 * that arrives, or a press of Show images, makes a new string, and that one is counted before it is
 * drawn. Readings are cached on the counted string itself, never on a message id. A document longer than
 * this phone's ceiling (`frame-ceiling.ts`, at most `PHONE_FRAME_MAX_CHARS`) is refused without a
 * count, and one the pictures would make that long is refused before it is built (`frame-length.ts`).
 */
import { treeStepper, type TreeReading } from "@ohmail/client-engine/html-tree-budget";
import { FRAME_BUDGET, FRAME_STEP_CHARS, FRAME_STEP_WORK } from "./frame-budget";
import { engineLogSink, type EngineLogSink } from "../engine/engine-log";

/**
 * A count's reading, or why the frame was refused without one: past the html cap, a document past this
 * phone's ceiling (built, or read as that long before its pictures were written), or a
 * step that threw.
 */
export type FrameReading = TreeReading | { fits: false; past: "oversize" | "length" | "error" };

export interface FramePlan {
  /** The counted document: what the WebView would be handed, the cache's key, and what a reading must match. */
  readonly key: string;
  /** The reading when it needs no step: the cache's, or the sanitizer's own refusal. */
  readonly known: FrameReading | null;
  /** Whether `known` came from the cache. */
  readonly cached: boolean;
  /** The counted document's length, or the length a refused one would have had. */
  readonly chars: number;
  /** This phone's length ceiling the plan was made under. */
  readonly ceiling: number;
}

/** The last readings, keyed on the counted document itself, so a reopen needs no step. */
const CACHE = new Map<string, FrameReading>();
export const FRAME_CACHE_SIZE = 8;
/** A document longer than this is counted each time rather than held: with pictures it can be megabytes. */
export const FRAME_CACHE_MAX_CHARS = 1 << 20;

function recall(key: string): FrameReading | undefined {
  const r = CACHE.get(key);
  if (r !== undefined) {
    CACHE.delete(key);
    CACHE.set(key, r);
  }
  return r;
}

function remember(key: string, reading: FrameReading): void {
  if (key.length > FRAME_CACHE_MAX_CHARS) return;
  CACHE.delete(key);
  CACHE.set(key, reading);
  while (CACHE.size > FRAME_CACHE_SIZE) {
    const oldest = CACHE.keys().next();
    if (oldest.done === true) break;
    CACHE.delete(oldest.value);
  }
}

/**
 * The plan for `doc`, the exact string the frame would mount; `oversize` is the sanitizer's own refusal,
 * `ceiling` this phone's length ceiling (`phoneFrameMaxChars`).
 */
export function planFrameCount(doc: string, oversize: boolean, ceiling: number): FramePlan {
  if (oversize) return { key: doc, known: { fits: false, past: "oversize" }, cached: false, chars: doc.length, ceiling };
  if (doc.length > ceiling) return { key: doc, known: { fits: false, past: "length" }, cached: false, chars: doc.length, ceiling };
  const hit = recall(doc);
  return { key: doc, known: hit ?? null, cached: hit !== undefined, chars: doc.length, ceiling };
}

/** The plan for a document that was not built: its pictures would have made it `chars` long, past `ceiling`. */
export function planFrameLength(chars: number, ceiling: number): FramePlan {
  return { key: "", known: { fits: false, past: "length" }, cached: false, chars, ceiling };
}

/** What a count reports: its reading, the counted document's length, and what it cost on this thread. */
export interface FrameCount {
  reading: FrameReading;
  chars: number;
  ceiling: number;
  steps: number;
  maxStepMs: number;
  totalMs: number;
  wallMs: number;
  cached: boolean;
}

/** Runs `run` on a later macrotask and returns its cancel. */
export type FrameSchedule = (run: () => void) => () => void;

/** One macrotask between steps, so touches and the screen's push get the thread in between. */
export const nextMacrotask: FrameSchedule = (run) => {
  const timer = setTimeout(run, 0);
  return () => clearTimeout(timer);
};

const now = (): number => (typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : Date.now());
const tenths = (ms: number): number => Math.round(ms * 10) / 10;

/**
 * Counts `plan` a step per macrotask, each step at most {@link FRAME_STEP_CHARS} characters and about
 * {@link FRAME_STEP_WORK} of the parse's work, and hands the reading to `onDone` once; the returned
 * function cancels, and a cancelled count never calls `onDone`. A known reading is answered at once. A
 * step that throws is a refusal: the frame is never mounted over a document nobody finished reading.
 */
export function startFrameCount(plan: FramePlan, onDone: (count: FrameCount) => void, schedule: FrameSchedule = nextMacrotask): () => void {
  if (plan.known !== null) {
    onDone({ reading: plan.known, chars: plan.chars, ceiling: plan.ceiling, steps: 0, maxStepMs: 0, totalMs: 0, wallMs: 0, cached: plan.cached });
    return () => {};
  }
  const step = treeStepper(plan.key, FRAME_BUDGET, FRAME_STEP_CHARS, FRAME_STEP_WORK);
  const started = now();
  let steps = 0;
  let maxStepMs = 0;
  let totalMs = 0;
  let cancelled = false;
  let cancelNext = (): void => {};
  const run = (): void => {
    if (cancelled) return;
    const t0 = now();
    let reading: FrameReading | null;
    try {
      reading = step();
    } catch {
      reading = { fits: false, past: "error" };
    }
    const ms = now() - t0;
    steps += 1;
    totalMs += ms;
    maxStepMs = Math.max(maxStepMs, ms);
    if (reading === null) {
      cancelNext = schedule(run);
      return;
    }
    remember(plan.key, reading);
    onDone({
      reading, chars: plan.chars, ceiling: plan.ceiling, steps, maxStepMs: tenths(maxStepMs), totalMs: tenths(totalMs),
      wallMs: tenths(now() - started), cached: false,
    });
  };
  cancelNext = schedule(run);
  return () => {
    cancelled = true;
    cancelNext();
  };
}

/** The reading the frame may act on: the plan's own, or a count's that was made for this very document. */
export function frameReadingOf(plan: FramePlan, counted: { key: string; reading: FrameReading } | null): FrameReading | null {
  if (plan.known !== null) return plan.known;
  return counted !== null && counted.key === plan.key ? counted.reading : null;
}

/** What the frame shows: the text part, a same-height space, or a counted document. */
export type FrameShows =
  | { show: "text" }
  | { show: "space" }
  | { show: "frame"; doc: string; withheld: boolean };

/** The bare document's reading when a pictured state was refused with nothing kept; "none" when no fallback applies. */
export type BareFallback = FrameReading | null | "none";

/**
 * The frame's one decision. `current` is this state's document (null when it was not built), `kept`
 * the last document of the same message and html whose own count fitted. A refused state with a kept
 * document keeps it drawn and says the pictures were `withheld`. A PICTURED state refused with nothing
 * kept (a remount after Show as text, its pictures already minted) never falls back to text for the
 * pictures' sake: `bare` is the reading of the same html with no picture, and the frame waits for it
 * (it becomes the kept document once it fits). Only an html part that does not fit bare is the text part.
 */
export function frameShows(
  reading: FrameReading | null,
  current: string | null,
  kept: string | null,
  oversize: boolean,
  bare: BareFallback = "none",
): FrameShows {
  if (oversize) return { show: "text" };
  if (reading !== null && reading.fits && current !== null) return { show: "frame", doc: current, withheld: false };
  if (kept !== null) return { show: "frame", doc: kept, withheld: reading !== null };
  if (reading === null) return { show: "space" };
  if (bare === "none") return { show: "text" };
  return bare !== null && !bare.fits ? { show: "text" } : { show: "space" };
}

export const FRAME_TREE_EVENT = "mail_frame_tree";

/** One line per count, numbers and the closed `past` vocabulary only: nothing of the mail. */
export function frameTreeLine(count: FrameCount, at: () => Date = () => new Date()): string {
  const r = count.reading;
  return JSON.stringify({
    ts: at().toISOString(),
    level: "info",
    service: "phone",
    event: FRAME_TREE_EVENT,
    fits: r.fits,
    ...(r.fits ? { elements: r.elements, textChars: r.textChars, work: r.work } : { past: r.past }),
    chars: count.chars,
    ceiling: count.ceiling,
    steps: count.steps,
    maxStepMs: count.maxStepMs,
    totalMs: count.totalMs,
    wallMs: count.wallMs,
    cached: count.cached,
  });
}

export function noteFrameTree(count: FrameCount, sink: EngineLogSink = engineLogSink()): void {
  sink(frameTreeLine(count));
}
