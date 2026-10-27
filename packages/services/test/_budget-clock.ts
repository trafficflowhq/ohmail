/**
 * THE BUDGET'S CLOCK: which rounds of a timed figure may fail the budget. A round runs between two
 * readings of a fixed CPU-bound reference statement; it is quiet when both read at or under the
 * limit. Load only slows a figure, so any round at or under the budget passes it; a figure over
 * the budget fails only on a quiet round, and with no quiet round it is unjudged, never red, up to
 * LOADED_CEILING times the budget: past that it is over on any clock.
 */
/** The CI runners read the reference at 10.9-12.7 ms quiet; a quietest reading above that is load. */
export const QUIET_REF_MS = 15;
export const QUIET_RATIO = 1.25;
/** Load alone has read a figure at most 163 ms (104-163 on record); a run past twice the budget is the product. */
export const LOADED_CEILING = 2;

export interface Round { before: number; after: number; figures: Record<string, number> }

export type Verdict =
  | { kind: "within"; ms: number }
  | { kind: "over"; ms: number; round?: Round }
  | { kind: "unjudged"; ms: number };

export const quietLimit = (quietest: number): number => Math.min(QUIET_REF_MS, QUIET_RATIO * quietest);
export const isQuiet = (r: Round, limit: number): boolean => r.before <= limit && r.after <= limit;

/** Each figure's verdict over the rounds it was read in; an over on a quiet round carries the one that read it lowest. */
export function verdicts(rounds: Round[], budgetMs: number, limit: number): Record<string, Verdict> {
  const out: Record<string, Verdict> = {};
  for (const k of Object.keys(rounds[0]?.figures ?? {})) {
    const ms = Math.min(...rounds.map((r) => r.figures[k]!));
    const quiet = rounds.filter((r) => isQuiet(r, limit));
    if (ms <= budgetMs) out[k] = { kind: "within", ms };
    else if (quiet.length === 0) out[k] = ms > LOADED_CEILING * budgetMs ? { kind: "over", ms } : { kind: "unjudged", ms };
    else {
      const round = quiet.reduce((b, r) => (r.figures[k]! < b.figures[k]! ? r : b));
      out[k] = { kind: "over", ms: round.figures[k]!, round };
    }
  }
  return out;
}
