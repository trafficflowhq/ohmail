/**
 * The typefaces travel with the app: every font a stylesheet of this package names is a file of
 * this package, byte for byte the one the source pins, with its licence text beside it. No
 * stylesheet here names a host, so no page that reads one asks the network for a font.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "../scripts/design-lib.mjs";
import { generate } from "../scripts/generate-design.mjs";
import { fontFiles, fontLicenceFiles, fonts, fontsDir } from "../src/design/fonts.js";
import { design } from "../src/design/tokens.js";

const pkg = fileURLToPath(new URL("../", import.meta.url));
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const stylesheets = [...readdirSync(join(pkg, "src")), ...readdirSync(join(pkg, "src/design")).map((f) => `design/${f}`)]
  .filter((f) => f.endsWith(".css"))
  .map((f) => join(pkg, "src", f));

/** Every `url(...)` and `@import` target of a stylesheet's text. */
const loads = (css: string) => [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)|@import\s+["']([^"']+)["']/g)].map((m) => m[1] ?? m[2]);
/** What of `targets` leaves the package: a scheme, a host, an absolute path, inlined bytes. */
const leaving = (targets: string[]) => targets.filter((t) => /^[a-z][a-z0-9+.-]*:|^\/\/|^\//i.test(t));

describe("what counts as leaving the package", () => {
  it.each([
    'src: url(https://fonts.example/a.woff2)',
    'src: url("//fonts.example/a.woff2")',
    "src: url(data:font/woff2;base64,AAAA)",
    'src: url("/fonts/a.woff2")',
    '@import "https://fonts.example/css2?family=A";',
  ])("%s", (css) => expect(leaving(loads(css))).toHaveLength(1));

  it("a path beside the stylesheet does not", () => {
    expect(leaving(loads('src: url("../../fonts/a.woff2") format("woff2")'))).toEqual([]);
  });
});

describe("the stylesheets of this package", () => {
  it("name no host and inline no bytes", () => {
    expect(stylesheets.length).toBeGreaterThan(5);
    expect(stylesheets.flatMap((path) => leaving(loads(readFileSync(path, "utf8"))).map((t) => `${relative(pkg, path)}: ${t}`))).toEqual([]);
  });

  it("load the six font files, each a file of fonts/, and nothing else", () => {
    const targets = stylesheets.flatMap((path) => loads(readFileSync(path, "utf8")).map((t) => relative(pkg, resolve(dirname(path), t))));
    expect(targets.sort()).toEqual(fontFiles.map((file) => `fonts/${file}`).sort());
    expect(targets).toHaveLength(6);
    expect(targets.filter((t) => !existsSync(join(pkg, t)))).toEqual([]);
  });
});

describe("fonts/", () => {
  const dir = resolve(pkg, "src/design", fontsDir);

  it("holds the font files, the licence texts and the list, and nothing else", () => {
    expect(readdirSync(dir).sort()).toEqual([...fontFiles, ...fontLicenceFiles, "FONTS.md"].sort());
  });

  const pinnedFiles: { file: string; sha256: string }[] = [];
  for (const family of fonts) pinnedFiles.push(...family.files);

  it.each(pinnedFiles)("$file is the bytes the source pins", ({ file, sha256: pinned }) => {
    expect(sha256(join(dir, file))).toBe(pinned);
    expect(readFileSync(join(dir, file)).subarray(0, 4).toString("latin1")).toBe("wOF2");
  });

  it.each(fonts.map((family) => [family.family, family.licence] as const))("%s travels with its licence and its copyright line", (_family, licence) => {
    const text = readFileSync(join(dir, licence.file), "utf8");
    expect(text.split("\n")[0].startsWith(licence.copyright)).toBe(true);
    expect(text).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(text.split("\n")[0]).not.toMatch(/Reserved Font Name/i);
    expect(readFileSync(join(dir, "FONTS.md"), "utf8")).toContain(licence.file);
  });

  it("the list beside the files is the generator's", () => {
    expect(readFileSync(join(dir, "FONTS.md"), "utf8")).toBe(generate()["../../fonts/FONTS.md"]);
  });
});

describe("the typefaces and the tokens agree", () => {
  const first = (stack: string) => stack.split(",")[0].replaceAll('"', "");
  const read = new Set([design.faces.paper.light, design.faces.ohmarchy.light].flatMap((face) => [first(face["f-display"]), first(face["f-text"])]));

  it("every family a face asks for first is bundled, and every bundled family is asked for", () => {
    expect([...read].sort()).toEqual(fonts.map((family) => family.family).sort());
  });
});

describe("the generator refuses a typeface it cannot vouch for", () => {
  const withFonts = (edit: (families: any[]) => void) => {
    const source = structuredClone(readSource());
    edit(source.fonts.families);
    return source;
  };
  it.each([
    ["a file from a host", (f: any[]) => { f[0].files[0].file = "https://fonts.example/a.woff2"; }, /is not a file/],
    ["a path out of the folder", (f: any[]) => { f[0].files[0].file = "../a.woff2"; }, /is not a file/],
    ["a file without its checksum", (f: any[]) => { delete f[0].files[0].sha256; }, /is not a sha256/],
    ["a file two faces name", (f: any[]) => { f[1].files[0].file = f[0].files[0].file; }, /is named twice/],
    ["a family without a licence text", (f: any[]) => { delete f[2].licence.file; }, /is not a licenceFile/],
    ["another licence", (f: any[]) => { f[2].licence.name = "Proprietary"; }, /is not a licence this package bundles under/],
    ["a family name that closes the string", (f: any[]) => { f[0].family = 'A"; src: url(x)'; }, /is not a family/],
    ["a family with no file", (f: any[]) => { f[0].files = []; }, /names no file/],
  ])("%s", (_what, edit, message) => {
    expect(() => generate(withFonts(edit))).toThrow(message);
  });
});
