/**
 * src/design is the generator's output and nothing else: a hand edit of a committed file, or a
 * change of source/ without a run of scripts/generate-design.mjs, fails here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readSource } from "../scripts/design-lib.mjs";
import { generate } from "../scripts/generate-design.mjs";

const committed = (name: string) => readFileSync(new URL(`../src/design/${name}`, import.meta.url), "utf8");
const out = generate();
const css = out["tokens.css"];
const motionCss = out["motion.css"];

describe("src/design is what the source generates", () => {
  it.each(Object.keys(out))("%s", (name) => {
    expect(committed(name)).toBe(out[name]);
  });
});

/** `[selector, body]` of every rule, a rule inside a media block included. */
const rules = (text: string) =>
  [...text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}@]+)\{\n([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]] as const);

describe("the stylesheets", () => {
  it("load nothing and stamp the scheme on data-scheme alone", () => {
    for (const text of [css, motionCss]) expect(text).not.toMatch(/url\(|@import|data-theme/);
  });

  it("declare no property the source does not name", () => {
    const { tokens, motion } = readSource();
    const named = new Set([
      ...Object.keys(tokens.faces.paper.light),
      ...Object.keys(tokens.calendar.paper.light),
      "m-time",
      ...Object.keys(motion.slick),
      ...Object.keys(motion.calendar.slick),
    ]);
    const declared = [...`${css}${motionCss}`.matchAll(/^ {2}--([a-z0-9-]+):/gm)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(named.size);
    expect(declared.filter((name) => !named.has(name))).toEqual([]);
  });

  it("answer a dark system exactly as they answer data-scheme=dark", () => {
    const all = rules(css);
    const stamped = all.filter(([selector]) => selector.includes('[data-scheme="dark"]'));
    const system = all.filter(([selector]) => selector.includes(":not([data-scheme])"));
    expect(stamped.length).toBeGreaterThan(3);
    expect(system).toEqual(stamped.map(([selector, body]) => [selector.replace('[data-scheme="dark"]', ":not([data-scheme])"), body]));
    expect(css.match(/@media \(prefers-color-scheme: dark\)\{/g)).toHaveLength(stamped.length);
  });

  it("reduce motion the same way for the attribute and for the system's own setting", () => {
    const [slick, byAttribute, bySystem] = rules(motionCss);
    expect(slick[0]).toBe(":root");
    expect(byAttribute[0]).toBe(':root[data-rm="1"],\n[data-rm="1"]');
    expect(bySystem).toEqual([":root", byAttribute[1]]);
    expect(motionCss).toContain("@media (prefers-reduced-motion: reduce){\n:root{");
  });
});
