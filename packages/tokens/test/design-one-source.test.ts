/**
 * Every value of the design is written once, in source/. A file beside the generated ones may
 * read a token; it may not declare one or carry a colour or a size of its own.
 *
 * The stylesheets and the TypeScript file the old views still read are older than this rule.
 * They are listed, and the list only gets shorter: a file leaves it when its last view is rebuilt.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "../scripts/design-lib.mjs";
import { generate } from "../scripts/generate-design.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const SCOPE = ["packages/tokens/src", "packages/ui/src/icons", "packages/ui/src/motion"];
const WRITTEN_ONCE = [
  ...Object.keys(generate()).map((name) => posix.join("packages/tokens/src/design", name)),
  "packages/ui/src/icons/icons.json",
];
const OLD = [
  "packages/tokens/src/faces.css",
  "packages/tokens/src/ohmarchy.css",
  "packages/tokens/src/ohmarchy.json",
  "packages/tokens/src/tokens.css",
  "packages/tokens/src/tokens.ts",
];

/** What in `text` is a value written down: a declared custom property, a colour, a length, a time. */
function valuesIn(text: string): string[] {
  const found = text.match(/--[a-z][a-z0-9-]*\s*:|#[0-9a-f]{3,8}\b|\b(?:oklch|oklab|rgba?|hsla?)\(|(?<![\w.-])\d*\.?\d+(?:px|r?em|ms|s)\b/gi);
  return found ?? [];
}

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [relative(root, path)];
  });

describe("what counts as a value", () => {
  it.each([
    ["--x:#fff", ["--x:", "#fff"]],
    [".a{color:#F8431A}", ["#F8431A"]],
    ["border-radius: 4px", ["4px"]],
    ["transition: opacity .2s", [".2s"]],
    ["duration: 150ms", ["150ms"]],
    ["color: oklch(0.6 0.1 20)", ["oklch("]],
    ["background: rgba(0,0,0,.5)", ["rgba("]],
  ])("%s", (text, values) => expect(valuesIn(text)).toEqual(values));

  it.each([
    "stroke-width: var(--ico-w)",
    'animate(el, "move", { ease: "--e-move" })',
    "transform: `translate(${dx}px, ${dy}px)`",
    "export const ICON_SIZES = [16, 18, 20, 22, 24] as const;",
    'viewBox="0 0 24 24"',
  ])("not: %s", (text) => expect(valuesIn(text)).toEqual([]));
});

describe("the design's values are written once", () => {
  const files = SCOPE.flatMap((dir) => walk(join(root, dir)));

  it("no file beside the generated ones writes a value", () => {
    const writers = files
      .filter((file) => !WRITTEN_ONCE.includes(file) && !OLD.includes(file))
      .filter((file) => valuesIn(readFileSync(join(root, file), "utf8")).length > 0);
    expect(files.length).toBeGreaterThan(10);
    expect(writers).toEqual([]);
  });

  it("and every token one of them reads is a token of the source", () => {
    const { tokens, motion } = readSource();
    const named = new Set([tokens.faces.paper.light, tokens.calendar.paper.light, motion.slick, motion.calendar.slick].flatMap(Object.keys));
    const reads = files
      .filter((file) => !WRITTEN_ONCE.includes(file) && !OLD.includes(file) && file !== "packages/tokens/src/index.ts")
      .flatMap((file) => [...readFileSync(join(root, file), "utf8").matchAll(/var\(\s*--([a-z0-9-]+)|["'`]--([a-z][a-z0-9-]*[a-z0-9])["'`]/g)].map((m) => `${file}: ${m[1] ?? m[2]}`));
    expect(reads.length).toBeGreaterThan(3);
    expect(reads.filter((read) => !named.has(read.split(": ")[1]) && !read.endsWith(": m-time"))).toEqual([]);
  });

  it("the list of older files only gets shorter", () => {
    expect(OLD.length).toBeLessThanOrEqual(5);
    expect(OLD.filter((file) => !existsSync(join(root, file)))).toEqual([]);
    expect(WRITTEN_ONCE.filter((file) => !existsSync(join(root, file)))).toEqual([]);
  });
});
