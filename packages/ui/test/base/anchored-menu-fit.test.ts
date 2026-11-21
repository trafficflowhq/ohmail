import { describe, expect, it } from "vitest";
import { placeMenu } from "../../src/base/Overlays/menu-place.js";

describe("anchored overlay placement", () => {
  const whole = { fit: "whole" } as const;
  const beside = { fit: "beside" } as const;
  const phone = { width: 390, height: 844 };
  const middle = { top: 420, bottom: 444, left: 310, right: 390 };

  it("fits a contact card above a low anchor", () => {
    const anchor = { top: 630, bottom: 654, left: 600, right: 680 };
    const target = placeMenu(anchor, { width: 344, height: 583 }, { width: 1440, height: 900 }, whole);
    expect(target).toMatchObject({ top: 39, up: true });
  });

  it("slides a contact card whole inside the phone's edges when neither side fits", () => {
    const target = placeMenu(middle, { width: 344, height: 583 }, phone, whole);
    expect(target).toMatchObject({ top: 844 - 8 - 583, left: 390 - 8 - 344, up: false });
    expect(target).not.toHaveProperty("maxHeight");
  });

  it("keeps the full viewport band for a contact card taller than the screen", () => {
    const target = placeMenu(middle, { width: 344, height: 900 }, phone, whole);
    expect(target).toMatchObject({ top: 8, maxHeight: 844 - 16 });
  });

  it("gives a row menu one pixel of rounding room below before it flips", () => {
    const anchor = { top: 470, bottom: 510, left: 100, right: 180 };
    const screen = { width: 390, height: 780 };
    const roomBelow = 780 - 8 - (510 + 8);
    expect(placeMenu(anchor, { width: 240, height: roomBelow + 1 }, screen, beside).up).toBe(false);
    expect(placeMenu(anchor, { width: 240, height: roomBelow + 2 }, screen, beside).up).toBe(true);
  });

  it("caps a row menu to the larger side and leaves the trigger reachable", () => {
    const anchor = { top: 380, bottom: 412, left: 100, right: 180 };
    const target = placeMenu(anchor, { width: 240, height: 500 }, { width: 390, height: 780 }, beside);
    expect(target).toMatchObject({ top: 8, up: true, maxHeight: 380 - 16 });
  });
});
