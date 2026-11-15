/**
 * The next design's components stand beside today's, and the two never import each other.
 *
 * Today's entry loads today's stylesheets and the three new entries load the next design's; a module
 * that reached both would put two meanings of one token name into a page. So: the new folders import
 * their own files, the icons, the motion helper and React, and each entry only what stands below it;
 * the old folders import nothing new. Held here until the workspace's linter holds import borders.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) =>
    statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)],
  );
const tree = new Map(
  walk(SRC)
    .filter((p) => /\.(tsx?|css)$/.test(p))
    .map((p) => [relative(SRC, p), readFileSync(p, "utf8")]),
);

/* `from` opens a specifier only with a space before the quote: a `"from"` in markup or in a selector is no import. */
const IMPORT = /(?:\bfrom\s+|\bimport\s*\(?\s*|@import\s+(?:url\()?\s*)["']([^"']+)["']/g;
/** What each new folder may reach inside the package: itself, what stands below it, the icons and the motion helper. */
const BELOW: Record<string, string[]> = {
  base: ["base", "icons", "motion"],
  mail: ["base", "mail", "icons", "motion"],
  calendar: ["base", "mail", "calendar", "icons", "motion"],
};
const OUTSIDE = /^react(\/jsx-runtime)?$|^@ohmail\/tokens\/design(\.css|\/motion\.css)?$/;

/** Every import that crosses the line, as `file: specifier`. */
function crossings(files: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [file, text] of files) {
    const folder = file.split("/")[0]!;
    /* The icons and the motion helper belong to both; their own border is held with the tokens'. */
    if (folder === "icons" || folder === "motion") continue;
    const fresh = BELOW[folder];
    for (const [, specifier] of text.matchAll(IMPORT)) {
      if (!specifier!.startsWith(".")) {
        if (
          fresh
            ? !OUTSIDE.test(specifier!)
            : /^@ohmail\/(ui\/(base|mail|calendar)|tokens\/design)/.test(specifier!)
        )
          out.push(`${file}: ${specifier}`);
        continue;
      }
      const to = normalize(join(dirname(file), specifier!)).split("/")[0]!;
      if (fresh ? !fresh.includes(to) : to in BELOW) out.push(`${file}: ${specifier}`);
    }
  }
  return out.sort();
}

describe("the new components and today's", () => {
  it("import nothing of each other", () => {
    expect(tree.size).toBeGreaterThan(100);
    expect(crossings(tree)).toEqual([]);
  });

  it("a crossing is found in either direction, and so is the engine, a catalogue or the host", () => {
    const planted = new Map([
      ...tree,
      [
        "base/Planted.tsx",
        'import { Button } from "../primitives/Button.js";\nimport { engine } from "@ohmail/client-engine";\nimport en from "../../../../apps/webapp/messages/en.json";\n',
      ],
      ["base/planted.css", '@import "@ohmail/tokens/tokens.css";\n'],
      ["base/Upward.tsx", 'import { Rail } from "../mail/index.js";\n'],
      [
        "mail/Upward.tsx",
        'import { TimeGrid } from "../calendar/Grids/TimeGrid.js";\nimport { useTheme } from "../theme/ThemeProvider.js";\n',
      ],
      [
        "composites/Planted.tsx",
        'import { Menu } from "../base/index.js";\nimport "@ohmail/tokens/design.css";\n',
      ],
      ["index.ts", 'export * from "./base/index.js";\n'],
    ]);
    const before = new Set(crossings(tree));
    expect(crossings(planted).filter((line) => !before.has(line))).toEqual([
      "base/Planted.tsx: ../../../../apps/webapp/messages/en.json",
      "base/Planted.tsx: ../primitives/Button.js",
      "base/Planted.tsx: @ohmail/client-engine",
      "base/Upward.tsx: ../mail/index.js",
      "base/planted.css: @ohmail/tokens/tokens.css",
      "composites/Planted.tsx: ../base/index.js",
      "composites/Planted.tsx: @ohmail/tokens/design.css",
      "index.ts: ./base/index.js",
      "mail/Upward.tsx: ../calendar/Grids/TimeGrid.js",
      "mail/Upward.tsx: ../theme/ThemeProvider.js",
    ]);
  });
});
