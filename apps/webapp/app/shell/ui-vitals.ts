"use client";

/**
 * WHAT THE WINDOW FEELS LIKE, MEASURED BY THE WINDOW. `engine_vitals` and `renderer_vitals` say
 * what the two processes cost; neither says whether opening a message took 90 ms or 900. The shell
 * times itself: three startup marks, three interactions, two frame counters and the client engine's
 * derivation cost — a ring of the last hundred readings each, p50 and p95 every five minutes, on
 * the same clock as the other two lines. Every value is a count or a duration, so there is nowhere
 * to put an id, an address, a subject, a folder name or a query. There is no flag: an instrument
 * that has to be turned on is off during the incident.
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

/**
 * THE RANGE A HOST MAY MOVE THE REPORT INTO. Five minutes is the right cadence for a window
 * somebody is using and the wrong one for a measurement run, which ends before the first report
 * and reads none of these figures. So the desktop shell — the only door with an environment to
 * read — may answer with a cadence, and these are the bounds it is answered within: the same two
 * numbers as `vitals.rs`, asserted equal by `ui-vitals-census.test.ts`.
 */
export const REPORT_MIN_MS = 1_000;
export const REPORT_MAX_MS = 60 * 60_000;

/** A frame that took longer than this is one somebody saw drop. 50 ms is three frames at 60 Hz. */
export const LONG_FRAME_MS = 50;

/** A task longer than this blocks every input for its whole duration. */
export const LONG_TASK_MS = 200;

/**
 * How long the frame sampler keeps running after the last thing somebody did.
 *
 * A frame-gap sampler that re-arms for ever is 60 callbacks a second for the life of the window,
 * which is a floor the instrument itself puts under the app it is measuring. Frame gaps are a fact
 * about INTERACTION — nobody drops a frame nobody was waiting for — so the sampler runs while the
 * window is being used and for ten seconds after, and not at all while the document is hidden.
 */
export const INTERACTION_QUIET_MS = 10_000;

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

/**
 * THE STARTUP REPORT, EMITTED ONCE THE THREE MARKS ARE COMPLETE.
 *
 * Five minutes is the wrong clock for a start: a cell that launches the app, waits for the list and
 * closes it never reaches the interval, so it reads no mark at all — which is why every 0.19.0 start
 * figure on all three platforms is driver-timed and no platform has ever read `listUsableMs` for a
 * start. The VOCABULARY is the ordinary report's, so this is one more report, earlier, and not a
 * second shape the desktop's shell, its log line and the CI check would each have to learn.
 */
let startupEmitted = false;
let emitReport: (() => void) | null = null;

function flushStartupOnce(): void {
  if (startupEmitted || emitReport === null) return;
  if (startup.shellPainted === null || startup.listUsable === null || startup.engineReady === null) {
    return;
  }
  startupEmitted = true;
  emitReport();
}

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
  flushStartupOnce();
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
/**
 * How many frames the sampler actually saw in this report window.
 *
 * `longFrames: 0` out of a window that sampled NOTHING is a perfect score for a measurement that
 * never happened, and that is the one reading an instrument may not give. Zero frames seen makes
 * the field `null` — "not measured" — which is what an untouched five minutes honestly is.
 */
let framesSeen = 0;
/** The sampler runs until this moment; every interaction pushes it out. */
let activeUntil = 0;
let taskObserver: PerformanceObserver | null = null;
/** Undoes the arming listeners, or `null` when none are attached. */
let detachArming: (() => void) | null = null;

/**
 * ONE frame observed — the whole rule, and the function the sampler runs.
 *
 * Exported so its test drives THIS and not a copy of it: a test that re-implemented "longer than
 * 50 ms counts" would go on passing after somebody changed the rule here.
 */
export function sampleFrame(at: number): void {
  if (lastFrameAt !== null && at - lastFrameAt > LONG_FRAME_MS) longFrames += 1;
  lastFrameAt = at;
  framesSeen += 1;
}

/** Is this document hidden? `false` where there is no document to ask. */
function hiddenNow(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * The loop. Allocates nothing per frame, and stops itself: the quiet window having run out, or
 * the document having gone hidden, ends it until somebody does something again.
 */
function onFrame(at: number): void {
  if (hiddenNow() || Date.now() > activeUntil) {
    frameHandle = null;
    // The gap ACROSS a stop is not a dropped frame — see {@link lastFrameAt}.
    lastFrameAt = null;
    return;
  }
  sampleFrame(at);
  frameHandle = requestAnimationFrame(onFrame);
}

/**
 * Somebody is using the window: run the sampler, and keep running for
 * {@link INTERACTION_QUIET_MS} after the last of it. Never while hidden — a background tab's frame
 * gaps are the browser's throttling, not the app's cost, and measuring them would make every
 * report about whichever tab the reader left open.
 */
export function armUiVitalsSampler(): void {
  if (hiddenNow()) return;
  activeUntil = Date.now() + INTERACTION_QUIET_MS;
  if (typeof requestAnimationFrame === "function" && frameHandle === null) {
    // The gap to the PREVIOUS window's last frame is not a dropped frame.
    lastFrameAt = null;
    frameHandle = requestAnimationFrame(onFrame);
  }
}

function startSampler(): void {
  /* The four things a person does with a window, plus the return to a tab they had left. `scroll`
     and `wheel` are captured because neither reaches the document from inside a scroller on its
     own; all five are passive — this arms an instrument, it never answers the gesture. */
  if (typeof document !== "undefined" && detachArming === null) {
    const arm = (): void => armUiVitalsSampler();
    const opts = { capture: true, passive: true } as const;
    const events = ["pointerdown", "keydown", "wheel", "scroll", "visibilitychange"] as const;
    for (const e of events) document.addEventListener(e, arm, opts);
    detachArming = () => {
      for (const e of events) document.removeEventListener(e, arm, opts);
    };
  }
  // The load IS the first interaction: a cold start is exactly the window whose frames matter.
  armUiVitalsSampler();
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
  activeUntil = 0;
  detachArming?.();
  detachArming = null;
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
    // `null` and not `0` when the sampler saw no frame at all in this window — see {@link framesSeen}.
    longFrames: framesSeen === 0 ? null : longFrames,
    longTasks,
    // The WORST derivation in the window, not the mean: a mean over two thousand of them hides the
    // one that held the thread for a quarter of a second.
    deriveMs: engine.derives === 0 ? null : engine.deriveMsMax,
    /* AND WHAT THE WINDOW IS USUALLY LIKE, beside what its worst moment was. The max alone cannot
       say whether a mailbox is slow or had one bad pass, which is the question a reader asks of a
       75k mailbox; the count says how many bumps paid it. `deriveCount` is a plain count — zero
       derivations in five minutes is a real reading — while the three durations are `null` rather
       than `0`, because a window that derived nothing measured no milliseconds. */
    deriveP50Ms: engine.deriveMsP50,
    deriveP95Ms: engine.deriveMsP95,
    deriveCount: engine.derives,
    notifiesPer5min: engine.notifies,
    uptimeMin: at === null ? null : Math.floor(at / 60_000),
  };
  rings.open.sinceReport = 0;
  rings.switch.sinceReport = 0;
  rings.search.sinceReport = 0;
  longFrames = 0;
  longTasks = 0;
  framesSeen = 0;
  return report;
}

function rounded(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

/** The cadence a host asked for, or `null` for the one this module ships with. */
let intervalOverrideMs: number | null = null;
/** Re-arms a running report on a new cadence, or `null` when none is running. */
let retime: (() => void) | null = null;

/**
 * THE CADENCE THE HOST ASKED FOR, taken from the answer to a report rather than from a setting.
 *
 * A window cannot read the process environment, so the knob lives in the desktop shell and rides
 * back on the `ui_vitals` call this instrument already makes. `null`, a non-number and anything
 * outside {@link REPORT_MIN_MS}..{@link REPORT_MAX_MS} are all "no answer" and leave the shipped
 * cadence standing — a shell one version ahead cannot talk this window into reporting every
 * millisecond, which would make the instrument a cost on the thing it measures.
 */
export function setUiVitalsInterval(ms: number | null): void {
  if (ms === null || !Number.isFinite(ms) || ms < REPORT_MIN_MS || ms > REPORT_MAX_MS) return;
  const next = Math.round(ms);
  if (next === intervalOverrideMs) return;
  intervalOverrideMs = next;
  retime?.();
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
  let timer = setInterval(emit, intervalOverrideMs ?? intervalMs);
  retime = () => {
    clearInterval(timer);
    timer = setInterval(emit, intervalOverrideMs ?? intervalMs);
  };
  // Armed AFTER `emit` exists and flushed immediately: `shellPainted` is marked by the same effect
  // that calls this, one line earlier, so a start whose other two marks are already in is reported
  // here rather than waiting out an interval it may never see.
  emitReport = emit;
  flushStartupOnce();
  return () => {
    clearInterval(timer);
    retime = null;
    emitReport = null;
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
  // The sampler and its arming listeners are module state too: a suite that left one running
  // would arm the next suite's window from the previous one's events.
  stopSampler();
  startupEmitted = false;
  emitReport = null;
  intervalOverrideMs = null;
  retime = null;
  rings.open = newRing();
  rings.switch = newRing();
  rings.search = newRing();
  startup.shellPainted = null;
  startup.listUsable = null;
  startup.engineReady = null;
  longFrames = 0;
  longTasks = 0;
  framesSeen = 0;
  activeUntil = 0;
  pendingOpen.clear();
  pendingSwitch = null;
  pendingSearch = null;
  lastFrameAt = null;
  sink = null;
  takeClientEngineVitals();
}
