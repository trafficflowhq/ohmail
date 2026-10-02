/**
 * THE FRAME DRAWS ONLY A TREE THAT WAS COUNTED. A sanitized document can re-parse into a far larger
 * tree (an inner `<p>` re-opens every unclosed `<b>`), so the frame is mounted only after the spec's
 * tree builder has read the document under {@link FRAME_BUDGET}, a step per macrotask. Past it the
 * reader shows the text part with the oversize sentence. One count per html part, cached on the
 * counted string itself, never on a message id.
 */
import { treeStepper, type TreeReading } from "./html-tree-budget";
import { FRAME_BUDGET, FRAME_STEP_CHARS } from "./frame-budget";
import { buildPhoneMailDocument, type MailDocumentTheme } from "./mail-document";
import { sanitizeMailHtmlPhone } from "./sanitize";
import { engineLogSink, type EngineLogSink } from "../engine/engine-log";

/** A count's reading, or why the frame was refused before one: past the html cap, a sender byte equal to a mark, a step that threw. */
export type FrameReading = TreeReading | { fits: false; past: "oversize" | "marks" | "error" };

/**
 * WHY THE MARKED DOCUMENT BOUNDS EVERY PICTURE STATE. The states differ only in `<img src>`, in
 * `url()` values inside `style` and in `<style>` text; neither text nor attribute values are counted,
 * so only the element count can move. Tree construction reads such a value in one step, the Noah's
 * Ark clause on the active formatting elements, which drops an entry only when three EQUAL ones
 * precede it. Before consent every blocked url is the same `none`; after it, references to one key
 * share bytes. One mark per key is the finest equality a real state has, so the marked parse drops no
 * entry a real parse keeps. A sender byte equal to a mark would break that, so it is refused.
 */
const NONCE = mintNonce();

/** 20 characters over [A-Za-z0-9] (about 119 bits), from the platform's random source where it has one. */
function mintNonce(): string {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const draw = new Uint16Array(20);
  const crypto = (globalThis as { crypto?: { getRandomValues?: (a: Uint16Array) => unknown } }).crypto;
  if (typeof crypto?.getRandomValues === "function") crypto.getRandomValues(draw);
  else for (let i = 0; i < draw.length; i++) draw[i] = Math.floor(Math.random() * 65_536);
  let out = "";
  for (const v of draw) out += abc[v % abc.length];
  return out;
}

/** The marks' shared prefix, for the disjointness case: a sender cannot read it, a test can. */
export function frameMarkNonce(): string {
  return NONCE;
}

export interface FramePlan {
  /** The counted document: what the count reads, the cache's key, and what a stored reading must match. */
  readonly key: string;
  /** The reading when it needs no step: the cache's, or a refusal decided before counting. */
  readonly known: FrameReading | null;
  /** Whether `known` came from the cache. */
  readonly cached: boolean;
}

/** The last readings, keyed on the counted document itself, so a reopen needs no step. */
const CACHE = new Map<string, FrameReading>();
export const FRAME_CACHE_SIZE = 8;

function recall(key: string): FrameReading | undefined {
  const r = CACHE.get(key);
  if (r !== undefined) {
    CACHE.delete(key);
    CACHE.set(key, r);
  }
  return r;
}

function remember(key: string, reading: FrameReading): void {
  CACHE.delete(key);
  CACHE.set(key, reading);
  while (CACHE.size > FRAME_CACHE_SIZE) {
    const oldest = CACHE.keys().next();
    if (oldest.done === true) break;
    CACHE.delete(oldest.value);
  }
}

/**
 * The document the count reads: `html` sanitized with every picture key it names given its own mark,
 * built into the frame's shell. Pure but for the cache read; the frame memoizes it on `html` and the
 * theme. The theme only reaches `<style>` text, which steers no tree.
 */
export function planFrameCount(html: string, theme: MailDocumentTheme): FramePlan {
  const bare = sanitizeMailHtmlPhone(html, {});
  if (bare.oversize === true) return { key: "", known: { fits: false, past: "oversize" }, cached: false };
  if (bare.html.includes(NONCE)) return { key: "", known: { fits: false, past: "marks" }, cached: false };
  const urls = [...new Set(bare.blocked.map((b) => b.url))];
  let body = bare.html;
  if (bare.cids.length > 0 || urls.length > 0) {
    let n = 0;
    const mark = (): string => `data:image/gif;base64,${NONCE}${(n++).toString(36)}`;
    body = sanitizeMailHtmlPhone(html, {
      inlineImages: new Map(bare.cids.map((id) => [id, mark()])),
      resolvedRemote: new Map(urls.map((url) => [url, mark()])),
      loadPixels: true,
    }).html;
  }
  const key = buildPhoneMailDocument(body, theme);
  const hit = recall(key);
  return { key, known: hit ?? null, cached: hit !== undefined };
}

/** What a count reports: its reading, and what it cost on this thread. */
export interface FrameCount {
  reading: FrameReading;
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
 * Counts `plan` a step per macrotask and hands the reading to `onDone` once; the returned function
 * cancels, and a cancelled count never calls `onDone`. A known reading is answered at once. A step
 * that throws is a refusal: the frame is never mounted over a document nobody finished reading.
 */
export function startFrameCount(plan: FramePlan, onDone: (count: FrameCount) => void, schedule: FrameSchedule = nextMacrotask): () => void {
  if (plan.known !== null) {
    onDone({ reading: plan.known, steps: 0, maxStepMs: 0, totalMs: 0, wallMs: 0, cached: plan.cached });
    return () => {};
  }
  const step = treeStepper(plan.key, FRAME_BUDGET, FRAME_STEP_CHARS);
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
    onDone({ reading, steps, maxStepMs: tenths(maxStepMs), totalMs: tenths(totalMs), wallMs: tenths(now() - started), cached: false });
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
