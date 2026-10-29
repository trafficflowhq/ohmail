/**
 * THE BUDGET'S CLOCK: which rounds of a timed figure may fail the budget. A fixed CPU-bound reference
 * statement is read before and after a round and once beside every sample inside it. The round is quiet
 * when its two ends and the median of its inside readings are at or under the limit, the p95 of those
 * inside readings is at or under the spike limit (QUIET_SPIKE times the quietest median), and the host's
 * one-minute load average stayed at or under a quarter of its CPUs: load that comes and goes within a
 * round slows the samples it lands on and the readings beside them, and a busy host slows memory-bound
 * reads more than the reference shows. Load only slows a figure, so any round at or under the budget
 * passes it; a figure over the budget fails only on a quiet round, and with no quiet round it is
 * unjudged, never red, up to LOADED_CEILING times the budget: past that it is over on any clock.
 */
/**
 * The CI runners read the reference at 10.9-12.7 ms quiet, a workstation at 11; a quietest reading above
 * this is load. At 15, a run loaded throughout (host load 30) counted a round at 13.6 ms as quiet, where
 * load had taken a figure from 60-65 ms to 107.
 */
export const QUIET_REF_MS = 13.5;
export const QUIET_RATIO = 1.25;
/** The inside readings' p95 on a quiet host (load 6.5 on 32 CPUs) read up to 1.52 times the quietest median. */
export const QUIET_SPIKE = 1.6;
/** Load alone has read a figure at most 163 ms (104-163 on record); a run past twice the budget is the product. */
export const LOADED_CEILING = 2;
/** A quiet host's load average: at most this share of its CPUs, or QUIET_LOAD_FLOOR (the test's own processes). */
export const QUIET_LOAD_SHARE = 0.25;
export const QUIET_LOAD_FLOOR = 2;

export interface Window { median: number; p95: number }
export interface Round { before: number; after: number; during: Window; load: number; figures: Record<string, number> }
export interface Clock { limit: number; spike: number; load: number }

export type Verdict =
  | { kind: "within"; ms: number }
  | { kind: "over"; ms: number; round?: Round }
  | { kind: "unjudged"; ms: number };

/** A window of reference readings: its median and its p95, the order statistic the figures are read at. */
export function windowOf(xs: number[]): Window {
  const s = [...xs].sort((a, b) => a - b);
  return { median: s[Math.floor((s.length - 1) / 2)]!, p95: s[Math.ceil(s.length * 0.95) - 1]! };
}
/** The limits from the run's quietest median reading (a quarter over it, at most QUIET_REF_MS) and the host's CPUs. */
export const clockOf = (quietest: number, cpus: number): Clock => ({
  limit: Math.min(QUIET_REF_MS, QUIET_RATIO * quietest), spike: QUIET_SPIKE * quietest,
  load: Math.max(QUIET_LOAD_FLOOR, QUIET_LOAD_SHARE * cpus),
});
export const isQuiet = (r: Round, c: Clock): boolean =>
  r.before <= c.limit && r.after <= c.limit && r.during.median <= c.limit && r.during.p95 <= c.spike && r.load <= c.load;

/**
 * OHMAIL_BUDGET_MUST_JUDGE=1 marks a host where the budget is always judged: ci.yml's nightly job "suite · search
 * budget · judged" on a hosted runner of its own. There a figure over the budget with no quiet round fails, never skips.
 */
/**
 * Where the budget must be judged, the runner may be slower than the machines the clock is calibrated on (a hosted
 * runner read the reference at 24.4 ms at its quietest, on no load). There a round is quiet against the run's own
 * quietest reference, and each figure is judged as the calibrated machine would read it: scaled by
 * CALIBRATED_REF_MS over the quietest, never up. A runner at or under CALIBRATED_REF_MS is judged as everywhere else.
 * `fixedMs` names each figure's round-trip wait (statements x a timer's ms): it is as long on any machine, so only the
 * rest of the figure is scaled.
 */
export const CALIBRATED_REF_MS = QUIET_REF_MS;
export const judgedClockOf = (quietest: number, cpus: number): Clock =>
  quietest > CALIBRATED_REF_MS ? { ...clockOf(quietest, cpus), limit: QUIET_RATIO * quietest } : clockOf(quietest, cpus);
export const scaleOf = (quietest: number): number => Math.min(1, CALIBRATED_REF_MS / quietest);
export function judgedVerdicts(rounds: Round[], budgetMs: number, quietest: number, cpus: number, fixedMs: Record<string, number> = {}): Record<string, Verdict> {
  const s = scaleOf(quietest);
  const judged = (k: string, v: number): number => {
    const f = Math.min(v, fixedMs[k] ?? 0);
    return Math.round((f + (v - f) * s) * 10) / 10;
  };
  const scaled = rounds.map((r) => ({ ...r, figures: Object.fromEntries(Object.entries(r.figures).map(([k, v]) => [k, judged(k, v)])) }));
  return verdicts(scaled, budgetMs, judgedClockOf(quietest, cpus));
}

export const mustJudge = (env: Record<string, string | undefined> = process.env): boolean => env.OHMAIL_BUDGET_MUST_JUDGE === "1";
export type Outcome = "pass" | "skipped-loaded" | "fail";
/** A verdict's outcome: unjudged is a SKIPPED-LOADED warning, or a failure on a host that must judge. */
export const outcomeOf = (v: Verdict, judgeAlways: boolean): Outcome =>
  v.kind === "within" ? "pass" : v.kind === "unjudged" && !judgeAlways ? "skipped-loaded" : "fail";

/** Each figure's verdict over the rounds it was read in; an over on a quiet round carries the one that read it lowest. */
export function verdicts(rounds: Round[], budgetMs: number, clock: Clock): Record<string, Verdict> {
  const out: Record<string, Verdict> = {};
  for (const k of Object.keys(rounds[0]?.figures ?? {})) {
    const ms = Math.min(...rounds.map((r) => r.figures[k]!));
    const quiet = rounds.filter((r) => isQuiet(r, clock));
    if (ms <= budgetMs) out[k] = { kind: "within", ms };
    else if (quiet.length === 0) out[k] = ms > LOADED_CEILING * budgetMs ? { kind: "over", ms } : { kind: "unjudged", ms };
    else {
      const round = quiet.reduce((b, r) => (r.figures[k]! < b.figures[k]! ? r : b));
      out[k] = { kind: "over", ms: round.figures[k]!, round };
    }
  }
  return out;
}
