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
import { blocksOf, cascade, readSource } from "../scripts/design-lib.mjs";
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

/* THE KIT'S READS. The kit's components are views of the new design: their stylesheets set properties
   of their own, which the first test's rule is not about, and read the design's tokens, which this file
   holds. The web's census of token reads leaves these folders to it. */
const KIT = ["packages/ui/src/base", "packages/ui/src/mail", "packages/ui/src/calendar"];
/** The looks a token is asked in: each face in each scheme. */
const LOOKS = ["paper", "ohmarchy"].flatMap((face) => ["light", "dark"].map((scheme) => ({ face, scheme })));
type Look = (typeof LOOKS)[number];
interface Read { file: string; name: string; fallback: boolean; looks: Look[] }

/** A selector list cut at its own commas, not those inside a `:is(…)` or `:not(…)`. */
function selectorParts(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === "(") depth += 1;
    else if (list[i] === ")") depth -= 1;
    else if (list[i] === "," && depth === 0) {
      parts.push(list.slice(from, i));
      from = i + 1;
    }
  }
  return [...parts, list.slice(from)];
}

/** The looks a rule holds its declarations to: a selector that stamps a face or a scheme (outside a `:not`) holds
 *  them to it; a selector that stamps neither, and an at-rule, to every look. */
function looksOf(prelude: string): Look[] {
  if (prelude.startsWith("@")) return LOOKS;
  const held = selectorParts(prelude).flatMap((part) => {
    const plain = part.replace(/:not\([^)]*\)/g, "");
    const face = /\[data-face="(\w+)"\]/.exec(plain)?.[1];
    const scheme = /\[data-scheme="(\w+)"\]/.exec(plain)?.[1];
    return LOOKS.filter((look) => (!face || look.face === face) && (!scheme || look.scheme === scheme));
  });
  return LOOKS.filter((look) => held.includes(look));
}

/** Every `var(--x)` of a stylesheet: whether it carries a fallback, and the looks its rule and the rules around it apply to. */
function readsOf(file: string, sheet: string): Read[] {
  const out: Read[] = [];
  const open: Look[][] = [];
  let from = 0;
  const collect = (text: string) => {
    const looks = open.reduce((all, held) => all.filter((look) => held.includes(look)), LOOKS);
    for (const m of text.matchAll(/var\(\s*--([\w-]+)\s*(,)?/g)) out.push({ file, name: m[1]!, fallback: m[2] !== undefined, looks });
  };
  for (let i = 0; i < sheet.length; i += 1) {
    if (sheet[i] === "{") {
      const text = sheet.slice(from, i);
      const cut = text.lastIndexOf(";") + 1;
      collect(text.slice(0, cut));
      open.push(looksOf(text.slice(cut).trim()));
      from = i + 1;
    } else if (sheet[i] === "}") {
      collect(sheet.slice(from, i));
      open.pop();
      from = i + 1;
    }
  }
  return out;
}

describe("the kit's stylesheets read the design's tokens", () => {
  const { tokens, motion } = readSource();
  const blocks = blocksOf(tokens);
  const inLook = new Map(LOOKS.map((look) => [look, new Set(Object.entries(cascade(blocks, look)).filter(([, v]) => v !== "initial").map(([name]) => name))]));
  const moving = new Set([...Object.keys(motion.slick), ...Object.keys(motion.calendar?.slick ?? {}), "m-time"]);
  const design = new Set([...blocks.flatMap((block) => Object.keys(block.decls)), ...moving]);
  const files = KIT.flatMap((dir) => walk(join(root, dir)));
  const sheets = files.filter((file) => file.endsWith(".css"));
  const text = (file: string) => readFileSync(join(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  /* What the kit sets itself: a property one of its stylesheets declares, or one its code names whole in a string. */
  const own = new Set([
    ...sheets.flatMap((file) => [...text(file).matchAll(/--([\w-]+)\s*:/g)].map((m) => m[1]!)),
    ...files.filter((file) => /\.(tsx?|mjs)$/.test(file)).flatMap((file) => [...readFileSync(join(root, file), "utf8").matchAll(/["'`]--([\w-]+)["'`]/g)].map((m) => m[1]!)),
  ]);
  const reads = sheets.flatMap((file) => readsOf(file, text(file)));

  it("reads something: the walk found the kit's stylesheets and their reads of the design", () => {
    expect(sheets.length).toBeGreaterThan(50);
    expect(reads.filter((read) => design.has(read.name)).length).toBeGreaterThan(100);
  });

  it("every name a kit stylesheet reads is a token of the source or a property the kit sets itself", () => {
    expect(reads.filter((read) => !design.has(read.name) && !own.has(read.name)).map((read) => `${read.file}: --${read.name}`)).toEqual([]);
  });

  it("a token read without a fallback is defined in every look its rule applies to: paper and ohmarchy, light and dark", () => {
    const missing = reads
      .filter((read) => !read.fallback && design.has(read.name) && !moving.has(read.name) && !own.has(read.name))
      .flatMap((read) => read.looks.filter((look) => !inLook.get(look)!.has(read.name)).map((look) => `${read.file}: --${read.name} in ${look.face} ${look.scheme}`));
    expect(missing).toEqual([]);
  });

  it("controls: a rule held to a face or a scheme reads in that look alone, and a fallback is seen", () => {
    const [paperOnly, both, darkOhmarchy, fallback] = [
      readsOf("x.css", ':root[data-face="paper"] .a { color: var(--sheet); }'),
      readsOf("x.css", '@layer kit { .a, :root[data-face="paper"] .b { color: var(--sheet); } }'),
      readsOf("x.css", ':root[data-face="ohmarchy"] { .a:not([data-face="paper"]) { :root[data-scheme="dark"] & { color: var(--sheet); } } }'),
      readsOf("x.css", ".a { bottom: var(--foot, 0px); }"),
    ];
    expect(paperOnly[0]!.looks).toEqual(LOOKS.filter((look) => look.face === "paper"));
    expect(both[0]!.looks).toEqual(LOOKS);
    expect(darkOhmarchy[0]!.looks).toEqual([{ face: "ohmarchy", scheme: "dark" }]);
    expect(fallback[0]).toMatchObject({ name: "foot", fallback: true });
  });
});
