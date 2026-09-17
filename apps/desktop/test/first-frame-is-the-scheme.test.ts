/**
 * THE FIRST FRAME IS THE PERSON'S FACE AND SCHEME.
 *
 * The window's stamps used to ride the app bundle, which the document loads as a MODULE script,
 * and module scripts are deferred: they ran after the document had parsed, one paint late.
 * Measured on the Omarchy guest against the released 0.19.1 AppImage (2026-09-17): the window
 * held #fafaf9 — the PAPER face's light canvas — for 278 ms before the ohmarchy face's own
 * canvas arrived, on a desktop where the app picks the ohmarchy face for itself.
 *
 * Two properties are asked here, and each has a mutation that reddens it:
 *
 *  1. the head loads the stamp as a BLOCKING script — adding `type="module"`, `defer` or
 *     `async` to that tag puts the frame back;
 *  2. NOTHING paint-blocking reaches the mapping law or React — the import closure of
 *     `boot-stamp.ts` is walked here, so an import added to it or to anything it reaches is
 *     refused by name rather than discovered as a slow launch.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const at = (p: string): string => resolve(__dirname, p);
const read = (p: string): string => readFileSync(at(p), "utf8");

/** The `<script>` tags of the document head, in order, with their attributes. */
function headScripts(html: string): { src: string; attrs: string }[] {
  const head = /<head>([\s\S]*?)<\/head>/i.exec(html);
  expect(head, "index.html has no head").not.toBeNull();
  return [...head![1].matchAll(/<script([^>]*)>/gi)].map((m) => ({
    attrs: m[1],
    src: /\ssrc="([^"]+)"/.exec(m[1])?.[1] ?? "",
  }));
}

describe("the pre-paint stamp is a blocking script in the head", () => {
  it("the head loads boot-stamp.js with no module, defer or async attribute", () => {
    const scripts = headScripts(read("../index.html"));
    const stamp = scripts.filter((s) => s.src.endsWith("boot-stamp.js"));
    expect(stamp.length, "the head names exactly one boot-stamp.js").toBe(1);
    /* The three spellings that would defer it. Each is the mutation for this case. */
    expect(stamp[0].attrs).not.toMatch(/\stype="module"/);
    expect(stamp[0].attrs).not.toMatch(/\sdefer\b/);
    expect(stamp[0].attrs).not.toMatch(/\sasync\b/);
  });

  it("the app bundle is NOT in the head — the blocking script is the only one there", () => {
    /* Vite injects the entry module script into the head at build time; in the source document
       it sits in the body, and the stamp is the head's only script. A second blocking script
       here would be a second thing holding the paint. */
    const scripts = headScripts(read("../index.html"));
    expect(scripts.map((s) => s.src)).toEqual(["./boot-stamp.js"]);
    expect(read("../index.html")).toMatch(/<script type="module" src="\.\/src\/main\.tsx">/);
  });

  it("the stamp is no longer in main.tsx, which is the deferred half", () => {
    const main = read("../src/main.tsx");
    expect(main).not.toContain('localStorage.getItem("ohmail.theme")');
    expect(main).not.toContain("paintCachedOmarchyPalette");
    const stamp = read("../src/boot-stamp.ts");
    expect(stamp).toContain('localStorage.getItem("ohmail.theme")');
    expect(stamp).toContain("paintCachedOmarchyPalette()");
  });

  it("the policy admits it: a same-origin script, and no inline script anywhere", () => {
    /* An inline stamp is the usual shape and is not available here: `script-src 'self'` would
       need a hash kept in step with the file in BOTH policy homes. If somebody widens the
       policy to take an inline one, this case says so. */
    const html = read("../index.html");
    expect(html).toContain("script-src 'self';");
    /* Bounded at the directive's own `;` — `style-src` further along the same attribute
       carries 'unsafe-inline' legitimately, and an unbounded match reads it as this one's. */
    expect(html).not.toMatch(/script-src[^;"]*'unsafe-inline'/);
    const head = /<head>([\s\S]*?)<\/head>/i.exec(html)![1];
    expect(head).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/script>/i);
  });
});

/* ── the split: what the blocking path may reach ─────────────────────────────────────── */

/** Resolve one import specifier to a file in this repository, or null for a bare package. */
function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // a bare package: classified by name, not walked
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    base,
    `${base}.ts`,
    `${base}.tsx`,
  ]) {
    if (existsSync(candidate) && !candidate.endsWith("/")) return candidate;
  }
  return null;
}

/** Every module the given entry reaches statically, plus every bare package it names. */
function importClosure(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const src = readFileSync(file, "utf8");
    const specs = [
      ...src.matchAll(/^\s*import\s[^'"]*from\s*["']([^"']+)["']/gm),
      ...src.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
      ...src.matchAll(/^\s*export\s[^'"]*from\s*["']([^"']+)["']/gm),
    ].map((m) => m[1]);
    for (const spec of specs) {
      const resolved = resolveImport(file, spec);
      if (resolved === null) packages.add(spec.replace(/^(@[^/]+\/[^/]+|[^@/][^/]*).*$/, "$1"));
      else queue.push(resolved);
    }
  }
  return { files, packages };
}

describe("the mapping law and React are not in the paint-blocking path", () => {
  const closure = importClosure(at("../src/boot-stamp.ts"));

  it("the closure is real — the stamp reaches the paint half and the rule builder", () => {
    /* The positive control: a walk that resolved nothing would pass every refusal below. */
    const reached = [...closure.files].map((f) => f.replace(/^.*\/(apps|packages)\//, "$1/"));
    expect(reached).toContain("apps/desktop/src/omarchy-paint.ts");
    expect(reached).toContain("packages/tokens/omarchy/rule.ts");
    expect(closure.files.size).toBeGreaterThanOrEqual(3);
  });

  it("nothing in it reaches the mapping law", () => {
    for (const file of closure.files) {
      expect(file, "the palette law is paint-blocking").not.toMatch(/omarchy\/(map|mapping)\./);
    }
    /* …and the feed module itself, which is what imports the law. */
    expect([...closure.files].some((f) => f.endsWith("/src/omarchy.ts"))).toBe(false);
  });

  it("nothing in it imports a package at all — no React, no framework", () => {
    expect([...closure.packages].sort()).toEqual([]);
  });

  it("the feed half DOES reach the law, so the split is a split and not a deletion", () => {
    const feed = importClosure(at("../src/omarchy.ts"));
    expect([...feed.files].some((f) => /omarchy\/map\.ts$/.test(f))).toBe(true);
  });
});
