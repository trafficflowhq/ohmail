/**
 * ═══ EVERY STEPPED SIZE READS THE SLOT, AND NOTHING ELSE DOES ══════════════════════════════
 *
 * The phone type step is one pixel added to every text role between 10.5px and 15.5px at phone
 * width. The mechanism is a token slot: the literal stays where it is and gains
 * `+ var(--type-up)`, so there is exactly ONE declaration per size and the step is decided in one
 * place (`base.css`'s width block) rather than in 380 of them.
 *
 * That only holds while every declaration actually carries the slot. 366 of them were rewritten by
 * a codemod, which is precisely the kind of change that misses a handful and looks finished — and
 * a missed declaration is invisible: the page renders, one line is a pixel smaller than the line
 * beside it, and no test in the suite has an opinion. This is the test with the opinion.
 *
 * ── THE THREE RULES ─────────────────────────────────────────────────────────────────────────
 *
 *  1. every `font-size` literal ≤ 15.5px carries `var(--type-up)` — unless its selector is
 *     allowlisted, because a mark, an avatar initial and a keycap are not reading text;
 *  2. every text CONTROL carries `var(--input-floor)` instead — iOS zooms the page when a focused
 *     control is under 16px, so those are floored rather than stepped;
 *  3. nothing at 16px or above carries either — the band has a top, and a step applied above it
 *     would be a second, unruled decision.
 *  4. no `font-size` is typed into a COMPONENT at all — a size in a JSX style object is not a
 *     declaration this census can see, does not carry the slot, and cannot be found by reading
 *     the stylesheets. Zero today, so it is a fence rather than a cleanup.
 *
 * ── THE ALLOWLIST IS NAMED, NOT INFERRED ────────────────────────────────────────────────────
 *
 * A census that skipped whatever it could not classify would pass over exactly the declarations
 * most likely to be wrong. Each exemption is a selector written out here with its reason, and rule
 * 1 fails for anything else — including, deliberately, the wordmark: stepping the brand by a pixel
 * on phones is the kind of change nobody would notice until it shipped.
 */
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative, sep } from "node:path";

const ROOT = [resolve(__dirname, "..", "..", ".."), resolve(__dirname, "..", "..")]
  .find((r) => existsSync(resolve(r, "packages/ui/src/base.css")))!;

/**
 * THE STYLESHEETS THE SHELL ACTUALLY LOADS, derived — not a list somebody keeps up to date.
 *
 * This was thirty-seven paths typed out here, and a hand-maintained list is a guard that passes
 * by omission: a new stylesheet is covered only if whoever added it also remembered to add it
 * HERE, and nothing fails when they do not. Two files were found missing from it at once, which
 * is the measurement that ended the list — the census had been reporting a clean phone type step
 * while a date picker and a sort control sat at their desktop sizes on every phone.
 *
 * So the set comes from the import graph instead: every `import "….css"` in the shell's own
 * source, resolved to a real file. A stylesheet nobody imports is not on a screen, and a
 * stylesheet the shell imports cannot escape this census by being forgotten.
 *
 * THE MARKETING TREE IS EXCLUDED, and that is a design decision rather than an oversight: the
 * landing pages are their own typographic system, sized for a poster rather than for a mail
 * client's chrome, and stepping them would be a redesign. It is named in code here so the
 * exclusion is visible to whoever reads a passing run. The branded 404's stylesheet joins it: the page
 * moved into `(product)` so every build carries it, and it keeps the website's poster type it was
 * designed in rather than taking the shell's step.
 */
const EXCLUDED_TREES = ["apps/webapp/app/(marketing)/", "apps/webapp/app/(product)/not-found.css"];

/**
 * THE PARSER FINDS THE IMPORTS, not a regex.
 *
 * The regex this replaces read `import "….css"` out of the source text, which meant it saw only
 * that one spelling and saw it wherever it appeared — including, in principle, inside a comment
 * or a string. It also treated every specifier as a relative path and silently CONTINUED when the
 * file did not exist, so the three token stylesheets imported by package name
 * (`@ohmail/tokens/tokens.css`, `faces.css`, `ohmarchy.css`) were dropped without a word. They
 * carry no offending size today, which is exactly how a hole like that stays open.
 *
 * `ts.createSourceFile` answers both: an ImportDeclaration is an import wherever it sits and a
 * comment is not one, and a specifier that fails to resolve is REPORTED rather than skipped.
 *
 * A WORKSPACE STYLESHEET IS FOUND THROUGH ITS PACKAGE'S OWN `exports`, as a bundler finds it, so
 * the census reads the file the screen loads and not a guess at the folder. A subpath the map does
 * not name, or names with anything but one file, does not resolve and is reported.
 */
const WORKSPACE_PACKAGES: ReadonlyArray<readonly [name: string, dir: string]> = [
  ["@ohmail/tokens", "packages/tokens"],
];

function resolveSpecifier(spec: string, fromFile: string): string | null {
  if (spec.startsWith(".")) return resolve(dirname(fromFile), spec);
  for (const [name, dir] of WORKSPACE_PACKAGES) {
    if (!spec.startsWith(`${name}/`)) continue;
    const manifest = JSON.parse(readFileSync(resolve(ROOT, dir, "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
    };
    const target = manifest.exports?.[`.${spec.slice(name.length)}`];
    return typeof target === "string" ? resolve(ROOT, dir, target) : null;
  }
  return null;
}

function shellStylesheets(): { files: string[]; unresolved: string[] } {
  const roots = ["apps/webapp/app", "packages/ui/src"];
  const found = new Set<string>();
  const unresolved: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist") continue;
      const full = resolve(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(name) || /\.(test|spec)\./.test(name)) continue;
      const sf = ts.createSourceFile(full, readFileSync(full, "utf8"), ts.ScriptTarget.Latest, true);
      const consider = (spec: string): void => {
        if (!spec.endsWith(".css")) return;
        const target = resolveSpecifier(spec, full);
        if (target === null || !existsSync(target)) {
          unresolved.push(`${relative(ROOT, full)} imports ${spec}`);
          return;
        }
        const rel = relative(ROOT, target).split(sep).join("/");
        if (EXCLUDED_TREES.some((t) => rel.startsWith(t))) return;
        found.add(rel);
      };
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          consider(node.moduleSpecifier.text);
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
          consider((node.arguments[0] as ts.StringLiteralLike).text);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  };
  for (const root of roots) walk(resolve(ROOT, root));
  return { files: [...found].sort(), unresolved };
}

const SHEETS = shellStylesheets();
const FILES = SHEETS.files;


/**
 * Selectors that must NOT take the step.
 *  · `kbd` and its three overrides — a keycap is a glyph sized to its box, not prose.
 *  · `.av*` — avatar initials are sized to the circle they sit in.
 *  · `.wordmark` — the brand is a mark. A pixel of drift on phones only is worse than none.
 *  · `.rte-b` — 16px, outside the band entirely; named so the reason is on the record.
 *  · `.unsaved-glyph` — a bold `!` centred in a 16×16px circle. The circle is a fixed box
 *    and the character is sized to fill it, so a pixel of step would crowd it rather than
 *    making anything easier to read — the same reasoning as `.av`. The strip's own copy
 *    beside it (`.unsaved`) IS reading text and does take the step.
 */
const ALLOW = [/(^|,)\s*kbd\s*$/, /\.abar kbd/, /\.dbtn kbd/, /\.decide \.dbtn kbd/,
  /\.av\b/, /\.wordmark/, /\.rte-b/, /\.unsaved-glyph/];
/** Text controls: floored, not stepped. */
/* `select` IS A TEXT CONTROL for this rule's purpose: iOS zooms the page on focus for a select
   under 16px exactly as it does for an input, and the classifier did not know the word. */
const CONTROL = /input|textarea|select|contenteditable|\.c-input|\.search-box|\.palette|\.ritem-new-input|\.set-field/;

interface Decl { file: string; sel: string; px: number; text: string }

function declarations(): Decl[] {
  const out: Decl[] = [];
  for (const rel of FILES) {
    const p = resolve(ROOT, rel);
    const src = readFileSync(p, "utf8");
    for (const m of src.matchAll(/font-size:[^;}]*/g)) {
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(m[0])?.[1] ?? NaN);
      if (Number.isNaN(px)) continue;
      /* The selector of the rule this declaration is IN — the opening brace before it, then back to
         the boundary before that. "Everything since the last }" sweeps in the comments above the
         declaration, and an allowlist pattern matching a COMMENT skips a real declaration. */
      const at = m.index!;
      const brace = src.lastIndexOf("{", at);
      const bound = Math.max(src.lastIndexOf("}", brace), src.lastIndexOf("{", brace - 1),
        src.lastIndexOf("*/", brace));
      out.push({ file: rel, sel: src.slice(bound + 1, brace).trim(), px, text: m[0] });
    }
  }
  return out;
}

const decls = declarations();

describe("the phone type step reaches every stepped size", () => {
  it("reads the stylesheets at all", () => {
    // Anti-vacuity: a moved file would make every rule below pass over nothing.
    /* 44 today, against 37 in the list this replaced. The bound is a floor on the DERIVATION,
       not a count to keep updated: it catches a resolver that silently stopped finding imports,
       which is the way this check would go quiet without failing. */
    expect(FILES.length, "the import walk found almost nothing — the census would pass over everything")
      .toBeGreaterThan(40);
    /* AN IMPORT THAT DOES NOT RESOLVE IS A HOLE, NOT A SHRUG. The regex this replaced treated
       every specifier as relative and CONTINUED when the file was missing, which silently dropped
       the three token stylesheets imported by package name. Reporting it is what turns a silent
       gap into a failing line. */
    expect(SHEETS.unresolved, "a stylesheet import did not resolve, so it is outside the census")
      .toEqual([]);
    /* A STYLESHEET REACHED THROUGH ANOTHER ONE WOULD BE INVISIBLE HERE. The walk follows imports
       from TS/TSX and nothing else, so a `@import` inside a stylesheet — or a `.css` pulled in by
       `require` — would bring rules onto the screen that this census never reads. There are none
       today, and this is what stops that from becoming true quietly: the day one appears, this
       fails and says to teach the walk rather than leaving a silent gap. */
    const viaCss: string[] = [];
    for (const rel of FILES) {
      const text = readFileSync(resolve(ROOT, rel), "utf8");
      if (/^\s*@import\b/m.test(text)) viaCss.push(`${rel} uses @import`);
    }
    expect(viaCss, "a stylesheet pulls in another one, which the import walk cannot see")
      .toEqual([]);
    expect(decls.length, "no font-size declarations found").toBeGreaterThan(300);
  });

  it("every size in the band carries the slot, or is named in the allowlist", () => {
    const missed = decls
      .filter((d) => d.px <= 15.5)
      .filter((d) => !ALLOW.some((re) => re.test(d.sel)))
      .filter((d) => !CONTROL.test(d.sel))
      .filter((d) => !d.text.includes("var(--type-up)"))
      .map((d) => `${d.file} ${d.sel} ${d.px}px`);
    expect(
      missed,
      `${missed.join("; ")} — in the stepped band and not reading \`--type-up\`. One declaration `
        + "per size: add the slot, or name the selector in ALLOW with its reason.",
    ).toEqual([]);
  });

  it("every text control is floored rather than stepped", () => {
    const missed = decls
      .filter((d) => d.px <= 15.5 && CONTROL.test(d.sel))
      .filter((d) => !d.text.includes("var(--input-floor)"))
      .map((d) => `${d.file} ${d.sel} ${d.px}px`);
    expect(
      missed,
      `${missed.join("; ")} — a text control under 16px makes iOS zoom the page on focus. `
        + "Use max(var(--input-floor), calc(<n>px + var(--type-up))).",
    ).toEqual([]);
  });

  it("nothing at 16px or above takes either slot — the band has a top", () => {
    const over = decls
      .filter((d) => d.px >= 16 && (d.text.includes("--type-up") || d.text.includes("--input-floor")))
      .map((d) => `${d.file} ${d.sel} ${d.px}px`);
    expect(over, `${over.join("; ")} — above the band, so the step is not theirs to take`).toEqual([]);
  });

  it("THE WORDMARK IS NOT STEPPED, named rather than left to the allowlist's shape", () => {
    /* Called out on its own because it is the exemption a codemod is most likely to eat and the
       one nobody would catch by looking: a brand mark one pixel larger on phones reads as correct. */
    const mark = decls.find((d) => /\.wordmark/.test(d.sel));
    expect(mark, "the wordmark declaration moved — this case is now vacuous").toBeTruthy();
    expect(mark!.text, "the wordmark took the phone step").not.toContain("--type-up");
  });

  it("the slot is declared once, and the width is what decides it", () => {
    const base = readFileSync(resolve(ROOT, "packages/ui/src/base.css"), "utf8");
    expect(base).toMatch(/@media \(max-width: 640px\)\{\s*\.mo-canvas\{ --type-up:1px; --input-floor:16px \}/);
    const faces = readFileSync(resolve(ROOT, "packages/tokens/src/faces.css"), "utf8");
    // Paper's defaults are what keep the desktop byte-identical.
    expect(faces).toContain("--type-up: 0px;");
    expect(faces).toContain("--input-floor: 0px;");
  });
});

/**
 * ── RULE 4: THE SIZE IS IN THE STYLESHEET, NEVER IN THE COMPONENT ───────────────────────────
 *
 * Rules 1-3 read the stylesheets, so they are blind by construction to a size written in TSX:
 * `style={{ fontSize: 13 }}` on a JSX element renders at 13px on every phone, takes no slot,
 * appears in no stylesheet, and is invisible to every case above. There are none today — this
 * exists so that stays true, because the first one would be added by someone reaching for a
 * one-off and would never be found by looking at CSS.
 *
 * The phone app learned this the expensive way: the same shape, `fontSize: 12` typed beside a
 * `pileTitle`, sat one point under the capsule it shares a row with until a census read the tree.
 *
 * THE PARSER ANSWERS THE RIGHT QUESTION. A text search for `fontSize` also finds
 * `getComputedStyle(el).fontSize` — a READ of what the stylesheet already decided, which is the
 * correct way to measure and exactly what `SegmentedControl.tsx` does. A property ACCESS is not a
 * property ASSIGNMENT, and only `ts.createSourceFile` can tell them apart.
 */
function shellSources(): string[] {
  const roots = ["apps/webapp/app", "packages/ui/src"];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist") continue;
      const full = resolve(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(name) || /\.(test|spec)\./.test(name)) continue;
      const rel = relative(ROOT, full).split(sep).join("/");
      /* Marketing is excluded here for the same reason it is excluded above, and it is worth
         saying twice: those pages are a poster's typography, not the mail client's chrome. */
      if (EXCLUDED_TREES.some((t) => rel.startsWith(t))) continue;
      out.push(rel);
    }
  };
  for (const root of roots) walk(resolve(ROOT, root));
  return out.sort();
}

const SOURCES = shellSources();

function inlineSizes(): string[] {
  const out: string[] = [];
  for (const rel of SOURCES) {
    const p = resolve(ROOT, rel);
    const sf = ts.createSourceFile(p, readFileSync(p, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
        const name = node.name;
        const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
        if (key === "fontSize") {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          out.push(`${rel}:${line} ${node.getText(sf).replace(/\s+/g, " ")}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

describe("no size is typed into a component", () => {
  it("reads the components at all", () => {
    /* Anti-vacuity, same shape as the stylesheet walk: 265 today, and the bound is a floor on the
       WALK. A rule with nothing to check is a rule that reports clean for ever. */
    expect(SOURCES.length, "the source walk found almost nothing — rule 4 covers nothing")
      .toBeGreaterThan(200);
    /* AND THE PARSER MUST BE ABLE TO SEE A SIZE AT ALL. If `fontSize` were mis-spelled here, or
       the visitor never reached an object literal, the rule would pass on a tree full of them.
       This drives the exact predicate over a synthetic source and requires a hit. */
    const probe = ts.createSourceFile("probe.tsx", "const s = { fontSize: 13 };",
      ts.ScriptTarget.Latest, true);
    let seen = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)
        && node.name.text === "fontSize") seen += 1;
      ts.forEachChild(node, visit);
    };
    visit(probe);
    expect(seen, "the predicate cannot see a fontSize property — rule 4 cannot fail").toBe(1);
  });

  it("no component assigns a fontSize — the stylesheet decides every size", () => {
    const inline = inlineSizes();
    expect(
      inline,
      `${inline.join("; ")} — a size in a style object takes no slot and no phone step. Put it in `
        + "the stylesheet as `calc(<n>px + var(--type-up))`, where this census can read it.",
    ).toEqual([]);
  });
});
