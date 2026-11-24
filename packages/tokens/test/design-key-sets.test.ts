/**
 * A token named in any block is named in the default block too, so no face, scheme or device can
 * carry a value the default cannot answer for. The generator refuses such a source; it writes nothing.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "../scripts/design-lib.mjs";
import { generate } from "../scripts/generate-design.mjs";

/** The package's own source with one entry planted at `path`. */
function planted(path: string, value: unknown) {
  const source = structuredClone(readSource());
  const keys = path.split(".");
  let at: Record<string, any> = source;
  for (const key of keys.slice(0, -1)) at = at[key];
  at[keys[keys.length - 1]] = value;
  return source;
}

describe("the generator refuses a token the default block does not name", () => {
  it.each([
    "tokens.faces.ohmarchy.light.planted",
    "tokens.faces.ohmarchy.dark.planted",
    "tokens.faces.paper.dark.planted",
    "tokens.faces.paper.touch.planted",
    "tokens.accents.cobalt.paper.light.planted",
    "tokens.calendar.ohmarchy.light.planted",
    "tokens.product.cal.planted",
  ])("%s", (path) => {
    expect(() => generate(planted(path, "1px"))).toThrow(/planted is not named in the default block/);
  });

  it("and a reduced motion token that the motion set does not name", () => {
    expect(() => generate(planted("motion.reduced.d-planted", "0ms"))).toThrow(/d-planted is not named in motion\.slick/);
  });

  it("and a calendar token that is a mail token already", () => {
    expect(() => generate(planted("tokens.calendar.paper.light.ink", "#000000"))).toThrow(/is a token of faces\.paper\.light/);
  });

  it("and a reference to a token that does not exist", () => {
    expect(() => generate(planted("tokens.faces.paper.light.ring", "var(--nowhere)"))).toThrow(/var\(--nowhere\) names no token/);
  });

  it("the same value in the default block is taken", () => {
    expect(generate(planted("tokens.faces.paper.light.planted", "1px"))["tokens.css"]).toContain("  --planted: 1px;\n");
  });
});
