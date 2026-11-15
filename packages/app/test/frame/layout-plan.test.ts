import { describe, expect, it } from "vitest";
import type { WindowFacts } from "../../src/frame/contract.js";
import { layoutPlan } from "../../src/frame/layout-plan.js";
import { attributesOf } from "../../src/frame/root-attributes.js";

const at = (width: number, pointer: WindowFacts["pointer"], height = 800): WindowFacts => ({
  width,
  height,
  pointer,
  posture: "flat",
  reducedMotion: false,
});

describe("one layout from the size class", () => {
  it("a phone's width is one column with the dock at its foot", () => {
    expect(layoutPlan(at(390, "coarse"))).toEqual({
      size: "compact",
      short: false,
      pointer: "coarse",
      device: "phone",
      pose: null,
      rail: "dock",
      columns: 1,
      handles: false,
    });
  });

  it("an unfolded phone upright is two columns beside a rail of icons", () => {
    expect(layoutPlan(at(719, "coarse"))).toEqual({
      size: "medium",
      short: false,
      pointer: "coarse",
      device: "fold",
      pose: null,
      rail: "icons",
      columns: 2,
      handles: false,
    });
  });

  it("an unfolded phone on its side is two columns beside the same rail of icons, posed on its side", () => {
    expect(layoutPlan(at(841, "coarse"))).toEqual({
      size: "expanded",
      short: false,
      pointer: "coarse",
      device: "fold",
      pose: "land",
      rail: "icons",
      columns: 2,
      handles: false,
    });
  });

  it("a desktop window is the rail, two columns and the handles", () => {
    expect(layoutPlan(at(1440, "fine"))).toEqual({
      size: "expanded",
      short: false,
      pointer: "fine",
      device: "desktop",
      pose: null,
      rail: "words",
      columns: 2,
      handles: true,
    });
  });

  it("an unfolded phone narrower than 700, the open Duo at 669, is one column with the dock at its foot", () => {
    expect(layoutPlan(at(669, "coarse", 951))).toEqual({
      size: "medium",
      short: false,
      pointer: "coarse",
      device: "phone",
      pose: null,
      rail: "dock",
      columns: 1,
      handles: false,
    });
  });

  it("stands two columns from 700 wide, the design's floor: a rail, a list and a letter of the reader's width", () => {
    for (const pointer of ["coarse", "fine"] as const) {
      expect(layoutPlan(at(600, pointer)), `600, ${pointer}`).toMatchObject({
        device: "phone",
        rail: "dock",
        columns: 1,
      });
      expect(layoutPlan(at(699, pointer)), `699, ${pointer}`).toMatchObject({
        device: "phone",
        rail: "dock",
        columns: 1,
      });
      expect(layoutPlan(at(700, pointer)), `700, ${pointer}`).toMatchObject({
        device: "fold",
        rail: "icons",
        columns: 2,
      });
    }
  });

  it("draws the line at 600 and at 840, and calls a window under 480 high short", () => {
    expect(layoutPlan(at(599, "fine")).size).toBe("compact");
    expect(layoutPlan(at(600, "fine")).size).toBe("medium");
    expect(layoutPlan(at(839, "fine")).size).toBe("medium");
    expect(layoutPlan(at(840, "fine")).size).toBe("expanded");
    expect(layoutPlan(at(1440, "fine", 479)).short).toBe(true);
    expect(layoutPlan(at(1440, "fine", 480)).short).toBe(false);
  });
});

describe("the root's attributes", () => {
  const look = { face: "paper", scheme: "light" } as const;

  it("say the device, the touch and the pose the plan chose, and the product", () => {
    expect(attributesOf(layoutPlan(at(841, "coarse")), look, at(841, "coarse"))).toEqual({
      "data-scheme": "light",
      "data-device": "fold",
      "data-touch": "1",
      "data-pose": "land",
      "data-icons": "1",
      "data-product": "mail",
      "data-rm": null,
    });
    expect(
      attributesOf(layoutPlan(at(1440, "fine")), { face: "ohmarchy", scheme: "dark" }, at(1440, "fine")),
    ).toEqual({
      "data-scheme": "dark",
      "data-device": "desktop",
      "data-touch": "0",
      "data-pose": null,
      "data-icons": "1",
      "data-product": "mail",
      "data-rm": null,
    });
  });

  it("take the touch from the pointer alone: a narrow desktop window is a phone's layout under a mouse", () => {
    const narrow = at(390, "fine");
    expect(attributesOf(layoutPlan(narrow), look, narrow)).toMatchObject({
      "data-device": "phone",
      "data-touch": "0",
    });
  });

  it("say reduced motion where the window asks for it", () => {
    const still = { ...at(1440, "fine"), reducedMotion: true };
    expect(attributesOf(layoutPlan(still), look, still)["data-rm"]).toBe("1");
  });
});
