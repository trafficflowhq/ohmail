import { describe, expect, it } from "vitest";
import {
  STREAM_REST_MS,
  createStreamReadRule,
  type StreamItemBox,
  type StreamLook,
} from "../../src/streams/read-rule.js";

/** Ten items of 300 px each in a 600 px window: the stream is 3,000 px tall. */
const ITEMS: StreamItemBox[] = Array.from({ length: 10 }, (_, i) => ({
  id: `i${i}`,
  top: i * 300,
  height: 300,
  unread: true,
  ready: true,
}));
const look = (scrollTop: number, at: number, items: readonly StreamItemBox[] = ITEMS): StreamLook => ({
  scrollTop,
  viewHeight: 600,
  scrollHeight:
    items.length === 0 ? 600 : Math.max(600, items[items.length - 1]!.top + items[items.length - 1]!.height),
  items,
  at,
});

describe("a stream's read rule (News and Receipts)", () => {
  it("rests at 0.6 s", () => {
    expect(STREAM_REST_MS).toBe(600);
  });

  it("rests on the chosen visible result until the person moves the stream", () => {
    const rule = createStreamReadRule();
    rule.enter(0, "i8");
    expect(rule.rest(look(2400, 600), "i9")).toEqual(["i8"]);
    expect(rule.rest(look(2400, 1200), "i9")).toEqual([]);
    rule.hand("wheel", 1400);
    expect(rule.rest(look(2400, 2000), "i9")).toEqual(["i9"]);
  });

  it("reads nothing before a hand has moved the stream: not on opening, not on a landing, not at rest", () => {
    const rule = createStreamReadRule();
    expect(rule.look(look(0, 0), true, false)).toEqual([]);
    expect(rule.look(look(900, 100), true, false)).toEqual([]);
    expect(rule.rest(look(900, 800), "i3")).toEqual([]);
    expect(rule.driven).toBe(false);
    // What stood in view was seen, and is read once a hand carries it past.
    expect(rule.shown("i3")).toBe(true);
  });

  it("reads what a hand carries past going down at once, and nothing that is still below the reading line", () => {
    const rule = createStreamReadRule();
    rule.look(look(0, 0), true, false);
    rule.hand("wheel", 1000);
    // i0 (0-300) has its foot at 300; the top is now 250, the line at 340: carried past.
    expect(rule.look(look(250, 1010), true, false)).toEqual(["i0"]);
    // i1 (300-600): foot 600 is below 430+90? 600 > 520: not yet.
    expect(rule.look(look(430, 1020), true, false)).toEqual([]);
    expect(rule.look(look(520, 1030), true, false)).toEqual(["i1"]);
  });

  it("reads going up only what has come down to the foot, never an item that only begins to show at the top", () => {
    const rule = createStreamReadRule();
    rule.look(look(1800, 0), true, false);
    rule.hand("wheel", 1000);
    // The window is 1500-2100: i7 (seen at 2100) has gone below the foot and is read; i5 begins at the top and is not.
    expect(rule.look(look(1500, 1010), true, false)).toEqual(["i7"]);
    // Up to 1200: the foot is 1800, the line 1710: i6 (start 1800) has come down past it; i5 has not.
    expect(rule.look(look(1200, 1020), true, false)).toEqual(["i6"]);
  });

  it("reads every shown item at the end the stream is going to, both ends", () => {
    const down = createStreamReadRule();
    down.look(look(2100, 0), true, false);
    down.hand("wheel", 1000);
    // The foot: 2400 is the last screen. i8 and i9 stand in view and are read there.
    expect(down.look(look(2400, 1010), true, false)).toEqual(["i7", "i8", "i9"]);

    const up = createStreamReadRule();
    up.look(look(300, 0), true, false);
    up.hand("wheel", 1000);
    expect(up.look(look(0, 1010), true, false)).toEqual(["i0", "i1", "i2"]);
  });

  it("reads the item the stream rests on after the rest, once driven, and only where it was shown", () => {
    const rule = createStreamReadRule();
    rule.look(look(0, 0), true, false);
    rule.hand("wheel", 1000);
    rule.look(look(60, 1010), true, false);
    expect(rule.rest(look(60, 1610), "i1")).toEqual(["i1"]);
    // Never twice, and never an item that stood nowhere in view.
    expect(rule.rest(look(60, 2210), "i1")).toEqual([]);
    expect(rule.rest(look(60, 2210), "i9")).toEqual([]);
  });

  it("takes j and k as no hand: what they pass stays unread and only what they rest on is read", () => {
    const rule = createStreamReadRule();
    rule.look(look(0, 0), true, false);
    // j, j, j: three landings, each a scroll the press made.
    rule.enter(1000);
    expect(rule.look(look(300, 1010), true, false)).toEqual([]);
    rule.enter(1100);
    expect(rule.look(look(600, 1110), true, false)).toEqual([]);
    rule.enter(1200);
    expect(rule.look(look(900, 1210), true, false)).toEqual([]);
    expect(rule.driven).toBe(true);
    expect(rule.rest(look(900, 1810), "i3")).toEqual(["i3"]);
  });

  it("forgets a wheel once a press has moved the stream after it", () => {
    const rule = createStreamReadRule();
    rule.look(look(0, 0), true, false);
    rule.hand("wheel", 1000);
    rule.enter(1100);
    expect(rule.look(look(900, 1120), true, false)).toEqual([]);
  });

  it("keeps an item marked unread through every later scroll and rest", () => {
    const rule = createStreamReadRule();
    rule.look(look(0, 0), true, false);
    rule.keepUnread("i0");
    rule.hand("wheel", 1000);
    expect(rule.look(look(400, 1010), true, false)).toEqual([]);
    expect(rule.rest(look(400, 1610), "i0")).toEqual([]);
    expect(rule.read("i0")).toBe(false);
  });

  it("reads nothing a flight carried past without its being seen (End, a far jump)", () => {
    const rule = createStreamReadRule();
    rule.look(look(0, 0), true, false);
    rule.hand("key", 1000);
    // The key flight never earns a hand-scroll write. Its final viewport can earn the rest.
    expect(rule.look(look(2400, 1010), true, true)).toEqual([]);
    expect(rule.shown("i4")).toBe(false);
    expect(rule.shown("i8")).toBe(false);
    expect(rule.rest(look(2400, 1610), "i9")).toEqual(["i9"]);
    expect(rule.shown("i8")).toBe(true);
  });

  it("reads nothing a wheel step inside a flight carries past whose first lines stood in view only during the flight", () => {
    const rule = createStreamReadRule();
    rule.look(look(0, 0), true, false);
    // End: the stream is driven, and its flight crosses i3 and i4 on an animated frame.
    rule.enter(1000);
    expect(rule.look(look(900, 1010), true, true)).toEqual([]);
    expect(rule.shown("i3")).toBe(false);
    expect(rule.shown("i4")).toBe(false);
    // A wheel step while the flight still stands carries them past the line: they were never seen at rest.
    rule.hand("wheel", 1020);
    const read = rule.look(look(1500, 1030), true, true);
    expect(read).not.toContain("i3");
    expect(read).not.toContain("i4");
    expect(rule.shown("i5")).toBe(false);
  });

  it("reads nothing in a hidden tab", () => {
    const rule = createStreamReadRule();
    rule.look(look(0, 0), true, false);
    rule.hand("wheel", 1000);
    expect(rule.look(look(400, 1010), false, false)).toEqual([]);
    expect(rule.shown("i2")).toBe(false);
  });

  it("never reads live an item whose body is not in", () => {
    const items = ITEMS.map((i) => (i.id === "i0" ? { ...i, ready: false } : i));
    const rule = createStreamReadRule();
    rule.look(look(0, 0, items), true, false);
    rule.hand("wheel", 1000);
    expect(rule.look(look(400, 1010, items), true, false)).toEqual([]);
    expect(rule.shown("i0")).toBe(true);
    // The leave flips it all the same: the rule read it.
    expect(rule.read("i0")).toBe(true);
    expect(rule.read("i5")).toBe(false);
  });

  it("lets a finger's momentum count while it is down and a while after", () => {
    const rule = createStreamReadRule();
    rule.look(look(0, 0), true, false);
    rule.hand("touch", 1000, true);
    expect(rule.look(look(400, 5000), true, false)).toEqual(["i0"]);
    rule.hand("touch", 5000, false);
    expect(rule.look(look(700, 6000), true, false)).toEqual(["i1"]);
    // Past the momentum's time a scroll is no longer the hand's.
    expect(rule.look(look(1000, 7000), true, false)).toEqual([]);
  });

  it("lets a wheel's hand lapse: a later scroll it did not make reads nothing", () => {
    const rule = createStreamReadRule();
    rule.look(look(0, 0), true, false);
    rule.hand("wheel", 1000);
    expect(rule.look(look(400, 1500), true, false)).toEqual([]);
  });

  it("reads a stream that fits whole on a hand that tries to carry it on, and nothing where it overflows", () => {
    const two = ITEMS.slice(0, 2);
    const rule = createStreamReadRule();
    rule.look(look(0, 0, two), true, false);
    expect(rule.rest(look(0, 700, two), "i0")).toEqual([]);
    expect(rule.still(look(0, 1000, two), "wheel")).toEqual(["i0", "i1"]);
    expect(rule.driven).toBe(true);

    const kept = createStreamReadRule();
    kept.keepUnread("i1");
    expect(kept.still(look(0, 1000, two), "key")).toEqual(["i0"]);

    const long = createStreamReadRule();
    expect(long.still(look(0, 1000), "wheel")).toEqual([]);
  });

  it("lets the leave answer to a hand alone: a wheel, a moving finger or a scroll key, never a press, j, k, a finger's tap or the app's move", () => {
    const pressed = createStreamReadRule();
    pressed.enter(1000);
    pressed.appMoved(1100);
    expect([pressed.driven, pressed.handDrove]).toEqual([true, false]);
    const tapped = createStreamReadRule();
    tapped.touchDown(1000);
    tapped.touchUp(1100);
    expect([tapped.driven, tapped.handDrove]).toEqual([true, false]);
    for (const drive of [
      (r: ReturnType<typeof createStreamReadRule>) => r.hand("wheel", 1000),
      (r: ReturnType<typeof createStreamReadRule>) => r.hand("touch", 1000, true),
      (r: ReturnType<typeof createStreamReadRule>) => r.scrollKey(1000),
    ]) {
      const rule = createStreamReadRule();
      drive(rule);
      expect([rule.driven, rule.handDrove]).toEqual([true, true]);
    }
  });
});
