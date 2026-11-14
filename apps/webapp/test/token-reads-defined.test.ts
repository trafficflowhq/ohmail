import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * EVERY `var(--x)` A STYLESHEET READS IS DEFINED, and a theme token is defined for every theme.
 * `--danger-ink` was read at three sites behind a `var(--ink2)` fallback and declared nowhere, so
 * three warnings rendered in muted secondary ink and nothing said so. A read is DEFINED when a
 * stylesheet in the domain declares the name or the code sets it (a `"--x"` literal); a name only
 * the tokens declare must sit in paper's base block, which every theme and face inherits, or ride
 * the ohmarchy face alone with a fallback at every read. KNOWN_UNDEFINED is a ratchet: it may only fall.
 */
const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const DOMAIN = ["apps/webapp/app", "packages/app-logic/src", "packages/ui/src", "packages/tokens/src"];
const TOKENS = "packages/tokens/src/tokens.css";
const FACE = "packages/tokens/src/ohmarchy.css";

/** Reads with no declaration anywhere, before this census existed. Each is a gap row, never a new entry. */
const KNOWN_UNDEFINED = new Set([
  "--accent-soft-ink", "--bg", "--bg2", "--ink1", "--line", "--mono", "--r-control", "--warn-ground", "--warn-line",
]);

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== "node_modules") walk(p, out); } else out.push(p);
  }
  return out;
};
/* The new design's files are not loaded beside the views this census reads (the tokens package's
   design-not-yet-imported test holds that), so what they declare defines nothing here. Their own
   reads are held by the tokens package's design-one-source test. */
const NEW_DESIGN = ["packages/tokens/src/design/", "packages/ui/src/icons/", "packages/ui/src/motion/"];
const files = DOMAIN.flatMap((d) => walk(join(ROOT, d))).map((f) => relative(ROOT, f).replace(/\\/g, "/"))
  .filter((f) => !NEW_DESIGN.some((dir) => f.startsWith(dir)));
const text = (f: string): string => readFileSync(join(ROOT, f), "utf8");
const css = (f: string): string => text(f).replace(/\/\*[\s\S]*?\*\//g, "");
const declared = (s: string): Set<string> => new Set([...s.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));

/** The base block's body: `:root, [data-theme="light"]{…}`, brace-matched. */
function baseBlock(s: string): string {
  const at = s.search(/(^|\n):root\s*,\s*\[data-theme="light"\]\s*\{/);
  if (at < 0) throw new Error("the paper base block was not found in tokens.css");
  const open = s.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === "{") depth += 1;
    else if (s[i] === "}" && --depth === 0) return s.slice(open + 1, i);
  }
  throw new Error("unbalanced braces in tokens.css");
}

const stylesheets = files.filter((f) => f.endsWith(".css"));
const reads = new Map<string, { at: string; fallback: boolean }[]>();
for (const f of stylesheets) {
  for (const m of css(f).matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
    const list = reads.get(m[1]!) ?? [];
    list.push({ at: f, fallback: m[2] !== undefined });
    reads.set(m[1]!, list);
  }
}
const component = new Set<string>();
for (const f of stylesheets) if (f !== TOKENS && f !== FACE) for (const n of declared(css(f))) component.add(n);
for (const f of files.filter((x) => /\.(tsx?|mjs)$/.test(x))) for (const m of text(f).matchAll(/["'`](--[\w-]+)["'`]/g)) component.add(m[1]!);
const paperBase = declared(baseBlock(css(TOKENS)));
const paperAny = declared(css(TOKENS));
const face = declared(css(FACE));

describe("the stylesheets' token reads", () => {
  it("reads something: the census is not empty, and the base block holds the ink it compares", () => {
    expect(reads.size).toBeGreaterThan(50);
    expect(paperBase.has("--ink2")).toBe(true);
  });

  it("every read is declared somewhere, or is a known undefined read", () => {
    const undefinedReads = [...reads.keys()]
      .filter((n) => !component.has(n) && !paperAny.has(n) && !face.has(n) && !KNOWN_UNDEFINED.has(n))
      .map((n) => `${n} (read at ${[...new Set(reads.get(n)!.map((r) => r.at))].join(", ")})`);
    expect(undefinedReads).toEqual([]);
  });

  it("a token read resolves under every theme: in paper's base block, or face-only with a fallback at each read", () => {
    const unresolved = [...reads.keys()]
      .filter((n) => !component.has(n) && (paperAny.has(n) || face.has(n)) && !paperBase.has(n))
      .filter((n) => paperAny.has(n) || reads.get(n)!.some((r) => !r.fallback));
    expect(unresolved).toEqual([]);
  });

  it("the known undefined reads are still undefined and still read (the list may only fall)", () => {
    const stale = [...KNOWN_UNDEFINED].filter((n) => !reads.has(n) || component.has(n) || paperAny.has(n) || face.has(n));
    expect(stale).toEqual([]);
  });
});
