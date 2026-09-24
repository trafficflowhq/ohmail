/**
 * ONE SEARCH'S TIMINGS AS THE WINDOW MEASURED THEM — the closed record a desktop carries to its
 * engine's log (`window_search_phases`), beside the relay's own line. Spans are whole ms from the
 * question settling in the box; `sentAtMs` and `answeredAtMs` are the window's clock at the send
 * and at the answer, which join the two lines across the bridge (one host, one clock). The record
 * carries no query and no row.
 */
export const SEARCH_PHASE_VERDICTS = ["matched", "nothing", "mirror", "failed"] as const;

export type SearchPhaseVerdict = (typeof SEARCH_PHASE_VERDICTS)[number];

export interface WindowSearchPhases {
  verdict: SearchPhaseVerdict;
  /** The question settling → the debounce firing. */
  debounceMs: number;
  /** The debounce firing → the first page asked of the store. */
  sendMs: number;
  /** The ask → its answer, bridge and relay included. */
  roundTripMs: number;
  /** The answer → the verdict committed on screen. */
  paintMs: number;
  totalMs: number;
  /** The store's own `ms` for the page, when it said one. */
  serverMs: number | null;
  sentAtMs: number;
  answeredAtMs: number;
}
