import { describe, expect, it } from "vitest";
import {
  SWIPE_CLAIM_DX,
  SWIPE_CLAIM_RATIO,
  SWIPE_FIRE_DX,
  SWIPE_MAX_DX,
  swipeClaims,
  swipeOffset,
  swipeVerbFor,
} from "@ohmail/app-logic/touch";

/*
 * THE PHONE'S SWIPE ARITHMETIC, AS IT SHIPPED: the table of cases a list's touch layer is built on. A finger claims a
 * row at 12 across when it moves 1.6 times more across than down, fires at 76, and the row is drawn a third of the
 * way past 76, never past 88.
 */

describe("the claim", () => {
  it.each([
    [11, 0, false],
    [12, 0, true],
    [-12, 0, true],
    [40, 30, false],
    [40, 10, true],
    [0, 60, false],
    [16, 10, true],
    [16, 11, false],
  ])("(%d, %d) claims: %s", (dx, dy, claims) => {
    expect(swipeClaims(dx, dy)).toBe(claims);
  });

  it("keeps the shipped numbers", () => {
    expect([SWIPE_CLAIM_DX, SWIPE_CLAIM_RATIO, SWIPE_FIRE_DX, SWIPE_MAX_DX]).toEqual([12, 1.6, 76, 112]);
  });
});

describe("the verb", () => {
  it.each([
    [75, null],
    [-75, null],
    [76, "read"],
    [-76, "later"],
    [300, "read"],
    [-300, "later"],
  ])("a release at %d presses %s", (dx, verb) => {
    expect(swipeVerbFor(dx)).toBe(verb);
  });
});

describe("the drawn travel", () => {
  it.each([
    [40, 40],
    [76, 76],
    [94, 82],
    [112, 88],
    [4000, 88],
    [-4000, -88],
  ])("a finger at %d draws the row at %d", (dx, drawn) => {
    expect(swipeOffset(dx)).toBeCloseTo(drawn, 10);
  });
});
