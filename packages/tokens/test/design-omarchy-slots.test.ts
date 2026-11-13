/**
 * omarchy/design-slots.ts: a live theme, mapped by the law, in the design's slot names.
 *
 * Three things are held. Every shipped theme still clears the contrast floors once it is renamed
 * and its washes are painted. Every colour the Ohmarchy face writes out is reached by a theme, or
 * stands on a list by name. And the design's own Ohmarchy blocks, which were written from two of
 * the themes, are what the adapter makes of them, slot by slot, except for the slots listed
 * below. Those lists are records of where the design sheet and the law disagree today; they are
 * not tolerances. A slot leaves one when the sheet or the adapter's table is corrected.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clearsDesignFloors, toDesignSlots } from "../omarchy/design-slots.js";
import { omarchyMap } from "../omarchy/map.js";
import { same } from "../scripts/compare-sheet.mjs";
import { readSource, valueOf, type SourceBlock } from "../scripts/design-lib.mjs";
import { design } from "../src/design/tokens.js";

const fixtures = new URL("../omarchy/fixtures/", import.meta.url);
const index: { themes: { slug: string }[] } = JSON.parse(readFileSync(new URL("index.json", fixtures), "utf8"));
const slugs = index.themes.map((theme) => theme.slug);
const slotsOf = (slug: string) =>
  toDesignSlots(omarchyMap().mapTheme(JSON.parse(readFileSync(new URL(`${slug}.json`, fixtures), "utf8"))).tokens);
const REFERENCE = [["flexoki-light", "light"], ["tokyo-night", "dark"]] as const;
const clears = (slots: Record<string, string>) => clearsDesignFloors(slots, design.faces.ohmarchy);

/* One step of one channel apart: the sheet rounded a mixed colour the other way. */
const ROUNDED = { light: ["line-soft", "hover", "soft-sheet", "ring"], dark: ["line"] };
/* Another colour: the sheet draws a control's ring darker than a button's, and lifts the third ink at night. */
const DIFFERENT = { light: ["ctl-ring"], dark: ["ink3", "ctl-ring"] };
/* A colour the face writes out that no theme reaches: the sheet's two themes show no one rule for it, so it
   keeps the reference theme's colour under every theme. To be empty before a live theme paints this face. */
const NO_RULE_YET = {
  light: ["hover-ground", "sq-mid", "sq-pale", "sq-paler", "sq-mine"],
  dark: ["solid", "hover-ground", "sq-mid", "sq-pale", "sq-paler", "sq-mine", "rule"],
};
/* A tone, lightness and chroma, under a hue the data names: the same for every theme of a scheme, on purpose. */
const TONES = { light: ["av-bg", "av-fg", "tag-dot", "cal-mark", "cal-tint"], dark: ["av-bg", "av-fg", "tag-dot", "cal-mark", "cal-tint"] };

describe("a mapped theme in the design's slots", () => {
  it("names only slots the design declares, and the scheme", () => {
    for (const [slug] of REFERENCE) {
      const names = Object.keys(slotsOf(slug)).filter((n) => n !== "color-scheme");
      expect(names.filter((n) => !(n.slice(2) in design.faces.ohmarchy.light)), slug).toEqual([]);
    }
  });

  it("writes a wash as the colour it paints, a ring as its colour, and a raised ring whole", () => {
    const slots = slotsOf("flexoki-light");
    for (const name of ["--wash", "--line", "--hover", "--soft-sheet", "--off", "--ring", "--ring-up", "--btn-ring"]) {
      expect(slots[name], name).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(slotsOf("tokyo-night")["--lift"]).toBe("0 0 0 2px #414868");
    /* A theme that names no muted colour: the law's ring is a wash, painted on the ground like ring-up. */
    const bare = omarchyMap().mapTheme({ mode: "dark", colors: { background: "#101010", foreground: "#f0f0f0", accent: "#80a0ff", red: "#ff6060" } });
    const painted = toDesignSlots(bare.tokens);
    expect(painted["--lift"]).toBe(`0 0 0 2px ${painted["--ring-up"]}`);
    expect(painted["--ring-up"]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it.each(slugs)("%s clears the floors", (slug) => {
    expect(clears(slotsOf(slug))).toBe(true);
  });

  it("has every theme to ask", () => {
    expect(slugs).toHaveLength(22);
    expect(readdirSync(fixtures).filter((f) => f.endsWith(".json")).length).toBe(slugs.length + 2);
  });

  it("does not clear them with an ink the sheet cannot carry", () => {
    const slots = slotsOf("flexoki-light");
    expect(clears({ ...slots, "--ink3": slots["--sheet"] })).toBe(false);
    expect(clears({ ...slots, "--on-hot": slots["--hot"] })).toBe(false);
    expect(clears({ ...slots, "--on-solid": slots["--solid"] })).toBe(false);
    expect(clears({ ...slots, "--on-off": slots["--off"] })).toBe(false);
  });

  it("asks a colour the theme does not reach as the face's own, which is what the page shows", () => {
    /* Tokyo Night's label colour on Gruvbox's fill is under the floor; Gruvbox's own is not. */
    const { "--on-off": own, ...without } = slotsOf("gruvbox");
    expect(own).not.toBe(design.faces.ohmarchy.dark["on-off"]);
    expect(clears(without)).toBe(false);
    const { "--hot-ink": _same, ...flexoki } = slotsOf("flexoki-light");
    expect(clears(flexoki)).toBe(true);
  });

  it("walks a label on a filled control up to the floor, and leaves one that clears it alone", () => {
    const map = omarchyMap();
    const law = (slug: string) => map.mapTheme(JSON.parse(readFileSync(new URL(`${slug}.json`, fixtures), "utf8"))).tokens;
    const everforest = slotsOf("everforest");
    expect(map.contrast(law("everforest")["--ink2"], everforest["--off"])).toBeLessThan(4.5);
    expect(map.contrast(everforest["--on-off"], everforest["--off"])).toBeGreaterThanOrEqual(4.5);
    expect(slotsOf("tokyo-night")["--on-off"]).toBe(law("tokyo-night")["--ink2"]);
    expect(slotsOf("flexoki-light")["--on-off"]).toBe(law("flexoki-light")["--ink3"]);
  });
});

describe("the colours the Ohmarchy face writes out", () => {
  const source = readSource().tokens;
  const COLOUR = /#[0-9a-f]{3,8}\b|rgba?\(/i;
  const TONE = /^\d*\.\d+ \d*\.\d+$/;
  it.each(REFERENCE)("under %s each is reached by the theme, a tone, or named as waiting for a rule", (slug, scheme) => {
    const written: SourceBlock = { ...source.faces.ohmarchy[scheme], ...source.calendar.ohmarchy[scheme] };
    const reached = new Set(Object.keys(slotsOf(slug)).map((n) => n.slice(2)));
    const left = Object.keys(written).filter((name) => !reached.has(name));
    expect(left.filter((name) => COLOUR.test(valueOf(written[name])))).toEqual(NO_RULE_YET[scheme]);
    expect(Object.keys(written).filter((name) => TONE.test(valueOf(written[name]))).sort()).toEqual([...TONES[scheme]].sort());
    expect(TONES[scheme].filter((name) => reached.has(name))).toEqual([]);
  });

  it("no theme but the reference one keeps a reference colour in a slot it reaches", () => {
    const [gruvbox, tokyo] = [slotsOf("gruvbox"), slotsOf("tokyo-night")];
    for (const name of ["--ink-read", "--on-solid", "--soft", "--soft-sheet", "--on-off", "--lift"]) {
      expect(gruvbox[name], name).toBeDefined();
      expect(gruvbox[name], name).not.toBe(tokyo[name]);
    }
    expect(slotsOf("white")["--solid"]).not.toBe(slotsOf("flexoki-light")["--solid"]);
  });
});

describe("the design's Ohmarchy blocks are the law's output for their two themes", () => {
  const far = (a: string, b: string) => Math.max(...[1, 3, 5].map((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16))));
  it.each(REFERENCE)("%s is the %s block", (slug, scheme) => {
    const sheet: Record<string, string> = design.faces.ohmarchy[scheme];
    const rounded: string[] = [];
    const different: string[] = [];
    for (const [slot, value] of Object.entries(slotsOf(slug))) {
      if (slot === "color-scheme") continue;
      const theirs = sheet[slot.slice(2)];
      if (same(theirs, value)) continue;
      (far(theirs, value) <= 1 ? rounded : different).push(slot.slice(2));
    }
    expect({ rounded, different }).toEqual({ rounded: ROUNDED[scheme], different: DIFFERENT[scheme] });
  });
});
