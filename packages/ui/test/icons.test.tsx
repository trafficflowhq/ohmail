/** @vitest-environment jsdom */
/**
 * The icons: one data file from the design sheet, drawn by one component. The drawing is
 * shapes and geometry only, because it is set as markup; the line is the face's, through tokens.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Icon, ICON_SIZES, icons, type IconName } from "../src/icons/Icon.js";
import data from "../src/icons/icons.json" with { type: "json" };

afterEach(cleanup);

const NUMBER = String.raw`-?\d*\.?\d+`;
const ATTRIBUTES: Record<string, RegExp> = {
  d: /^[MmLlHhVvCcSsQqTtAaZz\d\s.,-]+$/,
  ...Object.fromEntries(["x", "y", "cx", "cy", "r", "rx", "ry", "width", "height", "stroke-width"].map((name) => [name, new RegExp(`^${NUMBER}$`)])),
  "stroke-dasharray": new RegExp(`^${NUMBER}( ${NUMBER})*$`),
  fill: /^(none|currentColor)$/,
  stroke: /^(none|currentColor)$/,
};
const SHAPE = /<(path|circle|ellipse|rect|line|polyline)((?: [a-z-]+="[^"<>]*")*)\/>/g;

/** True when `svg` is shapes with geometry and nothing else. */
function isDrawing(svg: string): boolean {
  if (svg.replace(SHAPE, "") !== "" || svg === "") return false;
  return [...svg.matchAll(SHAPE)].every((shape) =>
    [...shape[2].matchAll(/ ([a-z-]+)="([^"]*)"/g)].every(([, name, value]) => ATTRIBUTES[name]?.test(value) === true),
  );
}

const names = Object.keys(icons) as IconName[];

describe("the icon set", () => {
  it("has the sheet's 82 icons, each under a plain name with the words it is found by", () => {
    expect(names).toHaveLength(82);
    expect(names.filter((name) => !/^[a-z][a-z0-9-]*$/.test(name) || !/^[a-z0-9 ,.-]*$/i.test(icons[name].words))).toEqual([]);
  });

  it("is drawn at the sizes the component takes, on the grid the data names", () => {
    expect([...ICON_SIZES]).toEqual(data.sizes);
    expect(data.grid).toBe(24);
  });

  it("holds shapes and geometry only", () => {
    expect(names.filter((name) => !isDrawing(icons[name].svg))).toEqual([]);
  });

  it.each([
    '<script>alert(1)</script>',
    '<path d="M4 4h16"/><script/>',
    '<path d="M4 4h16" onload="x()"/>',
    '<path d="M4 4h16" style="stroke:red"/>',
    '<path d="M4 4h16" fill="url(#a)"/>',
    '<path d="M4 4h16" stroke="#ff0000"/>',
    '<image href="https://example.invalid/a.png"/>',
    '<path d="M4 4h16"/> text',
    "",
  ])("does not take %s for a drawing", (svg) => expect(isDrawing(svg)).toBe(false));
});

describe("Icon", () => {
  it("beside a word is hidden from a screen reader", () => {
    const svg = render(<Icon name="send" size={18} />).container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.hasAttribute("role")).toBe(false);
    expect(svg.hasAttribute("aria-label")).toBe(false);
  });

  it("alone is an image with the name it was given", () => {
    const { getByRole } = render(<Icon name="send" size={18} label="Send" />);
    const svg = getByRole("img", { name: "Send" });
    expect(svg.hasAttribute("aria-hidden")).toBe(false);
  });

  it("is drawn on the grid at its size, in the colour of the text, its line left to the face", () => {
    const svg = render(<Icon name="more" size={22} className="lead" />).container.querySelector("svg")!;
    expect(svg.getAttribute("class")).toBe("oh-icon lead");
    expect([svg.getAttribute("viewBox"), svg.getAttribute("width"), svg.getAttribute("height")]).toEqual(["0 0 24 24", "22", "22"]);
    expect([svg.getAttribute("fill"), svg.getAttribute("stroke")]).toEqual(["none", "currentColor"]);
    for (const line of ["stroke-width", "stroke-linecap", "stroke-linejoin"]) expect(svg.hasAttribute(line)).toBe(false);
  });

  it.each(names)("draws %s whole", (name) => {
    const svg = render(<Icon name={name} size={16} />).container.querySelector("svg")!;
    expect(svg.children.length).toBe(icons[name].svg.match(/<[a-z]/g)!.length);
  });
});
