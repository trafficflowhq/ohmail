import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * EVERY DARK RULE APPLIES UNDER AUTO IN A DARK OS. The Auto theme stamps no `data-theme`, so a
 * rule keyed on `[data-theme="dark"]` alone leaves an Auto reader in a dark OS on the light value
 * (the sync strip's link read 1.18:1). One shape for the twin, the token layer's own: inside
 * `@media (prefers-color-scheme: dark)`, the stamp becomes `:not([data-theme="light"]):not(
 * [data-theme="dark"])` on the root, with the same declarations. A stamp on a SUBTREE (`X
 * [data-theme="dark"]`) is a forced island and needs none. String-level: jsdom has no media.
 */

const ROOTS = ["../app", "../../../packages/app/src", "../../../packages/ui/src", "../../../packages/tokens/src"]
  .map((r) => fileURLToPath(new URL(r, import.meta.url)));
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const STAMP = '[data-theme="dark"]';
const AUTO = ':not([data-theme="light"]):not([data-theme="dark"])';
const DARK_MEDIA = /^@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)$/;

interface Rule { selectors: string[]; decls: string[]; media: string[]; file: string }

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "node_modules") return [];
    return statSync(p).isDirectory() ? cssFiles(p) : name.endsWith(".css") ? [p] : [];
  });
}

/** Style rules with the at-rule groups around them; keyframes and font faces are skipped. */
function rulesOf(css: string, file: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  const stack: string[] = [];
  let i = 0;
  let start = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "}") { stack.pop(); start = i + 1; }
    else if (ch === ";" ) { start = i + 1; }
    else if (ch === "{") {
      const prelude = text.slice(start, i).trim().replace(/\s+/g, " ");
      if (/^@(media|supports|container|layer)\b/.test(prelude)) { stack.push(prelude); start = i + 1; }
      else {
        const end = text.indexOf("}", i);
        if (!/^@(keyframes|font-face)\b/.test(prelude) && !/^(from|to|\d+%)/.test(prelude)) {
          out.push({
            selectors: prelude.split(",").map((s) => s.trim()).filter(Boolean),
            decls: text.slice(i + 1, end).split(";").map((d) => d.trim().replace(/\s+/g, " ")).filter(Boolean),
            media: [...stack],
            file,
          });
        }
        if (/^@keyframes\b/.test(prelude)) {
          let depth = 0;
          for (let j = i; j < text.length; j += 1) {
            if (text[j] === "{") depth += 1;
            if (text[j] === "}") { depth -= 1; if (depth === 0) { i = j; break; } }
          }
        } else i = end;
        start = i + 1;
      }
    }
    i += 1;
  }
  return out;
}

/** The Auto twin of one dark selector, or null for a subtree stamp that needs none. */
function autoTwin(selector: string): string | null {
  const at = selector.indexOf(STAMP);
  if (at < 0) return null;
  const firstCompound = selector.split(/[\s>+~]+/)[0]!;
  if (!firstCompound.includes(STAMP)) return null;
  const head = firstCompound.replace(STAMP, "");
  return (head === "" ? ":root" : head) + AUTO + selector.slice(firstCompound.length);
}

/** Every dark rule outside a dark media block that has no same-file twin with the same declarations. */
function missingTwins(rules: Rule[]): string[] {
  const inDark = (r: Rule) => r.media.some((m) => DARK_MEDIA.test(m));
  const twins = rules.filter(inDark);
  const missing: string[] = [];
  for (const r of rules) {
    if (inDark(r) || !r.selectors.some((s) => s.includes(STAMP))) continue;
    for (const want of r.selectors.map(autoTwin).filter((s): s is string => s !== null)) {
      const ok = twins.some((t) => t.file === r.file && t.selectors.includes(want)
        && t.media.filter((m) => !DARK_MEDIA.test(m)).join("|") === r.media.join("|")
        && JSON.stringify(t.decls) === JSON.stringify(r.decls));
      if (!ok) missing.push(`${relative(REPO, r.file)}: ${r.selectors.join(", ")} → wants ${want}`);
    }
  }
  return missing;
}

const all = ROOTS.flatMap(cssFiles).flatMap((f) => rulesOf(readFileSync(f, "utf8"), f));

describe("every dark rule has its Auto twin", () => {
  it("reads the dark rules of the three stylesheet roots (positive control)", () => {
    const dark = all.filter((r) => r.selectors.some((s) => s.includes(STAMP)));
    const files = new Set(dark.map((r) => relative(REPO, r.file)));
    // The token layer, the ohmarchy face, the avatar and the shell each carry dark rules.
    for (const f of ["packages/tokens/src/tokens.css", "packages/tokens/src/ohmarchy.css",
      "packages/ui/src/primitives/avatar.css", "apps/webapp/app/app.css"]) {
      expect(files.has(f), `no dark rule read in ${f}`).toBe(true);
    }
    expect(dark.length).toBeGreaterThanOrEqual(15);
  });

  it("a dark rule with no twin, or a twin with other declarations, is refused (negative control)", () => {
    const planted = rulesOf(
      '.x a{color:red}[data-theme="dark"] .x a{color:blue}'
      + '[data-theme="dark"] .y{color:blue}@media (prefers-color-scheme: dark){'
      + ':root:not([data-theme="light"]):not([data-theme="dark"]) .y{color:green}}'
      + '.z [data-theme="dark"] .w{color:blue}',
      join(REPO, "planted.css"),
    );
    expect(missingTwins(planted)).toEqual([
      'planted.css: [data-theme="dark"] .x a → wants :root:not([data-theme="light"]):not([data-theme="dark"]) .x a',
      'planted.css: [data-theme="dark"] .y → wants :root:not([data-theme="light"]):not([data-theme="dark"]) .y',
    ]);
  });

  it("the twin shape: the stamp on the root, on an attached compound, and a subtree stamp", () => {
    expect(autoTwin('[data-theme="dark"]')).toBe(':root:not([data-theme="light"]):not([data-theme="dark"])');
    expect(autoTwin('[data-face="ohmarchy"][data-theme="dark"]'))
      .toBe('[data-face="ohmarchy"]:not([data-theme="light"]):not([data-theme="dark"])');
    expect(autoTwin('[data-theme="dark"] .sync-bar a:hover'))
      .toBe(':root:not([data-theme="light"]):not([data-theme="dark"]) .sync-bar a:hover');
    expect(autoTwin('[data-face="ohmarchy"] [data-theme="dark"]')).toBeNull();
  });

  it("no dark rule in the shipped stylesheets is missing its Auto twin", () => {
    expect(missingTwins(all)).toEqual([]);
  });
});
