/**
 * EACH HISTORY SLOT IS ITS OWN ROW'S HEIGHT. History draws the store's total as slots, so a scroll offset and a year
 * jump are arithmetic over heights, never a measurement of every row. A row that has laid out is drawn at its own
 * height (a constant cut the folder chip; the tallest row seen widened every slot); a row that has not, at the most
 * common height laid out so far. An offset is the sum of the heights drawn above it, kept in two Fenwick trees so it
 * stays a logarithm at a 70 000-row History.
 */

/** A slot before any row has laid out — first paint and the loading placeholders; the first row replaces it. */
export const HISTORY_SLOT_FIRST_PAINT = 84;

export class SlotHeights {
  private readonly measured = new Map<number, number>();
  /** Rows laid out at each height above zero, in the order the heights were first seen. */
  private readonly tally = new Map<number, number>();
  private common: number;
  private sums = new Float64Array(64);
  private counts = new Float64Array(64);

  constructor(first = HISTORY_SLOT_FIRST_PAINT) {
    this.common = first;
  }

  /** Where row `i` is drawn at: its own laid-out height, or the common one until it lays out. */
  heightOf(i: number): number {
    return this.measured.get(i) ?? this.common;
  }

  /** Where row `i`'s slot starts: every row above it at the height it is drawn at. */
  offsetOf(i: number): number {
    const n = Math.max(0, Math.floor(i));
    return (n - this.prefix(this.counts, n)) * this.common + this.prefix(this.sums, n);
  }

  /** The row whose slot holds offset `y`, among `count` rows (a deleted row, drawn at 0, holds none). */
  indexAt(y: number, count: number): number {
    let lo = 0;
    let hi = Math.max(0, count - 1);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.offsetOf(mid) <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Row `i` laid out at `height`. True when a slot moved, so the screen redraws; a read that moved nothing, false. */
  record(i: number, height: number): boolean {
    if (!Number.isInteger(i) || i < 0 || !Number.isFinite(height) || height < 0) return false;
    const h = Math.ceil(height);
    const old = this.measured.get(i);
    if (old === h) return false;
    const drawnBefore = this.heightOf(i);
    const commonBefore = this.common;
    if (i >= this.sums.length) this.grow(i + 1);
    if (old !== undefined) {
      this.add(i, -old, -1);
      this.count(old, -1);
    }
    this.measured.set(i, h);
    this.add(i, h, 1);
    this.count(h, 1);
    return this.heightOf(i) !== drawnBefore || this.common !== commonBefore;
  }

  /** Keep the tally, and the common height as the one the most rows laid out at (the first seen on a tie). */
  private count(h: number, by: number): void {
    if (h === 0) return;
    const n = (this.tally.get(h) ?? 0) + by;
    if (n > 0) this.tally.set(h, n);
    else this.tally.delete(h);
    let best = 0;
    for (const [height, rows] of this.tally) {
      if (rows > best) {
        best = rows;
        this.common = height;
      }
    }
  }

  private add(i: number, height: number, rows: number): void {
    for (let k = i + 1; k <= this.sums.length; k += k & -k) {
      this.sums[k - 1]! += height;
      this.counts[k - 1]! += rows;
    }
  }

  /** The sum over rows `[0, n)` of one tree. */
  private prefix(tree: Float64Array, n: number): number {
    let s = 0;
    for (let k = Math.min(n, tree.length); k > 0; k -= k & -k) s += tree[k - 1]!;
    return s;
  }

  /** Double the trees until row `need - 1` fits, and rebuild them from the rows laid out. */
  private grow(need: number): void {
    let size = this.sums.length;
    while (size < need) size *= 2;
    this.sums = new Float64Array(size);
    this.counts = new Float64Array(size);
    for (const [i, h] of this.measured) {
      for (let k = i + 1; k <= size; k += k & -k) {
        this.sums[k - 1]! += h;
        this.counts[k - 1]! += 1;
      }
    }
  }
}
