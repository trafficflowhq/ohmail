/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { bridgeShape, bridgeSide, EventBridge, type BridgeInput } from "@ohmail/ui/calendar";

afterEach(cleanup);

/* An event an hour tall and its card ten pixels to its right, both in the column's own frame. */
const EVENT = { left: 100, top: 200, right: 300, bottom: 260 };
const CARD = { left: 310, top: 200, right: 654, bottom: 500 };
const beside: BridgeInput = {
  event: { box: EVENT, radius: 12 },
  card: { box: CARD, radius: 20, headBottom: 300 },
  side: "r",
  line: 1.5,
};
const draw = (input: BridgeInput) =>
  render(<EventBridge {...input} tone={153} width={900} height={700} />).container.querySelector("svg");

describe("where a card stands from its event", () => {
  it("is read from the two boxes: beside, under, over, or on it", () => {
    expect(bridgeSide(EVENT, CARD)).toBe("r");
    expect(bridgeSide(EVENT, { left: -254, top: 200, right: 90, bottom: 500 })).toBe("l");
    expect(bridgeSide(EVENT, { left: 100, top: 270, right: 444, bottom: 600 })).toBe("b");
    expect(bridgeSide(EVENT, { left: 100, top: -110, right: 444, bottom: 190 })).toBe("t");
    expect(bridgeSide(EVENT, { left: 150, top: 220, right: 494, bottom: 520 })).toBe("o");
  });
});

describe("the bridge between an open event and its card", () => {
  it("stands on the stretch the two edges have in common, 32 px tall at most, clear of both corners", () => {
    const shape = bridgeShape(beside);
    expect(shape).not.toBeNull();
    /* The card's corner is the rounder one: the bridge attaches from 55° of it on. */
    expect(shape!.top).toBeCloseTo(208.5, 0);
    expect(shape!.bottom - shape!.top).toBeCloseTo(32, 5);
    expect(shape!.middle.y).toBeCloseTo(224.5, 0);
    /* The card grows from its own edge there, a little in from the corner's round. */
    expect(shape!.middle.x).toBeGreaterThan(309);
    expect(shape!.middle.x).toBeLessThan(314);
  });

  it("draws the shape the design draws for the same two boxes and a mark in the gap", () => {
    /* A week's event two hours tall, its card ten pixels beside it, and a mark of mail at the card's corner. */
    const shape = bridgeShape({
      event: { box: { left: 371.703125, top: 193, right: 506.5625, bottom: 395 }, radius: 12 },
      card: {
        box: { left: 516.5625, top: 193, right: 860.5625, bottom: 401.40625 },
        radius: 20,
        headBottom: 289.78125,
      },
      side: "r",
      line: 1.5,
      marks: [
        { left: 347.703125, top: 234, right: 367.703125, bottom: 254 },
        { left: 506.5625, top: 183, right: 526.5625, bottom: 203 },
      ],
    })!;
    expect(shape.liquid.fill).toBe(
      "M505.81 205 C505.81 217.8 512.48 216.81 517.42 205 A20.75 20.75 0 0 0 515.81 213 L515.81 237C515.81 224.2 505.81 224.2 505.81 237 L505.81 205 Z",
    );
    expect(shape.liquid.sides).toEqual([
      "M505.81 205 C505.81 217.8 512.48 216.81 517.42 205",
      "M515.81 237 C515.81 224.2 505.81 224.2 505.81 237",
    ]);
    expect(shape.ends).toEqual([
      "M505.81 205 L505.81 237",
      "M517.42 205 A20.75 20.75 0 0 0 515.81 213 L515.81 237",
    ]);
    expect(shape.endWidth).toBe(3.5);
    expect([shape.from, shape.to]).toEqual([505.81, 517.42]);
    expect(shape.root.y).toBe(221);
    expect(shape.meets).toBe("head");
  });

  it("is a drawing, hidden from a screen reader, and never takes a press", () => {
    const svg = draw(beside);
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
    expect(svg!.querySelectorAll("button, a, [tabindex]")).toHaveLength(0);
  });

  it("draws its two sides with a waist, and straight for the face that keeps them straight", () => {
    const shape = bridgeShape(beside)!;
    /* A side that dips has its two control points off the line between its ends; a straight one has them on it. */
    const points = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    const [, y0, , c1y, , c2y] = points(shape.liquid.sides[0]);
    expect(c1y!).toBeGreaterThan(y0! + 5);
    expect(c2y!).toBeGreaterThan(y0! + 5);
    const [, s0, , s1, , s2] = points(shape.straight.sides[0]);
    expect(s1).toBe(s0);
    expect(s2).toBe(s0);
  });

  it("lets go whole across a gap wider than 40 px", () => {
    const far = { ...beside, card: { ...beside.card, box: { ...CARD, left: 345, right: 689 } } };
    expect(bridgeShape(far)).toBeNull();
    expect(draw(far)).toBeNull();
  });

  it("lets go where the two edges have less than 10 px in common", () => {
    const low = { ...beside, card: { ...beside.card, box: { ...CARD, top: 252, bottom: 552 } } };
    expect(bridgeShape(low)).toBeNull();
  });

  it("is not drawn for a card that stands on its event", () => {
    expect(bridgeShape({ ...beside, side: "o" })).toBeNull();
  });

  it("shrinks with the event's edge while the scroll cuts the event, and goes before it would be a stub", () => {
    const cut = (top: number) =>
      bridgeShape({ ...beside, event: { box: { ...EVENT, top }, radius: 12, whole: EVENT } });
    const half = cut(236)!;
    expect(half.bottom - half.top).toBeLessThan(32);
    expect(half.bottom - half.top).toBeGreaterThanOrEqual(10);
    /* The cut end is no corner: the bridge may stand right at it. */
    expect(half.top).toBeCloseTo(236, 5);
    expect(cut(252)).toBeNull();
  });

  it("keeps clear of a mark of mail that stands in the gap", () => {
    const mark = { left: 296, top: 204, right: 312, bottom: 220 };
    const shape = bridgeShape({ ...beside, marks: [mark] })!;
    expect(shape.top).toBeGreaterThanOrEqual(mark.bottom + 2);
    /* A mark in another day's column is nothing to it. */
    const away = bridgeShape({ ...beside, marks: [{ left: 500, top: 204, right: 516, bottom: 220 }] })!;
    expect(away.top).toBeCloseTo(bridgeShape(beside)!.top, 5);
  });

  it("is not drawn across a hinge between two screens", () => {
    expect(bridgeShape({ ...beside, hinge: { axis: "v", at: 305, width: 0 } })).toBeNull();
    expect(bridgeShape({ ...beside, hinge: { axis: "v", at: 700, width: 0 } })).not.toBeNull();
  });

  it("fades into the sheet where it meets the card under its head, and stays flat against the head", () => {
    expect(bridgeShape(beside)!.meets).toBe("head");
    const tall = { ...beside, card: { ...beside.card, headBottom: 215 } };
    expect(bridgeShape(tall)!.meets).toBe("body");
  });

  it("under or over its event it is the same shape, turned", () => {
    const under: BridgeInput = {
      event: { box: EVENT, radius: 12 },
      card: { box: { left: 100, top: 270, right: 444, bottom: 600 }, radius: 20, headBottom: 370 },
      side: "b",
      line: 1.5,
    };
    const shape = bridgeShape(under)!;
    expect(shape.turned).toBe(true);
    /* It stands in the gap between the event's foot and the card's top. */
    expect(shape.middle.y).toBeGreaterThan(269);
    expect(shape.middle.y).toBeLessThan(274);
    expect(shape.middle.x).toBeGreaterThan(EVENT.left);
    expect(shape.middle.x).toBeLessThan(EVENT.right);
    expect(draw(under)).not.toBeNull();
  });
});
