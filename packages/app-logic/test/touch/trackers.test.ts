import { describe, expect, it } from "vitest";
import {
  pullClaims,
  pullEnd,
  pullFires,
  pullMove,
  pullOffset,
  pullStart,
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
    ).toBe("right");
    expect(
      swipeEnd(
        run([
          [-20, 0],
          [-76, 0],
        ]),
        false,
      ),
    ).toBe("left");
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
    expect(swipeEnd(turned, false)).toBe("right");
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
    expect(swipeDrawn(right, { right: false, left: true })).toBe(0);
    expect(swipeEnd(right, false, { right: false, left: true })).toBeNull();
    expect(swipeEnd(right, false, { right: true, left: false })).toBe("right");
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

  it("leaves scrolling alone when the finger starts below the top or the list scrolls first", () => {
    expect(pullMove(pullStart(100, 300, false), 100, 450, true)).toBeNull();
    const start = pullStart(100, 300, true);
    const scrolled = pullMove(start, 100, 305, false);
    expect(pullMove(scrolled, 100, 450, true)).toBeNull();
    expect(pullEnd(scrolled, false, false).run).toBe(false);
  });

  it("holds still through the slop then follows a downward pull with resistance", () => {
    const start = pullStart(100, 300, true);
    const diagonal = pullMove(start, 112, 312, true);
    expect(diagonal).toMatchObject({ claimed: false, offset: 0 });
    const downward = pullMove(diagonal, 104, 412, true);
    expect(downward).toMatchObject({ claimed: true });
    expect(downward?.offset).toBeCloseTo(55);
    expect(pullMove(downward, 104, 800, true)?.offset).toBe(120);
  });

  it("gives upward and sideways drags to scrolling and row swipes", () => {
    const start = pullStart(100, 300, true);
    for (const [x, y] of [
      [100, 287],
      [113, 312],
      [87, 312],
    ] as const) {
      const yielded = pullMove(start, x, y, true);
      expect(yielded).toBeNull();
      expect(pullMove(yielded, 100, 450, true)).toBeNull();
    }
  });

  it("judges the release at its final position and drops a cancelled pull", () => {
    const armed = pullMove(pullStart(100, 300, true), 100, 450, true);
    const retreated = pullMove(armed, 100, 428, true);
    expect(pullEnd(retreated, false, false)).toEqual({ claimed: true, hold: false, run: false });
    const reversed = pullMove(armed, 100, 280, true);
    expect(reversed).toMatchObject({ claimed: true, offset: 0 });
    expect(pullEnd(reversed, false, false).run).toBe(false);
    expect(pullEnd(armed, true, false)).toEqual({ claimed: true, hold: false, run: false });
    expect(pullEnd(null, false, false)).toEqual({ claimed: false, hold: false, run: false });
  });

  it("keeps the waiting mark for a pending request without starting a second one", () => {
    const armed = pullMove(pullStart(100, 300, true), 100, 429, true);
    expect(pullEnd(armed, false, false)).toEqual({ claimed: true, hold: true, run: true });
    expect(pullEnd(armed, false, true)).toEqual({ claimed: true, hold: true, run: false });
  });
});
