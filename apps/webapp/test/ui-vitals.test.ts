import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INTERACTION_TIMEOUT_MS,
  abandonOpen,
  LONG_FRAME_MS,
  RING,
  beginOpen,
  beginSearch,
  beginSwitch,
  endOpen,
  endSearch,
  endSwitch,
  markStartup,
  noteInput,
  OPEN_INPUT_WINDOW_MS,
  percentile,
  recordInteraction,
  REPORT_EVERY_MS,
  REPORT_MAX_MS,
  REPORT_MIN_MS,
  resetUiVitalsForTest,
  sampleFrame,
  setUiVitalsInterval,
  setUiVitalsSink,
  startUiVitals,
  startupMarks,
  takeUiVitals,
  type UiVitalsReport,
} from "@ohmail/app-logic/session/ui-vitals";
import { beginDerive, countNotify, peekClientEngineVitals } from "@ohmail/client-engine";

/**
 * THE SHELL'S OWN INSTRUMENT — the half of the 0.16.2 incident nothing measured.
 *
 * The memory half is the desktop shell's (`renderer_vitals`); this is "it got slow", which was
 * evidence-free until now. Everything here drives the module's real functions: the percentile the
 * report uses, the frame rule the sampler runs, the pending-mark maps the call sites write into.
 * There is no second copy of any rule in this file.
 */

afterEach(() => {
  resetUiVitalsForTest();
  vi.useRealTimers();
});

describe("percentiles", () => {
  it("answers a value that was measured, never one interpolated between two", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1…100
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    // Nearest-rank on a short series: p95 of three readings is the slowest of the three.
    expect(percentile([10, 20, 30], 95)).toBe(30);
    expect(percentile([10, 20, 30], 50)).toBe(20);
  });

  it("has no answer for an empty ring, and does not say zero", () => {
    expect(percentile([], 95)).toBeNull();
  });

  it("does not depend on the order the readings arrived in", () => {
    expect(percentile([300, 10, 90, 40], 95)).toBe(300);
    expect(percentile([10, 40, 90, 300], 95)).toBe(300);
  });
});

describe("the interaction rings", () => {
  it("keeps the last hundred and no more — the instrument may not be the leak", () => {
    for (let i = 1; i <= RING + 50; i++) recordInteraction("open", i);
    const report = takeUiVitals();
    // The first fifty are gone, so the median is of 51…150 rather than of 1…150.
    expect(report.openP50Ms).toBe(100);
    expect(report.openP95Ms).toBe(145);
    // …and the COUNT is the window's, which is every one of them.
    expect(report.openCount).toBe(RING + 50);
  });

  it("refuses a reading a clock could not have produced", () => {
    recordInteraction("open", -1);
    recordInteraction("open", Number.NaN);
    recordInteraction("open", Number.POSITIVE_INFINITY);
    expect(takeUiVitals().openP95Ms).toBeNull();
  });

  it("counts per window and takes percentiles over the ring", () => {
    recordInteraction("switch", 100);
    recordInteraction("switch", 200);
    const first = takeUiVitals();
    expect(first.switchCount).toBe(2);
    expect(first.switchP95Ms).toBe(200);

    const second = takeUiVitals();
    expect(second.switchCount, "the count is what happened in THIS window").toBe(0);
    expect(second.switchP95Ms, "the ring rolls across windows").toBe(200);
  });
});

describe("the startup marks", () => {
  it("takes the first answer and refuses every later one", () => {
    markStartup("listUsable");
    const cold = startupMarks().listUsable;
    expect(cold).not.toBeNull();
    markStartup("listUsable");
    expect(startupMarks().listUsable, "a re-mount must not overwrite the cold figure").toBe(cold);
  });

  it("reports a mark nothing has reached as absent rather than as zero", () => {
    markStartup("shellPainted");
    const report = takeUiVitals();
    expect(report.shellPaintedMs).not.toBeNull();
    expect(report.listUsableMs).toBeNull();
    expect(report.engineReadyMs).toBeNull();
  });
});

describe("the open mark", () => {
  it("is keyed by message, so a second open cannot end the first", () => {
    beginOpen("m1");
    beginOpen("m2");
    endOpen("m2");
    expect(takeUiVitals().openCount).toBe(1);
  });

  it("records nothing for a body that arrives unasked", () => {
    endOpen("never-opened");
    expect(takeUiVitals().openCount).toBe(0);
  });

  it("ends once — a re-render of the same body is not a second open", () => {
    beginOpen("m1");
    endOpen("m1");
    endOpen("m1");
    expect(takeUiVitals().openCount).toBe(1);
  });

  it("ends at the paint that shows the body, not at the commit that wrote it", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    try {
      beginOpen("m1");
      endOpen("m1");
      expect(takeUiVitals().openCount, "the commit is not what a reader waits for").toBe(0);
      frames[0]!(performance.now());
      frames[1]!(performance.now());
      expect(takeUiVitals().openCount).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("holds one open at a time: a walk down a pile times only the open it stopped on", () => {
    for (let i = 0; i < 12; i++) beginOpen(`m${i}`);
    endOpen("m10");
    expect(takeUiVitals().openCount, "a superseded press ends nothing").toBe(0);
    endOpen("m11");
    expect(takeUiVitals().openCount).toBe(1);
  });
});

describe("an open mark belongs to one open", () => {
  /**
   * THE MARK THAT OUTLIVED ITS OPEN. The pane ends an open in a LAYOUT effect and the bar starts
   * it in a PASSIVE one, so a body already in the mirror was ended before it was begun, and an
   * abandoned open was never ended at all: either mark stood until that message was opened again,
   * and that open recorded the gap (0.24.0, Windows: open p95 6 816 173 ms). Driven in the order
   * the shell runs the two effects.
   */
  let clock = 0;
  beforeEach(() => {
    clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });
  afterEach(() => vi.restoreAllMocks());

  it("reads the second open's own time after an abandoned one, never the time since its mark", () => {
    beginOpen("m1"); // asked for; the body is still loading
    clock += 40;
    beginSwitch("#/screener"); // the view changed before the body rendered
    clock += 60 * 60_000; // long past any bound
    // m1 again, its body in the mirror by now: the pane commits it before the bar marks it.
    const gone = endOpen("m1");
    beginOpen("m1");
    gone?.(); // the pane moves on to m2, whose body is still loading
    beginOpen("m2");
    clock += 120;
    endOpen("m2");

    const report = takeUiVitals();
    expect(report.openP95Ms, "an open read the time since an earlier mark").toBe(120);
    expect(report.openCount).toBe(1);
  });

  it("a press to the view already on screen is not a switch, and cannot end one an hour later", () => {
    endSwitch("#/ohbox"); // the session's first view commits
    beginSwitch("#/ohbox"); // a press to it: nothing re-commits, so nothing ends the mark
    clock += 60 * 60_000;
    endSwitch("#/settings/general"); // Settings starts no switch of its own
    clock += 50;
    endSwitch("#/ohbox"); // Back to the Ohbox

    const report = takeUiVitals();
    expect(report.switchP95Ms, "a switch read the time since a press that asked for nothing").toBeNull();
    expect(report.switchCount).toBe(0);
    expect(report.switchTimeouts, "and a press that asked for nothing is no timeout either").toBe(0);
  });

  it("a superseded open records nothing for itself, and the open after it keeps its own time", () => {
    beginOpen("m1");
    clock += 300;
    beginOpen("m2"); // the reader moved on before m1's body came
    clock += 80;
    endOpen("m1"); // m1's body lands late, behind the reader's back
    endOpen("m2");
    const report = takeUiVitals();
    expect(report.openCount, "the superseded open was timed").toBe(1);
    expect(report.openP95Ms).toBe(80);
    expect(report.openTimeouts).toBe(0);
  });

  it("an open the view switch left records nothing when its body lands afterwards", () => {
    beginOpen("m1");
    clock += 200;
    beginSwitch("#/screener");
    clock += 100;
    endOpen("m1");
    const report = takeUiVitals();
    expect(report.openCount).toBe(0);
    expect(report.openTimeouts).toBe(0);
  });

  it("a reading closed before its body came records nothing, and is no timeout later", () => {
    beginOpen("m1");
    clock += 900;
    abandonOpen(); // the reader closed it
    clock += INTERACTION_TIMEOUT_MS + 1;
    endOpen("m1"); // its body lands in a pane that is no longer the reading's
    const report = takeUiVitals();
    expect(report.openTimeouts, "a closed reading expired as a timeout").toBe(0);
    expect(report.openCount).toBe(0);
  });

  it("an open slower than the bound is one timeout sample and never a duration", () => {
    beginOpen("m1");
    clock += INTERACTION_TIMEOUT_MS + 1;
    endOpen("m1");
    const report = takeUiVitals();
    expect(report.openTimeouts, "the slow open was not counted by name").toBe(1);
    expect(report.openCount, "the slow open was recorded as a duration").toBe(0);
    expect(report.openP95Ms).toBeNull();
  });

  it("an open that nothing ends expires into one timeout, and its late body ends nothing", () => {
    beginOpen("m1");
    clock += INTERACTION_TIMEOUT_MS + 1; // the window lost focus, the app idled
    expect(takeUiVitals().openTimeouts, "the report after the bound counts it").toBe(1);
    clock += 60 * 60_000;
    endOpen("m1");
    const later = takeUiVitals();
    expect(later.openTimeouts, "an expired mark was counted twice").toBe(0);
    expect(later.openCount, "an expired mark was ended an hour later").toBe(0);
  });

  it("an open at the bound exactly is a duration, one past it a timeout", () => {
    beginOpen("m1");
    clock += INTERACTION_TIMEOUT_MS;
    endOpen("m1");
    const report = takeUiVitals();
    expect(report.openP95Ms).toBe(INTERACTION_TIMEOUT_MS);
    expect(report.openTimeouts).toBe(0);
  });

  it("a body already on screen is not a pending open, however long it is read", () => {
    const gone = endOpen("m1"); // the pane committed it first
    beginOpen("m1"); // then the bar marked it
    clock += 10 * 60_000;
    const report = takeUiVitals();
    expect(report.openTimeouts, "a message being read expired as a timeout").toBe(0);
    expect(report.openCount).toBe(0);
    gone();
    // Once the pane has let it go, the same message opened again is a real wait.
    beginOpen("m1");
    clock += 90;
    endOpen("m1");
    expect(takeUiVitals().openP95Ms).toBe(90);
  });

  /**
   * THE PRESS IS THE START. A body in the mirror is committed before the bar marks the open, so
   * the press is the only start that precedes it: 0.25.2 read `openCount 0` over every open of a
   * mirrored body. Mutation: `beginOpen` drops a shown body again → the first case reads 0.
   */
  it("a press that paints a body the mirror holds is one open, timed from the press", () => {
    noteInput(); // the click
    clock += 35; // the render
    endOpen("m1"); // the pane commits the body
    beginOpen("m1"); // then the bar marks it; no frame loop here, so the paint is now
    const report = takeUiVitals();
    expect(report.openCount, "the press that painted the body was not timed").toBe(1);
    expect(report.openP95Ms).toBe(35);
  });

  it("a body on screen before the press, or a press long gone, starts no reading", () => {
    endOpen("m1"); // already on screen
    clock += 500;
    noteInput();
    beginOpen("m1"); // pressed while it was already showing: nothing waited
    noteInput();
    clock += OPEN_INPUT_WINDOW_MS + 1;
    const gone = endOpen("m2");
    beginOpen("m2"); // a mark this late is not that press's
    gone();
    const report = takeUiVitals();
    expect(report.openCount).toBe(0);
    expect(report.openTimeouts).toBe(0);
  });

  it("a switch slower than the bound is one timeout sample", () => {
    beginSwitch("#/history");
    clock += INTERACTION_TIMEOUT_MS + 1;
    endSwitch("#/history");
    const report = takeUiVitals();
    expect(report.switchTimeouts).toBe(1);
    expect(report.switchCount).toBe(0);
    expect(report.switchP95Ms).toBeNull();
  });

  it("a switch that nothing ends expires into one timeout, and a later commit ends nothing", () => {
    beginSwitch("#/trash");
    clock += INTERACTION_TIMEOUT_MS + 1;
    expect(takeUiVitals().switchTimeouts, "the report after the bound counts it").toBe(1);
    clock += 60 * 60_000;
    endSwitch("#/trash");
    const later = takeUiVitals();
    expect(later.switchTimeouts, "an expired switch was counted twice").toBe(0);
    expect(later.switchCount, "an expired switch was ended an hour later").toBe(0);
  });

  it("the ring takes no open or switch past the bound, and still takes a slow search", () => {
    recordInteraction("open", INTERACTION_TIMEOUT_MS + 1);
    recordInteraction("switch", INTERACTION_TIMEOUT_MS + 1);
    recordInteraction("search", INTERACTION_TIMEOUT_MS + 1);
    const report = takeUiVitals();
    expect(report.openP95Ms).toBeNull();
    expect(report.openTimeouts).toBe(1);
    expect(report.switchP95Ms).toBeNull();
    expect(report.switchTimeouts).toBe(1);
    expect(report.searchP95Ms).toBe(INTERACTION_TIMEOUT_MS + 1);
  });
});

describe("the search mark", () => {
  it("ends at the first results and is silent afterwards", () => {
    beginSearch();
    endSearch();
    endSearch();
    expect(takeUiVitals().searchCount).toBe(1);
  });

  it("records nothing when results render for a search nobody started", () => {
    endSearch();
    expect(takeUiVitals().searchCount).toBe(0);
  });
});

describe("the switch mark", () => {
  /**
   * THE END IS THE NEW VIEW, NOT THE NEXT PAINT. The mark used to schedule its own end two frames
   * after the press — the paint of the frame the press landed in, which still shows the view
   * somebody is leaving. It read 130 ms on the 0.19.0 Linux run while that run's driver read
   * 1 942 ms p95 watching the new view arrive.
   */
  function frameQueue(): { frames: FrameRequestCallback[]; paint: () => void } {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    // TWO frames: the first callback runs before the paint it belongs to.
    const paint = () => {
      const pending = frames.splice(0, frames.length);
      for (const cb of pending) cb(performance.now());
    };
    return { frames, paint };
  }

  it("records nothing until the view the press asked for is committed", () => {
    const { frames, paint } = frameQueue();
    try {
      beginSwitch("#/screener");
      expect(frames.length, "no frame is scheduled by the press alone").toBe(0);
      paint();
      paint();
      expect(takeUiVitals().switchCount, "the old view's paints end nothing").toBe(0);

      endSwitch("#/screener");
      expect(takeUiVitals().switchCount, "not before the paint that shows it").toBe(0);
      paint();
      paint();
      expect(takeUiVitals().switchCount).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("is keyed by view, so the view being left cannot end it", () => {
    const { paint } = frameQueue();
    try {
      beginSwitch("#/screener");
      endSwitch("#/ohbox");
      paint();
      paint();
      expect(takeUiVitals().switchCount).toBe(0);
      endSwitch("#/screener");
      paint();
      paint();
      expect(takeUiVitals().switchCount).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("gives the reading to a second press, and the abandoned view can no longer end one", () => {
    const { paint } = frameQueue();
    try {
      beginSwitch("#/screener");
      beginSwitch("#/reads");
      endSwitch("#/screener");
      paint();
      paint();
      expect(takeUiVitals().switchCount, "the abandoned view is not the wait").toBe(0);
      endSwitch("#/reads");
      paint();
      paint();
      expect(takeUiVitals().switchCount).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ends once — a re-render of the view that arrived is not a second switch", () => {
    const { paint } = frameQueue();
    try {
      beginSwitch("#/reads");
      endSwitch("#/reads");
      endSwitch("#/reads");
      paint();
      paint();
      expect(takeUiVitals().switchCount).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("records nothing for a view that commits with no switch pending", () => {
    const { paint } = frameQueue();
    try {
      endSwitch("#/ohbox");
      paint();
      paint();
      expect(takeUiVitals().switchCount).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the frame sampler", () => {
  /**
   * The rule the sampler itself runs — `sampleFrame` is the function the rAF loop calls, so this
   * cannot pass while the loop's rule has changed.
   */
  it("counts a frame over the budget and leaves one under it alone", () => {
    sampleFrame(0); // the first frame seeds the gap and counts nothing
    sampleFrame(40); // 40 ms — under
    sampleFrame(80); // 40 ms — under
    expect(takeUiVitals().longFrames).toBe(0);

    sampleFrame(140); // 60 ms — over
    expect(takeUiVitals().longFrames).toBe(1);
  });

  it("does not count the budget exactly, which is the frame that just made it", () => {
    sampleFrame(0);
    sampleFrame(LONG_FRAME_MS);
    expect(takeUiVitals().longFrames).toBe(0);
  });

  it("counts from the FIRST frame, whose timestamp may legitimately be zero", () => {
    // A zero sentinel for "no previous frame" made the second frame look like a first one, so a
    // session's opening stall was never counted. Restore `lastFrameAt = 0` and this goes red.
    sampleFrame(0);
    sampleFrame(200);
    expect(takeUiVitals().longFrames).toBe(1);
    // And the window after it sampled nothing at all, which is `null` and NOT a clean zero — a
    // count of zero out of a measurement that never ran is the one answer this field may not give.
    expect(takeUiVitals().longFrames).toBeNull();
  });

  it("says null for a window with no frames and zero for a window with good ones", () => {
    // The pair, because either alone passes for the other: `null` everywhere would be a sampler
    // that never runs, `0` everywhere the perfect score an idle window used to report.
    expect(takeUiVitals().longFrames, "nothing sampled").toBeNull();
    sampleFrame(0);
    sampleFrame(16);
    expect(takeUiVitals().longFrames, "two good frames sampled").toBe(0);
  });
});

describe("the client engine's own cost", () => {
  it("carries the notify count and says nothing about a derivation that never ran", () => {
    countNotify();
    countNotify();
    const report = takeUiVitals();
    expect(report.notifiesPer5min).toBe(2);
    expect(report.deriveMs, "no derivation ran, so there is no time to report").toBeNull();
    expect(report.deriveP50Ms).toBeNull();
    expect(report.deriveP95Ms).toBeNull();
    expect(report.deriveCount, "and a count of zero derivations IS the reading").toBe(0);
    expect(peekClientEngineVitals().notifies, "taking the report starts the next window").toBe(0);
  });

  it("carries the window's shape beside its worst pass once derivations have run", () => {
    // Driven through `beginDerive`, the seam the store calls: a report composed from counters
    // nothing wrote into would report `null` for ever and read as a quiet app.
    for (let i = 0; i < 4; i += 1) {
      const done = beginDerive();
      const until = performance.now() + 3;
      while (performance.now() < until) { /* hold the thread, as the mirror pass does */ }
      done?.();
    }

    const report = takeUiVitals();

    expect(report.deriveCount).toBe(4);
    expect(report.deriveP95Ms!).toBeGreaterThanOrEqual(3);
    expect(report.deriveP95Ms!).toBeLessThanOrEqual(report.deriveMs!);
    expect(report.deriveP50Ms!).toBeLessThanOrEqual(report.deriveP95Ms!);
  });
});

describe("the report", () => {
  it("carries numbers and nulls and nothing else — there is nowhere to put a subject", () => {
    markStartup("shellPainted");
    recordInteraction("open", 88);
    const report = takeUiVitals();
    for (const [key, value] of Object.entries(report)) {
      expect(typeof key, key).toBe("string");
      expect(value === null || typeof value === "number", `${key} is ${typeof value}`).toBe(true);
    }
    // The whole vocabulary is present on every report, so a reader never has to ask whether a
    // missing key means zero.
    expect(Object.keys(report).sort()).toEqual([
      "deriveCount", "deriveMs", "deriveP50Ms", "deriveP95Ms",
      "engineReadyMs", "listUsableMs", "longFrames", "longTasks", "mirrorMessages",
      "notifiesPer5min", "openCount", "openP50Ms", "openP95Ms", "openTimeouts",
      "searchCount", "searchP50Ms", "searchP95Ms",
      "shellPaintedMs", "switchCount", "switchP50Ms", "switchP95Ms", "switchTimeouts", "uptimeMin",
    ]);
  });

  it("goes to the sink the host set, on the interval, and to the console with none", () => {
    vi.useFakeTimers();
    const seen: UiVitalsReport[] = [];
    setUiVitalsSink((report) => seen.push(report));
    const stop = startUiVitals(1_000);
    try {
      recordInteraction("open", 42);
      vi.advanceTimersByTime(1_000);
      expect(seen.length).toBe(1);
      expect(seen[0]!.openCount).toBe(1);
      vi.advanceTimersByTime(1_000);
      expect(seen.length).toBe(2);
      expect(seen[1]!.openCount, "each report covers its own window").toBe(0);
    } finally {
      stop();
    }
    vi.advanceTimersByTime(5_000);
    expect(seen.length, "the stop function stops it").toBe(2);
  });
});

describe("the startup report", () => {
  /**
   * A START CELL NEVER REACHES THE INTERVAL. The three marks used to ride only the five-minute
   * report, so a cell that launched the app, waited for the list and closed it read no mark at all
   * — which is why every 0.19.0 start figure on all three platforms is driver-timed. These drive
   * the real flush, not a copy of its condition.
   */
  it("goes out as soon as the three marks are complete, without waiting an interval", () => {
    vi.useFakeTimers();
    const seen: UiVitalsReport[] = [];
    setUiVitalsSink((report) => seen.push(report));
    markStartup("shellPainted");
    const stop = startUiVitals(300_000);
    try {
      expect(seen.length, "two marks are not a start").toBe(0);
      markStartup("engineReady");
      expect(seen.length, "two marks are not a start").toBe(0);
      markStartup("listUsable");
      expect(seen.length, "the third mark completes the start").toBe(1);
      expect(seen[0]!.shellPaintedMs).not.toBeNull();
      expect(seen[0]!.listUsableMs).not.toBeNull();
      expect(seen[0]!.engineReadyMs).not.toBeNull();
    } finally {
      stop();
    }
  });

  it("goes out ONCE — a later interval report is the interval's, not a second start", () => {
    vi.useFakeTimers();
    const seen: UiVitalsReport[] = [];
    setUiVitalsSink((report) => seen.push(report));
    markStartup("shellPainted");
    const stop = startUiVitals(1_000);
    try {
      markStartup("engineReady");
      markStartup("listUsable");
      expect(seen.length).toBe(1);
      // Every mark is already set, so these are the no-ops a re-mount makes — and not a second start.
      markStartup("listUsable");
      markStartup("shellPainted");
      expect(seen.length, "the flush is once per session").toBe(1);
      vi.advanceTimersByTime(1_000);
      expect(seen.length, "the interval still runs").toBe(2);
    } finally {
      stop();
    }
  });

  /* ── the cadence the host asks for ─────────────────────────────────────────────────────── */

  /**
   * THE KNOB IS THE WHOLE REASON A SHORT RUN CAN READ THESE FIGURES. A measurement cell drives
   * twenty opens and closes the app inside a minute; on the shipped five-minute cadence the
   * interaction percentiles it drove are still in the ring when the window goes, so every
   * recorded latency of this app so far came from a driver's stopwatch instead.
   */
  it("re-arms a running report on the cadence the host answered with", () => {
    vi.useFakeTimers();
    const seen: UiVitalsReport[] = [];
    setUiVitalsSink((report) => seen.push(report));
    const stop = startUiVitals(REPORT_EVERY_MS);
    try {
      vi.advanceTimersByTime(REPORT_EVERY_MS - 1);
      expect(seen.length, "the shipped cadence has not come round").toBe(0);
      setUiVitalsInterval(5_000);
      vi.advanceTimersByTime(5_000);
      expect(seen.length, "the answered cadence is the one that fires").toBe(1);
      vi.advanceTimersByTime(5_000);
      expect(seen.length).toBe(2);
    } finally {
      stop();
    }
  });

  it("takes no answer, and no answer outside the range, and keeps the shipped cadence", () => {
    vi.useFakeTimers();
    const seen: UiVitalsReport[] = [];
    setUiVitalsSink((report) => seen.push(report));
    const stop = startUiVitals(REPORT_EVERY_MS);
    try {
      for (const answer of [
        null,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        0,
        -5_000,
        REPORT_MIN_MS - 1,
        REPORT_MAX_MS + 1,
      ]) {
        setUiVitalsInterval(answer);
      }
      vi.advanceTimersByTime(REPORT_EVERY_MS - 1);
      expect(seen.length, "a refused answer left the shipped cadence standing").toBe(0);
      vi.advanceTimersByTime(1);
      expect(seen.length).toBe(1);
      // …and both ends of the range itself are taken.
      setUiVitalsInterval(REPORT_MIN_MS);
      vi.advanceTimersByTime(REPORT_MIN_MS);
      expect(seen.length).toBe(2);
    } finally {
      stop();
    }
  });

  it("the shipped cadence is what an unanswered instrument runs on", () => {
    vi.useFakeTimers();
    const seen: UiVitalsReport[] = [];
    setUiVitalsSink((report) => seen.push(report));
    // The DEFAULT is read from the module, never written as a literal here: a test asserting five
    // minutes would go on passing after somebody moved the shipped cadence.
    const stop = startUiVitals();
    try {
      vi.advanceTimersByTime(REPORT_EVERY_MS - 1);
      expect(seen.length).toBe(0);
      vi.advanceTimersByTime(1);
      expect(seen.length).toBe(1);
    } finally {
      stop();
    }
  });

  it("reports a start whose marks all landed before the instrument was started", () => {
    vi.useFakeTimers();
    const seen: UiVitalsReport[] = [];
    setUiVitalsSink((report) => seen.push(report));
    markStartup("shellPainted");
    markStartup("engineReady");
    markStartup("listUsable");
    expect(seen.length, "nothing can be emitted before there is an emitter").toBe(0);
    const stop = startUiVitals(300_000);
    try {
      expect(seen.length, "the instrument flushes what it finds already complete").toBe(1);
    } finally {
      stop();
    }
  });
});
