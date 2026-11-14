import { describe, expect, it } from "vitest";
import {
  admitVerbs,
  foldReadSwitch,
  verbCost,
  BAR_VERB_ORDER,
  BAR_SEGMENTS,
  READ_FOLD_ROOM_PX,
  type BarSeg,
  type BarVerb,
  type MeasuredVerb,
} from "@ohmail/app-logic/lists/bar-density";

/**
 * THE RUNTIME DENSITY'S THREE LAWS (the pill folds on ACTUAL overflow — `bar-density.ts`):
 *
 *  · NO OVERFLOW — the admitted row (base + verbs + their gaps) never exceeds the available
 *    width. Folding early is the benign direction; painting outside the pill is the defect the
 *    whole ladder exists to prevent.
 *  · ROW ORDER IS FOLD ORDER — admission is a strict PREFIX of the present verbs in row order:
 *    a later verb never stands while an earlier one is folded, the same law
 *    `action-bar.test.ts` pins over the stylesheet's rule pairs.
 *  · MAXIMALITY — the room left over cannot seat the next folded verb. This is the law the old
 *    GROUP admission broke and the reason this file's unit is one verb: with the horizons
 *    admitted as a block of three, a row with room for Later and Park folded both along with
 *    Resurface, and 150px of the pill's own room stood empty at 1440 in the widest reading
 *    column the product has. `scripts/fit-render.mjs` holds the same reading in a real browser.
 *
 * A SEGMENT PAYS ITS ROW GAP ONCE — the horizons and filing abut, so a verb continuing the
 * segment its predecessor opened costs its own width and nothing more.
 */

const segOf = (name: BarVerb): BarSeg | null =>
  BAR_VERB_ORDER.find((v) => v.verb === name)!.seg ?? null;
const v = (name: BarVerb, width: number): MeasuredVerb => ({ name, width, seg: segOf(name) });

describe("the read switch's own fold", () => {
  it("in the narrow shell, under 400px of room the switch leaves the row whatever the pointer; nothing else does it on a fine one", () => {
    expect(foldReadSwitch(399, false, false, true)).toBe(true);
    expect(foldReadSwitch(399, true, false, true)).toBe(true);
    expect(foldReadSwitch(400, false, false, true), "400 is the first width that keeps the switch").toBe(false);
    expect(foldReadSwitch(400, false, true, true), "a fine pointer keeps the compact dot + keycap above 400").toBe(false);
    expect(READ_FOLD_ROOM_PX).toBe(400);
  });
  it("the desktop (1024 and up, a fine pointer) never folds, whatever its column's width — as before", () => {
    expect(foldReadSwitch(290, false, true, false), "the fold reached the desktop").toBe(false);
    expect(foldReadSwitch(399, false, false, false)).toBe(false);
  });
  it("under a coarse pointer the fold stands in for the compact concession at any width — a lone dot is no control", () => {
    expect(foldReadSwitch(430, true, true, true)).toBe(true);
    expect(foldReadSwitch(430, true, true, false), "a coarse 1024 (the tablet) keeps the lone dot").toBe(true);
    expect(foldReadSwitch(430, true, false, true), "a coarse pointer with room for the words keeps the switch").toBe(false);
  });
});

describe("BAR_VERB_ORDER", () => {
  it("is the one decided priority order, and every segment's members are contiguous in it", () => {
    expect(BAR_VERB_ORDER.map((x) => x.verb)).toEqual([
      "rall", "later", "aside", "resurface", "tag", "screen", "move",
    ]);
    // Forward is FLOOR, not admissible (DESIGN-026 §2.1): it stands beside Reply and never folds.
    expect(BAR_VERB_ORDER.map((x) => x.verb as string)).not.toContain("fwd");
    /* Contiguity is what makes "a segment's visible members are a prefix of that segment" follow
       from "admission is a prefix of the row". Split a segment's members apart in this list and
       the stylesheet's trailing-cap rules become wrong without anything else going red. */
    for (const { seg } of BAR_SEGMENTS) {
      const at = BAR_VERB_ORDER.map((x, i) => (x.seg === seg ? i : -1)).filter((i) => i >= 0);
      expect(at.length, `${seg} has no members`).toBeGreaterThan(1);
      expect(at, `${seg}'s members are not contiguous in the order`)
        .toEqual(Array.from({ length: at.length }, (_, k) => at[0] + k));
    }
  });

  it("every segment's `first` is its earliest member — the wrapper rules depend on it", () => {
    for (const { seg, first } of BAR_SEGMENTS) {
      expect(BAR_VERB_ORDER.find((x) => x.seg === seg)!.verb, `${seg}`).toBe(first);
    }
  });
});

describe("verbCost", () => {
  it("a verb that stands alone pays the row gap", () => {
    expect(verbCost(v("rall", 90), null, 6)).toBe(96);
    expect(verbCost(v("tag", 40), "defer", 6)).toBe(46);
  });

  it("a verb continuing the segment its predecessor opened pays no gap", () => {
    expect(verbCost(v("aside", 62), "defer", 6)).toBe(62);
    expect(verbCost(v("move", 67), "file", 6)).toBe(67);
  });

  it("a segment's FIRST member pays the gap — nothing has opened it yet", () => {
    expect(verbCost(v("later", 65), null, 6)).toBe(71);
    /* And a member whose predecessor was in the OTHER segment pays it too: `openSeg` is the
       segment actually left open, not "any segment". */
    expect(verbCost(v("screen", 92), "defer", 6)).toBe(98);
  });
});

describe("admitVerbs", () => {
  it("admits everything when everything fits", () => {
    expect(admitVerbs(1000, 200, [v("rall", 90), v("later", 70), v("aside", 60)], 6)).toEqual([
      "rall", "later", "aside",
    ]);
  });

  it("stops at the first verb that does not fit — never skips to a narrower later one", () => {
    // later (200) does not fit, tag (40) would — but standing tag over a folded later breaks the
    // row-order law, so the walk STOPS.
    expect(admitVerbs(500, 200, [v("rall", 90), v("later", 200), v("tag", 40)], 6)).toEqual(["rall"]);
  });

  it("never admits past the available width (the no-overflow law), including the gaps", () => {
    // base 200 + gap 6 + 100 = 306 > 305: the verb must fold.
    expect(admitVerbs(305, 200, [v("rall", 100)], 6)).toEqual([]);
    // …and exactly at the boundary it stands.
    expect(admitVerbs(306, 200, [v("rall", 100)], 6)).toEqual(["rall"]);
  });

  it("a base wider than the row admits nothing and never goes negative", () => {
    expect(admitVerbs(150, 200, [v("rall", 10)], 6)).toEqual([]);
  });

  /**
   * THE OWNER'S CELL, AS ARITHMETIC. The widths are the ones measured in Chromium on the shipped
   * bar at paper/en/1440, reply-all shape: the pill's own room 560, floor 205, Reply all 97,
   * Forward 96 px, Later 65 px, Park 62 px, Resurface 93 px. Forward is floor now, so the base is
   * 205 + 6 + 96 = 307.
   *
   * Group admission seated `rall` and stopped, because the horizons cost 219 as a block, past what the room had:
   * the room partly used and partly standing empty. Per verb it seats Later and Park as well — within the room — and
   * folds Resurface, which genuinely does not fit (543 + 93 = 636).
   */
  it("seats Later and Park in the room group admission left empty (the reported cell)", () => {
    const row = [v("rall", 97), v("later", 65), v("aside", 62), v("resurface", 93)];
    expect(admitVerbs(560, 205 + 6 + 96, row, 6)).toEqual(["rall", "later", "aside"]);
    /* The block cost that folded all three: 6 + 65 + 62 + 93 = 226 against 150 of room. This is
       the arithmetic the granularity change removes, stated so a reader can check it. */
    expect(6 + 65 + 62 + 93).toBeGreaterThan(560 - (205 + 6 + 96 + 6 + 97));
  });

  /**
   * THE SEGMENT CONCESSION, TOLD APART AT THE ROW LEVEL.
   *
   * `verbCost`'s own cases pin the arithmetic, and that was all that told the concession from
   * "always charge the gap": with the gap charged everywhere the property sweep stays green,
   * because it recomputes the row with the same function it is testing. So here is a row where
   * the 6px is exactly what seats the last verb — 200 + (6+65) + 62 = 333 fits in 335, while
   * charging the gap twice needs 339 and folds Park.
   */
  it("the segment's abutting members are what seat Park in a 335px row", () => {
    expect(admitVerbs(335, 200, [v("later", 65), v("aside", 62)], 6)).toEqual(["later", "aside"]);
    expect(admitVerbs(338, 200, [v("later", 65), v("aside", 62)], 6)).toEqual(["later", "aside"]);
  });

  it("property: over random rows — no overflow, strict prefix, and maximality", () => {
    // Deterministic pseudo-random sweep — the three laws over many shapes, not four examples.
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 500; i++) {
      /* A verb is present or not, INDEPENDENTLY — which is the world the bar renders: a 1:1
         message has no Reply all, a stream bar no Tag. The
         segments' members are all present together, as the markup renders them. */
      const drop = new Set<BarVerb>();
      if (rnd() > 0.6) drop.add("rall");
      if (rnd() > 0.8) drop.add("tag");
      const verbs = BAR_VERB_ORDER.filter((x) => !drop.has(x.verb)).map((x) =>
        v(x.verb, 30 + Math.floor(rnd() * 120)),
      );
      const base = 100 + Math.floor(rnd() * 250);
      const avail = 150 + Math.floor(rnd() * 900);
      const gap = 6;
      const admitted = admitVerbs(avail, base, verbs, gap);

      // Strict prefix of the present order.
      expect(admitted).toEqual(verbs.slice(0, admitted.length).map((x) => x.name));

      /* The admitted row's real width, walked with the same segment rule — recomputed here from
         `verbCost` rather than re-summing widths and gaps by hand, so the two do not drift. */
      let width = base;
      let openSeg: BarSeg | null = null;
      for (const name of admitted) {
        const found = verbs.find((x) => x.name === name)!;
        width += verbCost(found, openSeg, gap);
        openSeg = found.seg;
      }
      // No overflow — beyond the base, which always stands (a floor wider than the row is the
      // ladder's own documented unfixable case; no admission may ADD to it).
      expect(width).toBeLessThanOrEqual(Math.max(avail, base));
      if (base > avail) expect(admitted).toEqual([]);

      // MAXIMALITY: if a verb was folded, the FIRST folded one does not fit in what is left.
      const next = verbs[admitted.length];
      if (next) expect(width + verbCost(next, openSeg, gap)).toBeGreaterThan(avail);

      /* AND A SEGMENT'S VISIBLE MEMBERS ARE A PREFIX OF THAT SEGMENT — the property the
         stylesheet's trailing-cap rules rest on. */
      for (const { seg } of BAR_SEGMENTS) {
        const members = verbs.filter((x) => x.seg === seg).map((x) => x.name);
        const seated = members.filter((m) => admitted.includes(m));
        expect(seated).toEqual(members.slice(0, seated.length));
      }
    }
  });
});
