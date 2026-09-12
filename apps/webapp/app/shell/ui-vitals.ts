"use client";

/**
 * ═══ WHAT THE WINDOW FEELS LIKE, MEASURED BY THE WINDOW ═══════════════════════════════════
 *
 * `engine_vitals` says what the sidecar costs and `renderer_vitals` says what the webview costs.
 * Neither says whether opening a message took 90 ms or 900, and that is the number a person
 * actually experiences: the 0.16.2 incident was reported as "it got slow and then it crashed",
 * and the only evidence for the first half was the reporter's sentence.
 *
 * So the shell times itself. Three startup marks, three interactions, two frame counters, and the
 * client engine's own derivation cost — a ring of the last hundred readings per interaction, p50
 * and p95 out of it every five minutes, on the same clock as the other two lines so one grep over
 * `engine.log` puts all three side by side.
 *
 * ── PII-FREE BY CONSTRUCTION, NOT BY CARE ─────────────────────────────────────────────────
 *
 * Every value here is a count or a duration. No id, no address, no subject, no folder name, no
 * query — not "we are careful not to log them" but "there is nowhere to put one": the report is a
 * record of numbers, and the desktop's shell recomposes even that from a fixed list of names it
 * holds itself (`vitals.rs`). The web app hands the same object to `console.debug` and sends it
 * nowhere at all.
 *
 * ── AND WHY THERE IS NO FLAG ──────────────────────────────────────────────────────────────
 *
 * An instrument that has to be turned on is an instrument that is off during the incident. This
 * costs one `requestAnimationFrame` handler that allocates nothing per frame, one long-task
 * observer where the browser has one, and one five-minute timer.
 */
import { useEffect } from "react";
import { takeClientEngineVitals } from "@ohmail/client-engine";

/** The three interactions worth a percentile — the ones a person waits through. */
export type UiInteraction = "open" | "switch" | "search";

/** The three startup marks, in the order a launch reaches them. */
export type UiStartupMark = "shellPainted" | "listUsable" | "engineReady";

/**
 * The last hundred readings per interaction.
 *
 * A ring and not a growing array: a window left open for a day would otherwise hold every reading
 * it ever took, which is a leak inside the instrument that exists to find leaks. A hundred is
 * enough for a p95 to mean something and small enough that the sort it costs is invisible.
 */
export const RING = 100;

/** Beside `engine_vitals` and `renderer_vitals`, which are also five minutes. */
export const REPORT_EVERY_MS = 5 * 60_000;

/** A frame that took longer than this is one somebody saw drop. 50 ms is three frames at 60 Hz. */
export const LONG_FRAME_MS = 50;

/** A task longer than this blocks every input for its whole duration. */
export const LONG_TASK_MS = 200;

/** The report, as the shell composes it: numbers and nulls, nothing else. */
export type UiVitalsReport = Record<string, number | null>;

/** Where a finished report goes. */
export type UiVitalsSink = (report: UiVitalsReport) => void;

interface Ring {
  values: number[];
  next: number;
  /** How many landed since the last report — `values` rolls, this does not. */
  sinceReport: number;
}

function newRing(): Ring {
  return { values: [], next: 0, sinceReport: 0 };
}

const rings: Record<UiInteraction, Ring> = {
  open: newRing(),
  switch: newRing(),
  search: newRing(),
};

const startup: Record<UiStartupMark, number | null> = {
  shellPainted: null,
  listUsable: null,
  engineReady: null,
};

let longFrames = 0;
let longTasks = 0;
let sink: UiVitalsSink | null = null;

/** A clock, or `null` where the runtime has none — nothing here invents a number. */
function nowMs(): number | null {
  return typeof performance === "object" && typeof performance.now === "function"
    ? performance.now()
    : null;
}

/**
 * Where the finished report goes. The desktop sets one at start-up that hands it to the shell
 * process, which writes it into `engine.log`; the web app sets none and the report goes to
 * `console.debug`, where somebody debugging their own tab can read it and nobody else ever sees
 * it. Set to `null` to go back to the console.
 */
export function setUiVitalsSink(next: UiVitalsSink | null): void {
  sink = next;
}

/**
 * A startup mark, measured from the document's own time origin — so `listUsableMs` IS "cold start
 * to a usable list" rather than a figure relative to something else that moved.
 *
 * ONCE PER MARK. A shell that re-mounts (a route change that unmounts the tree, a React strict
 * double-render in development) must not overwrite the real cold-start figure with a warm one.
 */
export function markStartup(mark: UiStartupMark): void {
  if (startup[mark] !== null) return;
  const at = nowMs();
  if (at === null) return;
  startup[mark] = at;
}

/** What the startup marks currently hold — for a test, and for the report. */
export function startupMarks(): Record<UiStartupMark, number | null> {
  return { ...startup };
}

/**
 * Record one finished interaction, in milliseconds.
 *
 * A negative or non-finite reading is dropped rather than stored: a clock that went backwards is
 * not a fast interaction, and one bad point moves a p95 more than a hundred good ones.
 */
export function recordInteraction(kind: UiInteraction, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  const ring = rings[kind];
  if (ring.values.length < RING) ring.values.push(ms);
  else ring.values[ring.next] = ms;
  ring.next = (ring.next + 1) % RING;
  ring.sinceReport += 1;
}

/* ── the pending interactions, each one start → the paint that ends it ───────────────────────── */

/** Keyed by message id so a second open while the first is still loading cannot end the wrong one. */
const pendingOpen = new Map<string, number>();
let pendingSwitch: number | null = null;
let pendingSearch: number | null = null;

/**
 * A message was asked for. The mark ends when THAT message's body is on screen
 * ({@link endOpen}) — a press that is abandoned leaves an entry, so the map is capped.
 */
export function beginOpen(messageId: string): void {
  const at = nowMs();
  if (at === null) return;
  // A reader who walks a pile with `j` opens faster than bodies arrive; the oldest pending press
  // is the one nobody is waiting for any more.
  if (pendingOpen.size >= 8) {
    const oldest = pendingOpen.keys().next().value;
    if (oldest !== undefined) pendingOpen.delete(oldest);
  }
  pendingOpen.set(messageId, at);
}

/** That message's body is painted. Silent when nothing was pending — a body can arrive unasked. */
export function endOpen(messageId: string): void {
  const started = pendingOpen.get(messageId);
  if (started === undefined) return;
  pendingOpen.delete(messageId);
  const at = nowMs();
  if (at !== null) recordInteraction("open", at - started);
}

/**
 * A view or folder switch was asked for. There is no second call site: the switch ends at the next
 * PAINT, which this schedules itself. Two frames, because one `requestAnimationFrame` callback
 * runs BEFORE the paint it belongs to — the second fires after the pixels are up.
 */
export function beginSwitch(): void {
  const at = nowMs();
  if (at === null) return;
  if (pendingSwitch !== null) return; // a switch already in flight owns the reading
  pendingSwitch = at;
  afterPaint(() => {
    const started = pendingSwitch;
    pendingSwitch = null;
    const ended = nowMs();
    if (started !== null && ended !== null) recordInteraction("switch", ended - started);
  });
}

/** A search was submitted; {@link endSearch} runs when its first results are on screen. */
export function beginSearch(): void {
  const at = nowMs();
  if (at === null) return;
  pendingSearch = at;
}

/** The first results for the pending search are rendered. */
export function endSearch(): void {
  const started = pendingSearch;
  if (started === null) return;
  pendingSearch = null;
  const at = nowMs();
  if (at !== null) recordInteraction("search", at - started);
}

/** Run after the next paint, or immediately where there is no frame loop (SSR, a test). */
function afterPaint(run: () => void): void {
  if (typeof requestAnimationFrame !== "function") {
    run();
    return;
  }
  requestAnimationFrame(() => requestAnimationFrame(run));
}

/* ── percentiles ─────────────────────────────────────────────────────────────────────────────── */

/**
 * The p-th percentile of a ring, rounded to a millisecond, or `null` when nothing is in it.
 *
 * Nearest-rank, which is the definition that needs no interpolation and cannot answer a value
 * nobody measured: p95 of a hundred readings is the 95th slowest one, and p95 of three readings is
 * the slowest of the three — honestly imprecise rather than falsely smooth.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return Math.round(sorted[index]!);
}

/* ── the frame sampler ───────────────────────────────────────────────────────────────────────── */

let frameHandle: number | null = null;
/**
 * NULL AND NOT ZERO. A frame timestamp of zero is a real reading — the first frame of a document
 * that has just started — and a zero sentinel made the frame after it look like a first frame too,
 * so the sampler counted nothing at all for the first two frames of every session. Found by its
 * own test, which is why the sentinel is a different type from the value.
 */
let lastFrameAt: number | null = null;
let taskObserver: PerformanceObserver | null = null;

/**
 * ONE frame observed — the whole rule, and the function the sampler runs.
 *
 * Exported so its test drives THIS and not a copy of it: a test that re-implemented "longer than
 * 50 ms counts" would go on passing after somebody changed the rule here.
 */
export function sampleFrame(at: number): void {
  if (lastFrameAt !== null && at - lastFrameAt > LONG_FRAME_MS) longFrames += 1;
  lastFrameAt = at;
}

/** The loop. Allocates nothing per frame — the cost of the instrument is two numbers. */
function onFrame(at: number): void {
  sampleFrame(at);
  frameHandle = requestAnimationFrame(onFrame);
}

function startSampler(): void {
  if (typeof requestAnimationFrame === "function" && frameHandle === null) {
    // The gap to the PREVIOUS session's last frame is not a dropped frame.
    lastFrameAt = null;
    frameHandle = requestAnimationFrame(onFrame);
  }
  /* `longtask` is Chromium's and is absent on WebKit, which is the Linux and macOS desktops. The
     frame counter above is present everywhere and is the reading that survives; a browser without
     the observer reports `longTasks: 0`, which is why the two are separate fields. */
  if (typeof PerformanceObserver === "function" && taskObserver === null) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > LONG_TASK_MS) longTasks += 1;
        }
      });
      observer.observe({ type: "longtask", buffered: false });
      taskObserver = observer;
    } catch {
      // An engine that has the constructor and not the entry type throws here. Not a failure:
      // the frame counter is the measurement, and this is the extra one.
      taskObserver = null;
    }
  }
}

function stopSampler(): void {
  if (frameHandle !== null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(frameHandle);
  }
  frameHandle = null;
  taskObserver?.disconnect();
  taskObserver = null;
}

/* ── the report ──────────────────────────────────────────────────────────────────────────────── */

/**
 * Compose one report and start the next window.
 *
 * The percentiles come off the ROLLING ring (the last hundred, however long they took to
 * accumulate) and the counts off the window (how many happened in these five minutes) — the first
 * answers "how fast is it", the second "how much did somebody do", and folding them into one
 * number would lose both.
 */
export function takeUiVitals(): UiVitalsReport {
  const engine = takeClientEngineVitals();
  const at = nowMs();
  const report: UiVitalsReport = {
    shellPaintedMs: rounded(startup.shellPainted),
    listUsableMs: rounded(startup.listUsable),
    engineReadyMs: rounded(startup.engineReady),
    openP50Ms: percentile(rings.open.values, 50),
    openP95Ms: percentile(rings.open.values, 95),
    openCount: rings.open.sinceReport,
    switchP50Ms: percentile(rings.switch.values, 50),
    switchP95Ms: percentile(rings.switch.values, 95),
    switchCount: rings.switch.sinceReport,
    searchP50Ms: percentile(rings.search.values, 50),
    searchP95Ms: percentile(rings.search.values, 95),
    searchCount: rings.search.sinceReport,
    longFrames,
    longTasks,
    // The WORST derivation in the window, not the mean: a mean over two thousand of them hides the
    // one that held the thread for a quarter of a second.
    deriveMs: engine.derives === 0 ? null : engine.deriveMsMax,
    notifiesPer5min: engine.notifies,
    uptimeMin: at === null ? null : Math.floor(at / 60_000),
  };
  rings.open.sinceReport = 0;
  rings.switch.sinceReport = 0;
  rings.search.sinceReport = 0;
  longFrames = 0;
  longTasks = 0;
  return report;
}

function rounded(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

/**
 * Start the instrument: the frame sampler, the long-task observer, and the five-minute report.
 * Answers the stop function.
 *
 * Idempotent by the caller rather than here — {@link useUiVitals} mounts once, and a second
 * shell in one document is not a state this app has.
 */
export function startUiVitals(intervalMs: number = REPORT_EVERY_MS): () => void {
  startSampler();
  const emit = (): void => {
    const report = takeUiVitals();
    if (sink) sink(report);
    else if (typeof console === "object" && typeof console.debug === "function") {
      console.debug("ui_vitals", report);
    }
  };
  const timer = setInterval(emit, intervalMs);
  return () => {
    clearInterval(timer);
    stopSampler();
  };
}

/** The shell's one mount of the instrument. Always on: there is no flag and no setting. */
export function useUiVitals(): void {
  useEffect(() => {
    // The shell is on screen the moment this effect runs — the mark is taken here rather than at
    // module load, which is before React has rendered anything.
    markStartup("shellPainted");
    return startUiVitals();
  }, []);
}

/** Everything back to nothing. A TEST seam: the counters are module state and suites share it. */
export function resetUiVitalsForTest(): void {
  rings.open = newRing();
  rings.switch = newRing();
  rings.search = newRing();
  startup.shellPainted = null;
  startup.listUsable = null;
  startup.engineReady = null;
  longFrames = 0;
  longTasks = 0;
  pendingOpen.clear();
  pendingSwitch = null;
  pendingSearch = null;
  lastFrameAt = null;
  sink = null;
  takeClientEngineVitals();
}
