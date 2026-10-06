/**
 * THE PHONE'S OPEN AND SWITCH MARKS — the web's `recordInteraction` shape on the phone's own clock.
 *
 * A press begins a mark (a row's open, a dock destination's switch); the commit effect of the screen that
 * shows the result ends it, so the number is the app's own reading of press-to-committed, beside the device
 * run's coarser uiautomator bound. One pending mark per kind: a second press replaces the first. A mark
 * that ends past MARK_TIMEOUT_MS is counted as a timeout, never as a reading. Numbers only, logged on the
 * minute's `ui_vitals` line (engine-log.ts); nothing here names a message or a sender.
 */
export type MarkKind = "open" | "switch";
export const MARK_TIMEOUT_MS = 30_000;
/** The readings a percentile is taken over: the last hundred, so one slow afternoon does not stand for ever. */
export const RING = 100;

const rings: Record<MarkKind, number[]> = { open: [], switch: [] };
const counts: Record<MarkKind, number> = { open: 0, switch: 0 };
const timeouts: Record<MarkKind, number> = { open: 0, switch: 0 };
const pending: Record<MarkKind, { key: string; at: number } | null> = { open: null, switch: null };

let clock = (): number => (typeof performance === "object" && typeof performance.now === "function" ? performance.now() : Date.now());

export function beginMark(kind: MarkKind, key: string): void {
  pending[kind] = { key, at: clock() };
}

/** Ends the pending mark of `kind` when it is the one for `key`; any other end is not this press's. */
export function endMark(kind: MarkKind, key: string): void {
  const p = pending[kind];
  if (p === null || p.key !== key) return;
  pending[kind] = null;
  const ms = clock() - p.at;
  if (ms > MARK_TIMEOUT_MS) { timeouts[kind] += 1; return; }
  const ring = rings[kind];
  ring.push(Math.round(ms));
  if (ring.length > RING) ring.shift();
  counts[kind] += 1;
}

/** Nearest-rank percentile, `null` over no readings. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

export type UiMarks = {
  openP50Ms: number | null; openP95Ms: number | null; openCount: number; openTimeouts: number;
  switchP50Ms: number | null; switchP95Ms: number | null; switchCount: number; switchTimeouts: number;
};

/** The marks for one report: percentiles over the ring, counts and timeouts since the last take. A minute with no
 *  reading of a kind logs `null` for it, never the previous minute's percentile repeated from the ring. */
export function takeUiMarks(): UiMarks {
  const p = (kind: MarkKind, q: number) => (counts[kind] === 0 ? null : percentile(rings[kind], q));
  const out: UiMarks = {
    openP50Ms: p("open", 50), openP95Ms: p("open", 95), openCount: counts.open, openTimeouts: timeouts.open,
    switchP50Ms: p("switch", 50), switchP95Ms: p("switch", 95), switchCount: counts.switch, switchTimeouts: timeouts.switch,
  };
  counts.open = counts.switch = timeouts.open = timeouts.switch = 0;
  return out;
}

export function resetUiMarksForTest(now?: () => number): void {
  rings.open = []; rings.switch = [];
  counts.open = counts.switch = timeouts.open = timeouts.switch = 0;
  pending.open = pending.switch = null;
  if (now) clock = now;
}
