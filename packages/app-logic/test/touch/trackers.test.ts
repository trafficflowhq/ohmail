import { describe, expect, it } from "vitest";
import {
  pullClaims,
  pullFires,
  pullOffset,
  swipeDrawn,
  swipeEnd,
  swipeMove,
  swipeStart,
  type SwipeTrack,
} from "@ohmail/app-logic/touch";

/* A finger's run, as the window and the page see it (one zoom: the page's px are the window's). */
function run(
  points: readonly (readonly [number, number])[],
  from: readonly [number, number] = [100, 300],
): SwipeTrack {
  let track = swipeStart(from[0], from[1]);
  for (const [x, y] of points) track = swipeMove(track, from[0] + x, from[1] + y, x);
  return track;
}

describe("a finger on a row", () => {
  it("presses nothing released at 75 across, and its verb at 76", () => {
    expect(
      swipeEnd(
        run([
          [20, 0],
          [75, 0],
        ]),
        false,
      ),
    ).toBeNull();
    expect(
      swipeEnd(
        run([
          [20, 0],
          [76, 0],
        ]),
        false,
      ),
    ).toBe("read");
    expect(
      swipeEnd(
        run([
          [-20, 0],
          [-76, 0],
        ]),
        false,
      ),
    ).toBe("later");
  });

  it("presses nothing when the system takes the finger after the claim", () => {
    const far = run([
      [20, 0],
      [120, 0],
    ]);
    expect(far.claimed).toBe(true);
    expect(swipeEnd(far, true)).toBeNull();
  });

  it("never claims a diagonal run, however far it goes", () => {
    const diagonal = run([
      [5, 8],
      [10, 16],
      [20, 32],
      [40, 64],
    ]);
    expect(diagonal.claimed).toBe(false);
    expect(swipeDrawn(diagonal)).toBe(0);
    expect(swipeEnd(diagonal, false)).toBeNull();
  });

  it("claims a scroll that turns into a clean swipe: the claim is asked at every move", () => {
    const turned = run([
      [0, 10],
      [40, 12],
      [100, 12],
    ]);
    expect(turned.claimed).toBe(true);
    expect(swipeEnd(turned, false)).toBe("read");
  });

  it("draws the row by the phone's travel once claimed, and not before", () => {
    expect(swipeDrawn(run([[8, 0]]))).toBe(0);
    expect(
      swipeDrawn(
        run([
          [20, 0],
          [112, 0],
        ]),
      ),
    ).toBeCloseTo(88, 10);
    expect(
      swipeDrawn(
        run([
          [-20, 0],
          [-40, 0],
        ]),
      ),
    ).toBe(-40);
  });

  it("draws nothing toward a side without a verb, and presses nothing there", () => {
    const right = run([
      [20, 0],
      [100, 0],
    ]);
    expect(swipeDrawn(right, { read: false, later: true })).toBe(0);
    expect(swipeEnd(right, false, { read: false, later: true })).toBeNull();
    expect(swipeEnd(right, false, { read: true, later: false })).toBe("read");
  });
});

describe("a finger at a list's top", () => {
  it("claims down past 12, and only more down than across", () => {
    expect(pullClaims(0, 12)).toBe(false);
    expect(pullClaims(0, 13)).toBe(true);
    expect(pullClaims(20, 18)).toBe(false);
    expect(pullClaims(0, -40)).toBe(false);
  });

  it("follows at 0.55 past the slop, at most 120", () => {
    expect(pullOffset(0)).toBe(0);
    expect(pullOffset(12)).toBe(0);
    expect(pullOffset(112)).toBeCloseTo(55, 10);
    expect(pullOffset(1000)).toBe(120);
  });

  it("pulls from 64 drawn, and not short of it", () => {
    expect(pullFires(0)).toBe(false);
    expect(pullFires(128)).toBe(false);
    expect(pullFires(129)).toBe(true);
    expect(pullFires(150)).toBe(true);
  });
});
