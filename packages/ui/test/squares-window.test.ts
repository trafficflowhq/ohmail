import { describe, expect, it } from "vitest";
import { SQUARES_TAPER, squaresWindow } from "../src/squares-window.js";

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
