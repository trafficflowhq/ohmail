/**
 * The new design and the old one never meet in one page.
 *
 * Both stylesheets declare `--ink`, `--focus`, `--r-pill` and more with different values, so a
 * page that loads both is recoloured by whichever comes last, and nothing fails. Two fences:
 *
 *  - who may import `@ohmail/tokens/design*`: the list below. It is empty for stylesheets today;
 *    a rebuilt screen adds its entry here, by name, in the change that rebuilds it.
 *  - no module reaches both an old stylesheet and a new one through its imports, however far.
 *
 * And until the workspace has a tool for import borders: what the new folders may import.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** Who imports the design's subpaths, and how. `type` is erased before anything runs. */
const MAY_IMPORT: Record<string, "type"> = {
  "packages/ui/src/motion/motion.ts": "type",
};

const OLD_SHEET = /^@ohmail\/tokens\/(tokens|faces|ohmarchy)\.css$|^packages\/tokens\/src\/(tokens|faces|ohmarchy)\.css$/;
const NEW_SHEET = /^@ohmail\/tokens\/design(\.css$|\/.+\.css$)|^packages\/tokens\/src\/design\/.+\.css$/;
const DESIGN = /^@ohmail\/tokens\/design(\.css)?($|\/)/;

type Files = Map<string, string>;
const IMPORT = /(import\s+type\s[^"';]*?from\s*|\bfrom\s*|\bimport\s*\(?\s*|@import\s+(?:url\()?\s*|\brequire\(\s*)["']([^"']+)["']/g;
const importsOf = (text: string) => [...text.matchAll(IMPORT)].map((m) => ({ specifier: m[2], typeOnly: m[1].startsWith("import type") }));

/** The file of `files` a specifier names from `from`, or the specifier itself when it names none. */
function target(files: Files, from: string, specifier: string): string {
  const tries = (base: string) => [base, base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  if (specifier.startsWith(".")) return tries(normalize(join(dirname(from), specifier))).find((p) => files.has(p)) ?? specifier;
  const [, name, sub] = /^(@[^/]+\/[^/]+)(?:\/(.+))?$/.exec(specifier) ?? [];
  const manifest = [...files.keys()].find((p) => p.endsWith("/package.json") && JSON.parse(files.get(p)!).name === name);
  if (!manifest) return specifier;
  const entry = JSON.parse(files.get(manifest)!).exports?.[sub ? `./${sub}` : "."];
  const path = typeof entry === "string" ? entry : (entry?.["ohmail-source"] ?? entry?.default);
  return path ? normalize(join(dirname(manifest), path)) : specifier;
}

/** Every file whose imports lead to an old stylesheet and to a new one. */
function reachBoth(files: Files): string[] {
  const importers = new Map<string, string[]>();
  for (const [file, text] of files) {
    if (file.endsWith(".json")) continue;
    for (const { specifier, typeOnly } of importsOf(text)) {
      if (typeOnly) continue;
      for (const to of new Set([specifier, target(files, file, specifier)])) importers.set(to, [...(importers.get(to) ?? []), file]);
    }
  }
  const reaching = (sheet: RegExp) => {
    const seen = new Set<string>();
    const queue = [...importers.keys()].filter((to) => sheet.test(to));
    for (let to = queue.pop(); to !== undefined; to = queue.pop()) {
      for (const file of importers.get(to) ?? []) if (!seen.has(file)) queue.push((seen.add(file), file));
    }
    return seen;
  };
  const old = reaching(OLD_SHEET);
  return [...reaching(NEW_SHEET)].filter((file) => old.has(file)).sort();
}

/** `[file, how]` for every import of a design subpath outside the tokens package. */
function designImports(files: Files): [string, "type" | "value"][] {
  const out: [string, "type" | "value"][] = [];
  for (const [file, text] of files) {
    if (file.startsWith("packages/tokens/") || file.endsWith(".json")) continue;
    for (const { specifier, typeOnly } of importsOf(text)) if (DESIGN.test(specifier)) out.push([file, typeOnly ? "type" : "value"]);
  }
  return out;
}

const SKIP = new Set(["node_modules", "dist", "test", "target", "gen", "android", "ios", "build", "out", "coverage"]);
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    if (SKIP.has(entry) || entry.startsWith(".")) return [];
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(tsx?|mts|mjs|jsx?|css)$/.test(entry) || entry === "package.json" ? [path] : [];
  });
const tree: Files = new Map(["apps", "packages"].flatMap((dir) => walk(join(root, dir))).map((p) => [relative(root, p), readFileSync(p, "utf8")]));

const planted = (extra: Record<string, string>): Files => new Map([...tree, ...Object.entries(extra)]);

describe("who imports the new design", () => {
  it("only the files listed, each the way it is listed", () => {
    expect(tree.size).toBeGreaterThan(1500);
    expect(Object.fromEntries(designImports(tree))).toEqual(MAY_IMPORT);
  });

  it("an import anywhere else is found, whatever its form", () => {
    const files = planted({
      "apps/webapp/app/planted.tsx": 'import "@ohmail/tokens/design.css";\n',
      "apps/desktop/src/planted.ts": 'import { design } from "@ohmail/tokens/design";\n',
      "packages/ui/src/planted.css": '@import "@ohmail/tokens/design/motion.css";\n',
      "apps/mobile/src/planted.ts": 'const t = await import("@ohmail/tokens/design/tokens.json");\n',
    });
    expect(designImports(files).map(([file]) => file).filter((file) => file.includes("planted")).sort()).toEqual([
      "apps/desktop/src/planted.ts", "apps/mobile/src/planted.ts", "apps/webapp/app/planted.tsx", "packages/ui/src/planted.css",
    ]);
  });
});

describe("no module reaches the old stylesheets and the new", () => {
  it("in the tree as it is", () => expect(reachBoth(tree)).toEqual([]));

  it("the old ones are reached through the component package's entry, so the reading is not empty", () => {
    const files = planted({ "apps/webapp/app/planted-shell.tsx": 'import "@ohmail/tokens/design.css";\nimport "./planted-view";\n', "apps/webapp/app/planted-view.tsx": 'import { Button } from "@ohmail/ui";\n' });
    expect(reachBoth(files)).toEqual(["apps/webapp/app/planted-shell.tsx"]);
  });

  it("a type alone joins nothing", () => {
    const files = planted({ "apps/webapp/app/planted-shell.tsx": 'import "@ohmail/tokens/design.css";\nimport type { ButtonProps } from "@ohmail/ui";\n' });
    expect(reachBoth(files)).toEqual([]);
  });
});

describe("what the new folders import", () => {
  const borders: [folder: string, allowed: RegExp][] = [
    ["packages/tokens/src/design/", /^\.{1,2}\//],
    ["packages/tokens/scripts/", /^\.{1,2}\/|^node:/],
    ["packages/tokens/omarchy/design-slots.ts", /^\.\//],
    ["packages/ui/src/icons/", /^\.\/|^react(\/jsx-runtime)?$/],
    ["packages/ui/src/motion/", /^\.\/|^\.\.\/ui-zoom\.js$|^react$|^@ohmail\/tokens(\/design)?$/],
  ];
  const outside = (files: Files) =>
    [...files].flatMap(([file, text]) => {
      const border = borders.find(([folder]) => file.startsWith(folder));
      if (!border || file.endsWith(".json")) return [];
      return importsOf(text).filter(({ specifier }) => !border[1].test(specifier)).map(({ specifier }) => `${file}: ${specifier}`);
    });

  it("nothing beyond their own package, React and the tokens", () => {
    expect(outside(tree)).toEqual([]);
    expect(JSON.parse(tree.get("packages/tokens/package.json")!).dependencies).toEqual({});
  });

  it("an import of the engine is found", () => {
    const files = planted({ "packages/ui/src/motion/planted.ts": 'import { engine } from "@ohmail/client-engine";\n' });
    expect(outside(files)).toEqual(["packages/ui/src/motion/planted.ts: @ohmail/client-engine"]);
  });
});
