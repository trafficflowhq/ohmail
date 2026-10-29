import { describe, expect, it } from "vitest";
import { clockOf, judgedClockOf, judgedVerdicts, mustJudge, outcomeOf, verdicts, windowOf, type Round } from "./_budget-clock.js";

/** A round whose reference read `before`/`after` at its ends and `during` (median, p95) inside it, on a host at `load`. */
const round = (before: number, after: number, ms: number, during = { median: Math.min(before, after), p95: Math.max(before, after) }, load = 1.5): Round =>
  ({ before, after, during, load, figures: { page: ms } });
const quiet = clockOf(11, 32);

describe("the search budget's clock", () => {
  it("a run loaded throughout is unjudged, never over", () => {
    const rounds = [round(20, 21, 130), round(22, 21, 128), round(21, 20, 133)];
    expect(verdicts(rounds, 100, clockOf(20, 32)).page).toEqual({ kind: "unjudged", ms: 128 });
  });

  it("a quiet round over the budget fails it whatever a loaded round read; a round within passes", () => {
    const q = round(11, 12, 104);
    expect(verdicts([q, round(19, 20, 120)], 100, quiet).page).toEqual({ kind: "over", ms: 104, round: q });
    expect(verdicts([q, round(19, 20, 95)], 100, quiet).page).toEqual({ kind: "within", ms: 95 });
  });

  it("with no quiet round, a figure past twice the budget is over: load alone has never read that slow", () => {
    const loaded = clockOf(20, 32);
    expect(verdicts([round(20, 21, 201), round(22, 21, 573)], 100, loaded).page).toEqual({ kind: "over", ms: 201 });
    expect(verdicts([round(20, 21, 200)], 100, loaded).page).toEqual({ kind: "unjudged", ms: 200 });
  });

  it("a round quiet at one end only is not quiet", () => {
    expect(verdicts([round(12, 19, 104)], 100, quiet).page.kind).toBe("unjudged");
    expect(verdicts([round(19, 12, 104)], 100, quiet).page.kind).toBe("unjudged");
  });

  it("a round whose reference rose while it ran is loaded, though both ends read quiet", () => {
    // Host load in the middle of the round: the reference read beside each sample moves with it.
    const spiked = round(11, 12, 118, { median: 12, p95: 21 });
    const slow = round(11, 12, 118, { median: 17, p95: 18 });
    expect(verdicts([spiked], 100, quiet).page).toEqual({ kind: "unjudged", ms: 118 });
    expect(verdicts([slow], 100, quiet).page).toEqual({ kind: "unjudged", ms: 118 });
  });

  it("a run loaded from its first reading is loaded though every round reads near the run's own quietest", () => {
    // Measured at host load 30: the whole run read the reference at 13.6 ms or more, 11 ms on a quiet host.
    const round18 = round(13.9, 13.7, 107, { median: 13.6, p95: 19.1 });
    expect(verdicts([round18], 100, clockOf(13.6, 32)).page).toEqual({ kind: "unjudged", ms: 107 });
  });

  it("a round on a host whose load average is over a quarter of its CPUs is loaded, whatever the reference read", () => {
    // Host load 15-28 on 32 CPUs took figures to 1.6-2.7 times their quiet reading while the reference read quiet.
    expect(verdicts([round(11, 12, 107, { median: 11.5, p95: 13 }, 24)], 100, quiet).page).toEqual({ kind: "unjudged", ms: 107 });
    expect(verdicts([round(11, 12, 107, { median: 11.5, p95: 13 }, 8)], 100, quiet).page.kind).toBe("over");
    // The test's own processes on a small machine: load 2 on 4 CPUs still judges.
    expect(verdicts([round(11, 12, 107, { median: 11.5, p95: 13 }, 2)], 100, clockOf(11, 4)).page.kind).toBe("over");
  });

  it("a quiet host's longer round, its p95 half again its quietest median, still judges a slow query", () => {
    // Measured at host load 6.5: 120 readings inside the far round, median 11.9 and p95 16.3, the quietest 10.7.
    const far = round(10.7, 11.4, 104, { median: 11.9, p95: 16.3 }, 6.5);
    expect(verdicts([far], 100, clockOf(10.7, 32)).page.kind).toBe("over");
  });

  it("a quiet host still fails a slow query: a steady reference inside the round judges it", () => {
    const steady = round(11, 12, 104, { median: 11.5, p95: 13 });
    expect(verdicts([steady, round(11, 12, 118, { median: 12, p95: 21 })], 100, quiet).page).toEqual({ kind: "over", ms: 104, round: steady });
  });

  it("the quiet limit is a quarter over the quietest median, never over 13.5 ms; the spike limit 1.6 times it", () => {
    expect(clockOf(10, 32)).toEqual({ limit: 12.5, spike: 16, load: 8 });
    expect(clockOf(15, 4)).toEqual({ limit: 13.5, spike: 24, load: 2 });
  });

  it("a host that must judge (the nightly's) fails a figure over the budget with no quiet round; elsewhere it is SKIPPED-LOADED", () => {
    const loaded = clockOf(13.6, 4);
    const v = verdicts([round(17, 18, 118, { median: 16, p95: 22 }, 3), round(16, 17, 112, { median: 16, p95: 21 }, 3)], 100, loaded).page!;
    expect(v).toEqual({ kind: "unjudged", ms: 112 });
    expect(outcomeOf(v, mustJudge({ OHMAIL_BUDGET_MUST_JUDGE: "1" }))).toBe("fail");
    expect(outcomeOf(v, mustJudge({}))).toBe("skipped-loaded");
    expect(outcomeOf(v, mustJudge({ OHMAIL_BUDGET_MUST_JUDGE: "0" }))).toBe("skipped-loaded");
    // A figure inside the budget passes on any clock; one over on a quiet round fails on any host.
    const within = verdicts([round(17, 18, 96, { median: 16, p95: 22 }, 3)], 100, loaded).page!;
    expect(outcomeOf(within, true)).toBe("pass");
    const over = verdicts([round(11, 12, 104, { median: 11.5, p95: 13 })], 100, quiet).page!;
    expect(outcomeOf(over, false)).toBe("fail");
    expect(outcomeOf(over, true)).toBe("fail");
  });

  it("where it must judge, a slower runner's figures are scaled to the calibrated reference and its rounds are quiet against its own quietest", () => {
    // The hosted runner: the reference at 24 ms at its quietest, load 1.1 on 4 CPUs; over the absolute cap on every round.
    const hosted = (ms: number) => [round(25, 26, ms, { median: 25, p95: 30 }, 1.1), round(24, 25, ms + 3, { median: 24.5, p95: 29 }, 1.2)];
    expect(outcomeOf(verdicts(hosted(102), 100, clockOf(24, 4)).page!, true)).toBe("fail");
    expect(judgedVerdicts(hosted(102), 100, 24, 4).page).toEqual({ kind: "within", ms: 57.4 });
    // A regression planted on the same runner: 90 ms more reads 108 ms on the calibrated machine.
    const slow = judgedVerdicts(hosted(192), 100, 24, 4).page!;
    expect(slow).toMatchObject({ kind: "over", ms: 108 });
    expect(outcomeOf(slow, true)).toBe("fail");
    // Load on the slow runner still leaves it unjudged, a failure where it must judge.
    expect(outcomeOf(judgedVerdicts([round(25, 26, 192, { median: 25, p95: 30 }, 3)], 100, 24, 4).page!, true)).toBe("fail");
    expect(judgedVerdicts([round(25, 26, 192, { median: 25, p95: 30 }, 3)], 100, 24, 4).page!.kind).toBe("unjudged");
  });

  it("where it must judge, a figure's round-trip wait is not scaled: only its CPU share is", () => {
    // Four statements at 8 ms: 32 ms of each figure is a timer, as long on any machine.
    const hosted = (ms: number) => [round(25, 26, ms, { median: 24.4, p95: 29 }, 1.1)];
    const at170 = judgedVerdicts(hosted(170), 100, 24.4, 4, { page: 32 }).page!;
    expect(at170).toMatchObject({ kind: "over", ms: 108.4 });
    expect(outcomeOf(at170, true)).toBe("fail");
    expect(judgedVerdicts(hosted(102), 100, 24.4, 4, { page: 32 }).page).toEqual({ kind: "within", ms: 70.7 });
    // A figure with no round trip (a local socket) is scaled whole.
    expect(judgedVerdicts(hosted(170), 100, 24.4, 4).page).toEqual({ kind: "within", ms: 94.1 });
    // On a runner at the calibrated reference nothing moves.
    expect(judgedVerdicts([round(11, 12, 104, { median: 11.5, p95: 13 })], 100, 12, 32, { page: 32 }).page).toMatchObject({ kind: "over", ms: 104 });
  });

  it("where it must judge, a runner at or under the calibrated reference is judged as everywhere else", () => {
    for (const rs of [[round(11, 12, 104, { median: 11.5, p95: 13 })], [round(11, 12, 95)], [round(14, 14, 104, { median: 14, p95: 15 })], [round(20, 21, 130)]])
      expect(judgedVerdicts(rs, 100, 12, 32)).toEqual(verdicts(rs, 100, clockOf(12, 32)));
    expect(judgedClockOf(12, 32)).toEqual(clockOf(12, 32));
    expect(judgedClockOf(24, 4)).toMatchObject({ limit: 30, load: 2 });
  });

  it("a window of reference readings gives its median and p95", () => {
    expect(windowOf([12, 11, 30, 13, 12, 11, 12, 12, 13, 11, 12, 12, 11, 12, 13, 12, 11, 12, 25, 12])).toEqual({ median: 12, p95: 25 });
  });
});
