/**
 * THE WINDOW OVER A LINE OF SQUARES (the open row's strip, the reader's rail; owner 2026-10-26): when
 * `n` squares at `pitch` do not fit `room`, a run of them stands in it and nothing scrolls. The current
 * square is in its middle, whole; at the ends the run rests against the first or the last. Each edge
 * that hides squares holds a `count`-long slot for its "+N" (the hidden ones, exactly), and the squares
 * nearest it taper (`SQUARES_TAPER`, outermost first) — so a step of the reader reads as the squares
 * flowing past. A keyboard focus outside the run's whole zone pulls the run the least it needs.
 * Hosts draw square i in a slot `Math.round(pitch × scale[i])` long; 0 is no slot at all.
 */

/** The tapered squares' scale at an edge that hides more, from the edge in. */
export const SQUARES_TAPER: readonly number[] = [0.35, 0.55, 0.75];

export interface SquaresWindow {
  /** The run: squares `from` to `to` (exclusive) stand; `from` hide before it, `n - to` after. */
  from: number;
  to: number;
  /** Each square's scale: 1 whole, a taper step, 0 outside the run. */
  scale: number[];
}

/** How deep the taper reaches in a run of `k`: never to its middle square. */
const depthOf = (k: number): number => Math.max(0, Math.min(SQUARES_TAPER.length, Math.floor((k - 1) / 2)));

export function squaresWindow(o: { n: number; current: number; room: number; pitch: number; count: number; focus?: number }): SquaresWindow {
  const { n, room, pitch, count } = o;
  if (n <= 0 || !(pitch > 0) || n * pitch <= room + 0.01) return { from: 0, to: Math.max(0, n), scale: Array<number>(Math.max(0, n)).fill(1) };
  const taperLen = (k: number): number => {
    let s = 0;
    for (let i = 0; i < depthOf(k); i++) s += Math.round(pitch * SQUARES_TAPER[i]!);
    return s;
  };
  // the longest run that fits with `ends` counted (and tapered) edges
  const fit = (ends: number): number => {
    let k = Math.min(n, Math.ceil(room / pitch) + 2 * SQUARES_TAPER.length);
    const len = (k: number): number => (k - ends * depthOf(k)) * pitch + ends * (taperLen(k) + count);
    while (k > 1 && len(k) > room + 0.01) k--;
    return k;
  };
  // every counted edge hides at least one square (its taper's saving was spent on that), and a middle
  // run is never longer than an end run, or the clamp at an end could leave the current one out
  const K1 = Math.min(fit(1), n - 1);
  const K2 = Math.max(1, Math.min(fit(2), K1, n - 2));
  let a = 0;
  let b = n;
  const place = (want: number): void => {
    a = Math.max(0, Math.min(n - K2, want));
    if (a <= 0) { a = 0; b = Math.min(n, K1); }
    else if (a + K2 >= n) { a = Math.max(0, n - K1); b = n; }
    else b = a + K2;
  };
  const cur = o.current >= 0 && o.current < n ? o.current : n - 1;
  place(cur - Math.floor(K2 / 2));
  const f = o.focus ?? -1;
  if (f >= 0 && f < n) {
    const t = depthOf(b - a);
    const z0 = a + (a > 0 ? t : 0);
    const z1 = b - (b < n ? t : 0);
    if (f < z0) place(a - (z0 - f));
    else if (f >= z1) place(a + (f - z1 + 1));
  }
  const t = depthOf(b - a);
  const scale = Array<number>(n).fill(0);
  for (let i = a; i < b; i++) {
    let s = 1;
    if (a > 0 && i - a < t) s = SQUARES_TAPER[i - a]!;
    if (b < n && b - 1 - i < t) s = Math.min(s, SQUARES_TAPER[b - 1 - i]!);
    scale[i] = s;
  }
  return { from: a, to: b, scale };
}
