import { describe, expect, it } from "vitest";
import { SQUARES_TAPER, WALK_LINE, squaresWindow, threadWalk, type WalkGeometry } from "../src/index.js";

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

/**
 * THE WINDOW over a line of squares longer than its room: whole squares only, the current one at full
 * size in view, "+N" slots counting exactly what each edge hides, the squares nearest a hiding edge
 * tapered (35 / 55 / 75 % from the edge in), and the drawn length within the room.
 */
describe("squaresWindow", () => {
  const slot = (pitch: number, s: number): number => Math.round(pitch * s);
  const drawn = (w: ReturnType<typeof squaresWindow>, n: number, pitch: number, count: number): number =>
    w.scale.reduce((t, s) => t + slot(pitch, s), 0) + (w.from > 0 ? count : 0) + (w.to < n ? count : 0);
  const cases = [
    { n: 40, room: 331, pitch: 20, count: 28 }, // the 400px list's open row
    { n: 40, room: 640, pitch: 24, count: 16 }, // the rail at 900px
    { n: 40, room: 450, pitch: 30, count: 16 }, // the thin rail
    { n: 100, room: 207, pitch: 20, count: 28 }, // a phone's strip
    { n: 9, room: 120, pitch: 20, count: 28 },
  ];
  it("a line that fits draws every square whole and counts nothing", () => {
    expect(squaresWindow({ n: 12, current: 3, room: 240, pitch: 20, count: 28 })).toEqual({ from: 0, to: 12, scale: Array(12).fill(1) });
    expect(squaresWindow({ n: 0, current: -1, room: 100, pitch: 20, count: 28 })).toEqual({ from: 0, to: 0, scale: [] });
  });
  for (const c of cases)
    it(`${c.n} squares at ${c.pitch} in ${c.room}: at every current one, it fits, it is centred, the counts are exact`, () => {
      const seen = new Set<number>();
      for (let cur = 0; cur < c.n; cur++) {
        const w = squaresWindow({ ...c, current: cur });
        expect(drawn(w, c.n, c.pitch, c.count), `current ${cur}: within the room`).toBeLessThanOrEqual(c.room);
        expect(w.scale[cur], `current ${cur} is whole`).toBe(1);
        expect(w.scale.filter((s, i) => s === 0 && i >= w.from && i < w.to), "nothing is hidden inside the run").toEqual([]);
        expect(w.scale.slice(0, w.from).concat(w.scale.slice(w.to)).every((s) => s === 0), "everything outside it is").toBe(true);
        if (w.from === 0) expect(w.scale[0], "the first, never tapered away at the start").toBe(1);
        if (w.to === c.n) expect(w.scale[c.n - 1], "the last, never tapered away at the end").toBe(1);
        const depth = Math.min(3, Math.floor((w.to - w.from - 1) / 2));
        if (w.from > 0) expect(w.scale.slice(w.from, w.from + depth), "the old edge tapers in").toEqual(SQUARES_TAPER.slice(0, depth));
        if (w.to < c.n) expect(w.scale.slice(w.to - depth, w.to).reverse(), "the new edge tapers in").toEqual(SQUARES_TAPER.slice(0, depth));
        seen.add(w.from);
        if (w.from > 0 && w.to < c.n) expect(Math.abs(cur - (w.from + (w.to - w.from - 1) / 2)), "centred on the current one").toBeLessThanOrEqual(1);
      }
      expect(seen.size, "the window walks with the current square").toBeGreaterThan(2);
    });
  it("a line just past its room: the current square whole at every place, the run within the room", () => {
    // the rail at 1440 × 900: 32 squares at 24px in 740px, the ring on the newest (a conversation opens there)
    const opened = squaresWindow({ n: 32, current: 31, room: 740, pitch: 24, count: 16 });
    expect([opened.scale[31], drawn(opened, 32, 24, 16) <= 740], "the newest whole, the run in its room").toEqual([1, true]);
    const wrong: string[] = [];
    for (const [pitch, count] of [[20, 28], [24, 16], [30, 16]] as const)
      for (let room = 200; room <= 900; room += 7)
        for (let n = Math.floor(room / pitch) + 1; n <= Math.floor(room / pitch) + 3; n++)
          for (let cur = 0; cur < n; cur++) {
            const w = squaresWindow({ n, current: cur, room, pitch, count });
            if (w.scale[cur] !== 1 || drawn(w, n, pitch, count) > room) wrong.push(`${pitch}/${count} n=${n} room=${room} current=${cur}`);
          }
    expect(wrong.slice(0, 5), `${wrong.length} cases cut the current square or overflow`).toEqual([]);
  });
  it("the taper: 35, 55 and 75 % from a hiding edge in, nothing at a plain one", () => {
    expect(SQUARES_TAPER).toEqual([0.35, 0.55, 0.75]);
    const mid = squaresWindow({ n: 40, current: 20, room: 331, pitch: 20, count: 28 });
    expect(mid.scale.slice(mid.from, mid.from + 4)).toEqual([0.35, 0.55, 0.75, 1]);
    expect(mid.scale.slice(mid.to - 4, mid.to)).toEqual([1, 0.75, 0.55, 0.35]);
    const start = squaresWindow({ n: 40, current: 0, room: 331, pitch: 20, count: 28 });
    expect([start.from, start.scale.slice(0, 2)], "the start: no old count, no taper there").toEqual([0, [1, 1]]);
    expect(start.to - start.from, "one count less: never fewer squares").toBeGreaterThanOrEqual(mid.to - mid.from);
    const end = squaresWindow({ n: 40, current: 39, room: 331, pitch: 20, count: 28 });
    expect([end.to, end.scale.slice(38)]).toEqual([40, [1, 1]]);
  });
  it("a focus outside the full-size zone pulls the window the least it needs, Home and End to the ends", () => {
    const at = squaresWindow({ n: 40, current: 20, room: 331, pitch: 20, count: 28 });
    const edge = at.from + 1; // a tapered square
    const pulled = squaresWindow({ n: 40, current: 20, room: 331, pitch: 20, count: 28, focus: edge });
    expect(pulled.scale[edge], "the focused square is whole").toBe(1);
    expect(at.from - pulled.from, "pulled by the least").toBe(3 - 1);
    expect(squaresWindow({ n: 40, current: 20, room: 331, pitch: 20, count: 28, focus: 0 }).from).toBe(0);
    expect(squaresWindow({ n: 40, current: 20, room: 331, pitch: 20, count: 28, focus: 39 }).to).toBe(40);
    expect(squaresWindow({ n: 40, current: 20, room: 331, pitch: 20, count: 28, focus: 20 })).toEqual(at);
  });
});
