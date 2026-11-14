import { describe, expect, it } from "vitest";
import { foldLineOf, type FoldShape } from "@ohmail/app-logic/touch";

/*
 * WHICH FOLD THE LAYOUT ANSWERS TO: a book's, upright across the window's middle, each side a column's width, the
 * window two columns' wide or the fold half open. The list ends at the fold; a half-open fold keeps a band clear.
 */

const upright = (x: number, w = 0, state: FoldShape["state"] = "flat"): FoldShape => ({
  bounds: { x, w },
  state,
  orientation: "vertical",
  occlusion: "none",
});

describe("a book's fold", () => {
  it("a Book of 750 open flat: the fold at its middle, no band, the list's floor of 260", () => {
    expect(foldLineOf({ width: 750 }, [upright(375)])).toEqual({ at: 375, band: 0, floor: 260 });
  });

  it("an unfolded phone of 719", () => {
    expect(foldLineOf({ width: 719 }, [upright(359.5)])).toEqual({ at: 359.5, band: 0, floor: 260 });
  });

  it("half open keeps the hinge's width and 8 on each side clear", () => {
    expect(foldLineOf({ width: 750 }, [upright(370, 10, "half")])).toEqual({ at: 375, band: 26, floor: 260 });
  });

  it("673 wide is a phone open flat, and two columns with no floor half open", () => {
    expect(foldLineOf({ width: 673 }, [upright(336.5)])).toBeNull();
    expect(foldLineOf({ width: 673 }, [upright(336.5, 0, "half")])).toEqual({
      at: 336.5,
      band: 16,
      floor: 0,
    });
  });

  it("is no book with a side under 300, a fold lying across, a hardware hinge, or no fold", () => {
    expect(foldLineOf({ width: 900 }, [upright(290)])).toBeNull();
    expect(foldLineOf({ width: 900 }, [upright(610)])).toBeNull();
    expect(foldLineOf({ width: 750 }, [{ ...upright(375), orientation: "horizontal" }])).toBeNull();
    expect(foldLineOf({ width: 750 }, [{ ...upright(370, 10), occlusion: "full" }])).toBeNull();
    expect(foldLineOf({ width: 750 }, [])).toBeNull();
  });
});
