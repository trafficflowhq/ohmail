/**
 * THE WORDMARK IS SPLIT ACROSS ELEMENTS, AND THAT IS WHY RENAMES MISS IT.
 *
 * Every surface paints the mark as two runs — one of them in accent-ink — so the
 * rail echoes the "oh." app mark. The source therefore reads `<em>oh</em>mail`,
 * never the brand as one string, and `grep -ri mailoh` over a tree that renders
 * "mailoh" on ten screens returns ZERO hits. That is not hypothetical: the
 * casing sweep missed it once, and the `mailoh → ohmail` rename missed it again
 * on ten surfaces while its commit message claimed the sweep was "verified by
 * grep". Exactly one surface was correct — `RailNav`, the only one with a test.
 *
 * So the audit works on what a PERSON READS, not on the markup that produces it:
 * the mark's inner markup is put into a real DOM and its `textContent` is
 * asserted. And because the original defect was a surface no test knew about,
 * {@link discoverMarks} re-derives the surface list from the tree on every run —
 * a new wordmark that nobody adds to a test file fails the completeness guard in
 * `test/wordmark-completeness.test.ts` rather than shipping unchecked.
 *
 * Only jsdom's `innerHTML` is used, so this needs no component to be mountable:
 * server components, non-exported subcomponents and static design HTML are all
 * reachable the same way. Components that CAN be rendered are additionally
 * rendered for real by their own app's test.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Walked up from the cwd rather than taken from `import.meta.url`: these tests
 * run under `@vitest-environment jsdom`, where `import.meta.url` is not a
 * `file:` URL and `fileURLToPath` throws.
 */
export const repoRoot = (() => {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(path.join(dir, "tsconfig.base.json"))) return `${dir}${path.sep}`;
    const up = path.dirname(dir);
    if (up === dir) throw new Error("repo root not found above " + process.cwd());
    dir = up;
  }
})();

/**
 * The class tokens that mean "this element is the ohmail wordmark".
 *
 * `l-wordmark` is deliberately absent: `apps/webapp/app/(product)/Wordmark.tsx`
 * writes the name as ONE unsplit string, so a plain grep already sees it, and its
 * class is assembled in a JSX expression rather than a literal attribute. It is
 * covered by a real render in the landing site's own wordmark test instead.
 */
export const MARK_CLASSES = ["wordmark", "oa-mark", "signin-mark", "l-plane-mark", "wm"] as const;

/**
 * Where a PRODUCT wordmark may live. Scoped on purpose:
 * `design/proposals/{naming,aero-blanc}` are boards of REJECTED names
 * (couvert, klarpost, TAKT, sieve, foyer, "TrafficFlow Mail") and are a
 * historical record — sweeping a brand across them would falsify the record.
 */
export const PRODUCT_DIRS = [
  "apps/webapp/app",
  "apps/admin/app",
  "packages/ui/src",
  "packages/ui/showcase",
  "design/proposals/blanc",
  "design/proposals/icon",
] as const;

const EXTENSIONS = [".tsx", ".html"];

export type Mark = {
  /** repo-relative path */
  file: string;
  /** 1-indexed line of the opening tag */
  line: number;
  /** the class attribute's literal value */
  classes: string;
  /** the element's inner markup, JSX comments stripped */
  markup: string;
};

/** Every file under `dir` (recursively) with a markup extension. */
function walk(dir: string, out: string[] = []): string[] {
  const abs = path.join(repoRoot, dir);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const rel = path.posix.join(dir, name);
    if (statSync(path.join(repoRoot, rel)).isDirectory()) walk(rel, out);
    else if (EXTENSIONS.some((e) => name.endsWith(e))) out.push(rel);
  }
  return out;
}

/**
 * The element that OWNS `attrIndex`, and its inner markup.
 *
 * Written by hand rather than with a regex because the mark nests tags of its
 * own name in principle and a regex cannot balance them. Walks back to the `<`
 * that opens the tag, forward past the opening tag (skipping quoted attribute
 * values), then matches nested `<name>`/`</name>` pairs down to depth 0.
 */
function elementAt(src: string, attrIndex: number): { name: string; inner: string } | null {
  const open = src.lastIndexOf("<", attrIndex);
  if (open < 0) return null;
  const nameMatch = /^<([A-Za-z][\w.]*)/.exec(src.slice(open, attrIndex + 1));
  if (!nameMatch) return null;
  const name = nameMatch[1];

  let i = attrIndex;
  let quote: string | null = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "/" && src[i + 1] === ">") return { name, inner: "" }; // self-closing
    if (c === ">") break;
  }
  if (i >= src.length) return null;

  const contentStart = i + 1;
  const closeTag = `</${name}>`;
  const openRe = new RegExp(`<${name}(?=[\\s/>])`, "g");
  let depth = 1;
  let cursor = contentStart;
  while (depth > 0) {
    openRe.lastIndex = cursor;
    const nextOpen = openRe.exec(src);
    const nextClose = src.indexOf(closeTag, cursor);
    if (nextClose < 0) return null;
    if (nextOpen && nextOpen.index < nextClose) {
      depth++;
      cursor = nextOpen.index + 1;
      continue;
    }
    depth--;
    if (depth === 0) return { name, inner: src.slice(contentStart, nextClose) };
    cursor = nextClose + closeTag.length;
  }
  return null;
}

/** `class="…"` / `className="…"` with a literal value. Expression classes are not marks here. */
const CLASS_ATTR = /\bclass(?:Name)?="([^"]*)"/g;

/** Every product wordmark in the tree, re-derived from the files on every run. */
export function discoverMarks(dirs: readonly string[] = PRODUCT_DIRS): Mark[] {
  const marks: Mark[] = [];
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      const src = readFileSync(path.join(repoRoot, file), "utf8");
      CLASS_ATTR.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CLASS_ATTR.exec(src))) {
        const classes = m[1].split(/\s+/);
        if (!classes.some((c) => (MARK_CLASSES as readonly string[]).includes(c))) continue;
        const el = elementAt(src, m.index);
        if (!el) throw new Error(`${file}: could not find the element that owns class="${m[1]}"`);
        marks.push({
          file,
          line: src.slice(0, m.index).split("\n").length,
          classes: m[1],
          // `{/* … */}` renders nothing. Any OTHER JSX expression is rejected by
          // renderedText, so dynamic text can never be silently skipped.
          markup: el.inner.replace(/\{\/\*[\s\S]*?\*\/\}/g, ""),
        });
      }
    }
  }
  return marks;
}

/** Marks belonging to one file or directory prefix. */
export function marksUnder(prefix: string): Mark[] {
  return discoverMarks().filter((mk) => mk.file === prefix || mk.file.startsWith(`${prefix}/`));
}

/**
 * What a person reads: the markup put into a real DOM, `textContent` taken, and
 * all whitespace removed (JSX collapses the indentation these marks are written
 * with, and the DOM does not). Requires a jsdom environment.
 */
export function renderedText(markup: string): string {
  const host = document.createElement("div");
  host.innerHTML = staticMarkup(markup);
  return (host.textContent ?? "").replace(/\s+/g, "");
}

/**
 * The markup a surface renders when nothing overrides it.
 *
 * One JSX expression is understood, and only one: `{prop ?? ( … )}`, the
 * overridable-mark idiom `RailNav` uses. Its DEFAULT branch is what every
 * client that does not pass the prop ships, so that is what is audited — and
 * `packages/ui/test/smoke.test.tsx` cross-checks the result against a real
 * React render of the same component, so this reduction is verified rather than
 * assumed. Any other expression throws: a mark whose text is genuinely dynamic
 * must be asserted by a real render, never silently skipped.
 */
function staticMarkup(markup: string): string {
  const fallback = /^\s*\{\s*[A-Za-z_$][\w$]*\s*\?\?\s*\(([\s\S]*)\)\s*\}\s*$/.exec(markup);
  const body = fallback ? fallback[1] : markup;
  if (/\{[^}]/.test(body)) {
    throw new Error(
      `the mark contains a JSX expression, so its text is not static: ${markup.trim()}\n` +
        "Assert this surface with a real render instead of the markup audit.",
    );
  }
  return body;
}

/**
 * The one invariant, stated once: the mark reads "ohmail" and never "mailoh".
 * Case-insensitive because the icon board's rejected concept C is title-case by
 * design ("the exclamation lives inside the capital O").
 */
/** Just enough of vitest's `expect` to state the assertion — see {@link assertReadsOhmail}. */
type Expect = (value: unknown, message?: string) => {
  toContain(expected: string): void;
  not: { toContain(expected: string): void };
};

export function assertReadsOhmail(mark: Mark, expect: Expect): void {
  const text = renderedText(mark.markup);
  const where = `${mark.file}:${mark.line} (class="${mark.classes}") renders "${text}"`;
  expect(text.toLowerCase(), where).toContain("ohmail");
  expect(text.toLowerCase(), where).not.toContain("mailoh");
}
