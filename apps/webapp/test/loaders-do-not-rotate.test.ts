import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

/**
 * ═══ NOTHING THAT SAYS "WAITING" ROTATES ═════════════════════════════════════════════════
 *
 * The product has ONE loader, `@ohmail/ui`'s `Spinner`, and its sheet states the rule: a
 * segment travels the frame's perimeter while the frame itself holds still. The frame's corner
 * radius is the pill token, so under paper the rect IS a circle and under ohmarchy it is a
 * square — and a SQUARE THAT ROTATES reads as a spinning box, not as waiting. That is why the
 * primitive moves a dash offset along a `pathLength="100"` path instead of turning anything.
 *
 * The attachment strip had kept a second loader of its own: a bordered 10px ring under
 * `@keyframes att-spin { to { transform: rotate(360deg) } }`. Square under ohmarchy, rotating,
 * beside a sentence that already said what it was doing. The strip now renders the primitive.
 *
 * This census refuses the shape rather than the file: any `@keyframes` whose body turns
 * something, named by the `animation` of a rule whose selector calls itself a spinner. A local
 * ring is cheap to write and reads wrong on exactly one of the two faces, which is the kind of
 * defect that only a face nobody is looking at ever shows.
 */

const ROOTS = ["apps/webapp/app", "packages/app/src", "packages/ui/src"];

/** Blank every comment, keeping the byte count so a reported offset still means something. */
function stripComments(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    if (css[i] === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      const stop = end === -1 ? css.length : end + 2;
      for (let k = i; k < stop; k += 1) out += css[k] === "\n" ? "\n" : " ";
      i = stop;
      continue;
    }
    out += css[i];
    i += 1;
  }
  return out;
}

/**
 * Every `@keyframes` in the sheet, by name, with its body — and the sheet with those blocks
 * blanked out, so the rule scan below never reads a keyframe step as a selector.
 */
function keyframesOf(css: string): { bodies: Map<string, string>; rest: string } {
  const bodies = new Map<string, string>();
  let rest = css;
  const at = /@(?:-\w+-)?keyframes\s+([\w-]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = at.exec(css)) !== null) {
    let depth = 1;
    let i = at.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
      i += 1;
    }
    bodies.set(m[1]!, css.slice(at.lastIndex, i - 1));
    rest = rest.slice(0, m.index) + " ".repeat(i - m.index) + rest.slice(i);
  }
  return { bodies, rest };
}

/**
 * The sheet's rules as `(selector, declarations)`. The regex matches INNERMOST blocks, which is
 * what makes it correct inside `@media`: the media block's own braces hold another block, so the
 * rule that comes back is the inner `.a { … }` and never the `@media (…)` line.
 */
function rulesOf(css: string): Array<{ selector: string; decls: string }> {
  const out: Array<{ selector: string; decls: string }> = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(css)) !== null) {
    out.push({ selector: m[1]!.trim(), decls: m[2]! });
  }
  return out;
}

/** The animation names one declaration block asks for, in any of `animation`'s spellings. */
function animationNames(decls: string): string[] {
  const names: string[] = [];
  const decl = /(?:^|;)\s*animation(?:-name)?\s*:([^;]*)/g;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(decls)) !== null) {
    for (const part of m[1]!.split(",")) {
      for (const token of part.trim().split(/\s+/)) {
        if (/^[A-Za-z_-][\w-]*$/.test(token)) names.push(token);
      }
    }
  }
  return names;
}

export interface RotatingLoader {
  selector: string;
  keyframe: string;
}

/**
 * THE RULE, as a function over one sheet's text, so the positive control can be a string.
 *
 * A finding is a rule whose SELECTOR calls itself a spinner and whose animation names a
 * keyframe that TURNS something. Both halves are load-bearing: a rotation elsewhere is a
 * design decision (a disclosure caret, a refresh glyph that flips), and a waiting mark that
 * moves a dash offset is the primitive's own construction.
 */
export function rotatingLoaders(css: string): RotatingLoader[] {
  const { bodies, rest } = keyframesOf(stripComments(css));
  const turns = new Set<string>();
  for (const [name, body] of bodies) if (body.includes("rotate(")) turns.add(name);
  if (turns.size === 0) return [];
  const found: RotatingLoader[] = [];
  for (const { selector, decls } of rulesOf(rest)) {
    if (!/spin/i.test(selector)) continue;
    for (const name of animationNames(decls)) {
      if (turns.has(name)) found.push({ selector, keyframe: name });
    }
  }
  return found;
}

function sheetsUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules" && entry !== "dist") sheetsUnder(full, out);
    } else if (entry.endsWith(".css")) {
      out.push(full);
    }
  }
  return out;
}

/** The shape the strip shipped with, verbatim — the control that proves the census can refuse. */
const PRISTINE_ATTACHMENT_SPINNER = `
.att-spin {
  width: 10px;
  height: 10px;
  flex: none;
  border-radius:var(--r-pill);
  border: 1.5px solid var(--hair);
  border-top-color: var(--accent);
  animation: att-spin 1s linear infinite;
}

@keyframes att-spin { to { transform: rotate(360deg); } }
`;

describe("no loader rotates", () => {
  it("refuses the ring the attachment strip used to draw", () => {
    const found = rotatingLoaders(PRISTINE_ATTACHMENT_SPINNER);
    expect(found).toEqual([{ selector: ".att-spin", keyframe: "att-spin" }]);
  });

  it("admits the primitive, which moves a dash offset along the path", () => {
    const spinner = readFileSync(
      resolve(process.cwd(), "packages/ui/src/primitives/spinner.css"),
      "utf8",
    );
    expect(spinner).toContain("stroke-dashoffset");
    expect(rotatingLoaders(spinner)).toEqual([]);
  });

  it("admits a rotation that is not a loader", () => {
    const caret = `.disclosure[data-open]{animation:turn .2s ease}@keyframes turn{to{transform:rotate(90deg)}}`;
    expect(rotatingLoaders(caret)).toEqual([]);
  });

  it("finds no rotating loader in the app's or the package's sheets", () => {
    const files: string[] = [];
    for (const root of ROOTS) files.push(...sheetsUnder(resolve(process.cwd(), root)));
    expect(files.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const file of files) {
      for (const hit of rotatingLoaders(readFileSync(file, "utf8"))) {
        offenders.push(`${relative(process.cwd(), file)}: ${hit.selector} → @keyframes ${hit.keyframe}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
