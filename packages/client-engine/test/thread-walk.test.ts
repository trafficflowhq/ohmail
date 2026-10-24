import { describe, expect, it } from "vitest";
import { WALK_LINE, threadWalk, type WalkGeometry } from "../src/index.js";

/**
 * THE WALK: which square is current while the reader scrolls a thread, and where a press lands.
 * The geometries are the o9 demo's measured threads (the tops are its presses' scroll + top on the
 * line): LONG, 14 messages over 2880px of scroll, and SHORT, 7 messages over 577px.
 */
const LONG: WalkGeometry = {
  tops: [10, 455.4, 636.1, 926.6, 1207.2, 1410.3, 1823.3, 2003.9, 2307, 2487.7, 2768.2, 2993.8, 3351.8, 3532.5],
  max: 2880,
  view: 978,
  opened: 13,
};
const SHORT: WalkGeometry = { tops: [10, 290.6, 516.2, 741.8, 945, 1125.7, 1406.2], max: 577, view: 978, opened: 6 };

function sweep(g: WalkGeometry, step: number, up: boolean): number[] {
  const w = threadWalk(g);
  const out: number[] = [];
  for (let s = 0; s <= g.max; s += step) out.push(w.current(up ? g.max - s : s));
  out.push(w.current(up ? 0 : g.max));
  return out;
}

describe("threadWalk", () => {
  it("stands its reading line 30 % down the view", () => {
    expect(WALK_LINE).toBe(0.3);
    expect(threadWalk(LONG).lineAt(100)).toBeCloseTo(0.3 * 978, 6);
  });

  for (const [name, g] of [["14 messages", LONG], ["14 messages at the full view", { ...LONG, view: 1044 }], ["7 messages", SHORT]] as const) {
    it(`${name}: walks down in 40px steps first to last, never back, every message on the way`, () => {
      const seq = sweep(g, 40, false);
      expect(seq[0]).toBe(0);
      expect(seq[seq.length - 1]).toBe(g.tops.length - 1);
      for (let k = 1; k < seq.length; k++) expect(seq[k]).toBeGreaterThanOrEqual(seq[k - 1]);
      expect(new Set(seq).size).toBe(g.tops.length);
    });

    it(`${name}: walks up in 40px steps last to first, never forward`, () => {
      const seq = sweep(g, 40, true);
      expect(seq[0]).toBe(g.tops.length - 1);
      expect(seq[seq.length - 1]).toBe(0);
      for (let k = 1; k < seq.length; k++) expect(seq[k]).toBeLessThanOrEqual(seq[k - 1]);
    });

    it(`${name}: a 1px sweep never steps back`, () => {
      const w = threadWalk(g);
      let prev = w.current(0);
      for (let s = 1; s <= g.max; s++) {
        const c = w.current(s);
        expect(c).toBeGreaterThanOrEqual(prev);
        prev = c;
      }
    });

    it(`${name}: a press puts that top on the line, and the walk answers it`, () => {
      const w = threadWalk(g);
      for (let k = 1; k < g.tops.length - 1; k++) {
        const s = w.scrollFor(k);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(g.max);
        expect(w.current(s)).toBe(k);
        if (s > 0 && s < g.max) expect(s + w.lineAt(s)).toBeGreaterThanOrEqual(g.tops[k] - 0.5);
      }
      expect(w.scrollFor(0)).toBe(0);
      expect(w.scrollFor(g.tops.length - 1)).toBe(g.max);
    });
  }

  it("lands a press where the demo measured it", () => {
    const w = threadWalk(LONG);
    expect([1, 2, 3, 6].map((k) => w.scrollFor(k))).toEqual([162, 343, 634, 1530]);
  });

  it("at scroll top only the first is current, even when the first message is short", () => {
    const g: WalkGeometry = { tops: [0, 60, 140, 900, 1300], max: 1200, view: 800, opened: 4 };
    const w = threadWalk(g);
    expect(w.current(0)).toBe(0);
    expect(w.lineAt(0)).toBe(59);
    // the line rises to 30 % over the first screenful
    expect(w.lineAt(800)).toBeCloseTo(240, 6);
    expect(w.current(1)).toBe(1);
  });

  it("at the very bottom the last is current, a one-line last message too", () => {
    // the last top is 20px above the content's end: it can never reach a 30 % line by scrolling
    const g: WalkGeometry = { tops: [0, 700, 1400, 2100, 2180], max: 1400, view: 800, opened: 4 };
    const w = threadWalk(g);
    expect(w.current(1400)).toBe(4);
    expect(w.lineAt(1400)).toBeCloseTo(780, 6);
    expect(w.current(1398.9)).toBeLessThan(4);
    expect(w.current(1360)).toBe(3);
  });

  it("a scroll stopped a fraction short of the end still rings the last (zoomed text)", () => {
    // a short last message makes the line run fast near the end; under CSS zoom a scroll to the end
    // stops up to a pixel short of max
    const g: WalkGeometry = { tops: [16, 600, 1400, 2200, 2900], max: 2184, view: 800, opened: 4 };
    const w = threadWalk(g);
    for (const s of [2184, 2183.6, 2183.5, 2183.33, 2183.1]) expect(w.current(s)).toBe(4);
    expect(w.current(2180)).toBe(3);
    // a fraction past the top is still the start
    expect(w.current(0.4)).toBe(0);
  });

  it("clamps a scroll past either end", () => {
    const w = threadWalk(LONG);
    expect(w.current(-50)).toBe(0);
    expect(w.current(LONG.max + 50)).toBe(13);
  });

  it("a thread that fits its view rings the opened message", () => {
    const g: WalkGeometry = { tops: [0, 200, 400], max: 0, view: 900, opened: 1 };
    const w = threadWalk(g);
    expect(w.current(0)).toBe(1);
    expect(w.scrollFor(2)).toBe(0);
    expect(threadWalk({ ...g, opened: 0 }).current(0)).toBe(0);
  });

  it("a press pins its square current whatever the scroll says", () => {
    const w = threadWalk(LONG);
    expect(w.current(0, { index: 7 })).toBe(7);
    expect(w.current(LONG.max, { index: 2 })).toBe(2);
    expect(w.current(0, null)).toBe(0);
  });

  it("answers nothing when there is no view or no message", () => {
    expect(threadWalk({ ...LONG, view: 0 }).current(100)).toBe(-1);
    expect(threadWalk({ ...LONG, view: -4 }).current(100)).toBe(-1);
    expect(threadWalk({ tops: [], max: 0, view: 900, opened: 0 }).current(0)).toBe(-1);
  });

  it("a panel not laid out yet (top 0) never reorders the walk", () => {
    const g: WalkGeometry = { ...LONG, tops: LONG.tops.map((t, k) => (k === 5 ? 0 : t)) };
    const w = threadWalk(g);
    let prev = w.current(0);
    expect(prev).toBe(0);
    for (let s = 1; s <= g.max; s++) {
      const c = w.current(s);
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
    expect(prev).toBe(13);
    // a press on it lands no higher than on the message before it
    expect(w.scrollFor(5)).toBeGreaterThanOrEqual(w.scrollFor(4));
  });
});
