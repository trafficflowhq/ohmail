/**
 * WHERE ONE SEARCH ANSWER SPENT ITS TIME, phase by phase, for `Server-Timing` and the route's one
 * `search_timing` log line. Only durations and closed values: never the query, an address or a
 * message id, so neither the header nor the log can carry what a person searched for.
 */

/** The phases, in the order a request passes them. */
export const SEARCH_TIMING_PHASES = ["session", "acquire", "flight", "dto", "total"] as const;
export type SearchTimingPhase = (typeof SEARCH_TIMING_PHASES)[number];

/** The closed facts beside the durations. */
export interface SearchTimingFacts {
  part?: "both" | "page" | "summary" | "estimate" | "address";
  tier?: "exact" | "similar";
  cut?: boolean;
  items?: number;
  statements?: number;
}

/** The sink a request hands the service ({@link ServiceContext.timing}); a phase met twice adds up. */
export class SearchTiming {
  private readonly ms = new Map<SearchTimingPhase, number>();
  private readonly facts: SearchTimingFacts = {};

  add(phase: SearchTimingPhase, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.ms.set(phase, (this.ms.get(phase) ?? 0) + ms);
  }

  /** The phase's time so far, 0 when not met. */
  get(phase: SearchTimingPhase): number {
    return this.ms.get(phase) ?? 0;
  }

  note(facts: SearchTimingFacts): void {
    Object.assign(this.facts, facts);
  }

  /** Statements a session sent, added to the count so far. */
  countStatements(n: number): void {
    this.facts.statements = (this.facts.statements ?? 0) + n;
  }

  /** The `Server-Timing` value: each phase met, then the facts as descriptions of a zero-length entry. */
  header(): string {
    const out: string[] = [];
    for (const p of SEARCH_TIMING_PHASES) {
      const v = this.ms.get(p);
      if (v !== undefined) out.push(`${p};dur=${v.toFixed(1)}`);
    }
    const f = this.facts;
    if (f.part !== undefined) out.push(`part;desc=${f.part}`);
    if (f.tier !== undefined) out.push(`tier;desc=${f.tier}`);
    if (f.cut !== undefined) out.push(`cut;desc=${f.cut ? 1 : 0}`);
    if (f.items !== undefined) out.push(`items;desc=${Math.trunc(f.items)}`);
    if (f.statements !== undefined) out.push(`statements;desc=${Math.trunc(f.statements)}`);
    return out.join(", ");
  }

  /** The log line's fields: `<phase>Ms` rounded to a tenth, and the facts as `search<Fact>`. */
  fields(): Record<string, number | string | boolean> {
    const out: Record<string, number | string | boolean> = {};
    for (const p of SEARCH_TIMING_PHASES) {
      const v = this.ms.get(p);
      if (v !== undefined) out[`${p}Ms`] = Math.round(v * 10) / 10;
    }
    for (const [k, v] of Object.entries(this.facts)) {
      if (v !== undefined) out[`search${k[0]!.toUpperCase()}${k.slice(1)}`] = v as number | string | boolean;
    }
    return out;
  }
}
