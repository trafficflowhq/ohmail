/**
 * The source holds values and nothing else. The sheet's data file also carries an invented world
 * (accounts, calendars, their pairings) and where it was taken from; none of that is a token, and
 * the generator refuses a source that grew such a part.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "../scripts/design-lib.mjs";
import { generate } from "../scripts/generate-design.mjs";

const withPart = (edit: (source: ReturnType<typeof readSource>) => void) => {
  const source = structuredClone(readSource());
  edit(source);
  return source;
};

describe("the generator refuses what is not a value", () => {
  it.each(["accounts", "calendars", "pairings", "defaults", "takenFrom", "taken", "name"])("a part named %s", (part) => {
    expect(() => generate(withPart((s) => { s.tokens[part] = {}; }))).toThrow(/is not a part of the source/);
    expect(() => generate(withPart((s) => { s.tokens.calendar[part] = {}; }))).toThrow(/is not a part of the source/);
  });

  it("a block it has no rule for", () => {
    expect(() => generate(withPart((s) => { s.tokens.faces.paper.print = {}; }))).toThrow(/faces\.paper\.print is not a block/);
    expect(() => generate(withPart((s) => { s.motion.liquid = {}; }))).toThrow(/motion "liquid" is not a part/);
  });

  it.each([
    ["an address to load", "url(https://fonts.example/a.woff2)"],
    ["a host", "//fonts.example/a.css"],
    ["a mailbox", "someone@mail.example"],
    ["a second declaration", "1px; --ink: red"],
    ["a rule", "1px } :root { --ink: red"],
    ["markup", "<script>"],
    ["nothing", " "],
  ])("a value that is %s", (_what, value) => {
    expect(() => generate(withPart((s) => { s.tokens.faces.paper.light.ink = value; }))).toThrow(/faces\.paper\.light\.ink/);
  });

  it("a name that is not a token name", () => {
    expect(() => generate(withPart((s) => { s.tokens.faces.paper.light["Ink}"] = "1px"; }))).toThrow(/is not a token name/);
  });
});

describe("the committed source", () => {
  it("names the sheet it was written from by tag and commit, and no place", () => {
    const { tokens } = readSource();
    expect(Object.keys(tokens.sheet)).toEqual(["tag", "commit"]);
    expect(tokens.sheet.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("holds no address in any string, a note included", () => {
    const strings: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === "string") strings.push(node);
      else if (node && typeof node === "object") Object.values(node).forEach(walk);
    };
    walk(readSource());
    expect(strings.length).toBeGreaterThan(500);
    expect(strings.filter((s) => /@|\/\/|\.example\b|\/home\/|[a-z]:\\/i.test(s))).toEqual([]);
  });
});
