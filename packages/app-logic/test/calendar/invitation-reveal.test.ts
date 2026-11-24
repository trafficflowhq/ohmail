import { expect, it } from "vitest";
import { homeTop } from "../../src/calendar/grid/scroller.js";

it("puts an invitation above the open event sheet, even inside the usual grid viewport", () => {
  const positions = { from: 6 * 60, hourPx: 28, viewPx: 500, openTop: 16 * 28 };
  expect(homeTop(positions)).toBe(6 * 28);
  expect(homeTop({ ...positions, revealOpen: true })).toBe(15 * 28);
});
