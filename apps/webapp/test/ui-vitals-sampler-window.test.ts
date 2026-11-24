/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INTERACTION_QUIET_MS,
  resetUiVitalsForTest,
  startUiVitals,
  takeUiVitals,
} from "@ohmail/app-logic/session/ui-vitals";

/**
 * ═══ THE FRAME SAMPLER RUNS WHILE THE WINDOW IS BEING USED, AND NOT OTHERWISE ════════════════
 *
 * The sampler's loop re-armed itself unconditionally, which is 60 callbacks a second for the life
 * of the window — an instrument putting a floor under the app it exists to measure. Frame gaps are
 * a fact about interaction: nobody drops a frame nobody was waiting for.
 *
 * So it runs armed by what a person does and for {@link INTERACTION_QUIET_MS} after the last of
 * it, and never while the document is hidden. Every refusal below has the admission beside it —
 * a sampler that never runs measures nothing, which is the failure this instrument was written
 * against in the first place.
 *
 * `requestAnimationFrame` is a queue this file drains by hand; the outstanding callbacks after a
 * drain are the fact, and they cannot be reached by waiting.
 */

let pending = new Map<number, FrameRequestCallback>();
let nextHandle = 1;
let clock = 2_000_000;
let hiddenNow = false;
/** The sampler's own loop, captured at start: it re-arms with the same function object. */
let samplerFrame: FrameRequestCallback | null = null;

function armed(): number {
  return [...pending.values()].filter((cb) => cb === samplerFrame).length;
}

/** Run every queued frame at the current clock. */
function drain(): void {
  const due = [...pending.values()];
  pending = new Map();
  for (const cb of due) cb(clock);
}

/** Start the instrument with a report interval that never fires — the loop is the subject here. */
function start(): () => void {
  const stop = startUiVitals(60 * 60_000);
  if (pending.size !== 1) throw new Error(`start armed ${pending.size} frames, expected 1`);
  samplerFrame = [...pending.values()][0]!;
  return stop;
}

beforeEach(() => {
  pending = new Map();
  nextHandle = 1;
  clock = 2_000_000;
  hiddenNow = false;
  samplerFrame = null;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hiddenNow });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hiddenNow ? "hidden" : "visible"),
  });
  (globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) => {
    const handle = nextHandle++;
    pending.set(handle, cb);
    return handle;
  };
  (globalThis as Record<string, unknown>).cancelAnimationFrame = (handle: number) => {
    pending.delete(handle);
  };
});

afterEach(() => {
  resetUiVitalsForTest();
  vi.restoreAllMocks();
});

describe("the frame sampler's interaction window", () => {
  it("runs from the load, keeps running inside the window, and lets go after it", async () => {
    const stop = start();
    try {
      // The load IS the first interaction — a cold start is the window whose frames matter most.
      expect(armed(), "the start arms it").toBe(1);
      clock += INTERACTION_QUIET_MS - 1;
      drain();
      expect(armed(), "still inside the window").toBe(1);

      clock += 2;
      drain();
      expect(armed(), "the window ran out").toBe(0);
      drain();
      clock += 10 * INTERACTION_QUIET_MS;
      expect(armed(), "and nothing re-armed it by itself").toBe(0);
    } finally {
      stop();
    }
  });

  it("a key, a press, a wheel and a scroll each arm it again", async () => {
    const stop = start();
    try {
      for (const type of ["keydown", "pointerdown", "wheel", "scroll"]) {
        clock += INTERACTION_QUIET_MS + 1;
        drain();
        expect(armed(), `quiet before ${type}`).toBe(0);
        document.dispatchEvent(new Event(type));
        expect(armed(), `${type} is somebody using the window`).toBe(1);
      }
    } finally {
      stop();
    }
  });

  it("a hidden document neither holds it open nor lets an event start it", async () => {
    const stop = start();
    try {
      hiddenNow = true;
      drain();
      expect(armed(), "going hidden ends it at the next frame").toBe(0);

      document.dispatchEvent(new Event("keydown"));
      expect(armed(), "and a hidden window cannot be armed").toBe(0);

      hiddenNow = false;
      document.dispatchEvent(new Event("visibilitychange"));
      expect(armed(), "coming back to the tab is using it again").toBe(1);
    } finally {
      stop();
    }
  });

  it("the report says null for a window it did not sample and a count for one it did", async () => {
    const stop = start();
    try {
      // Frames observed: three frames 40 ms apart is no long frame, and the field is a NUMBER.
      for (const step of [0, 40, 40]) {
        clock += step;
        drain();
      }
      expect(takeUiVitals().longFrames, "frames were sampled").toBe(0);

      // Now let it go quiet, and the next window is honestly unmeasured rather than perfect.
      clock += INTERACTION_QUIET_MS + 1;
      drain();
      expect(armed()).toBe(0);
      expect(takeUiVitals().longFrames, "nothing sampled in this window").toBeNull();
    } finally {
      stop();
    }
  });

  it("stopping the instrument takes its arming listeners with it", async () => {
    const stop = start();
    clock += INTERACTION_QUIET_MS + 1;
    drain();
    stop();
    pending = new Map();
    document.dispatchEvent(new Event("keydown"));
    expect(pending.size, "a stopped instrument answers nothing").toBe(0);
  });
});
