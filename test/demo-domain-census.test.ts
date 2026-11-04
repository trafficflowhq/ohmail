import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { getFixtures } from "@ohmail/fixtures";
import { DE } from "../apps/mobile/src/copy.de";
import { EN } from "../apps/mobile/src/copy.en";
import webDe from "../apps/webapp/messages/de.json";
import webEn from "../apps/webapp/messages/en.json";

/**
 * THE DEMO WORLD LIVES ON RESERVED NAMES, WHEREVER IT IS SPELLED.
 *
 * The demo world's domains are invented, and a `.ch` or `.it` spelling of one is a name somebody can
 * register: then a screenshot, a test or a catalogue line points at a real stranger. The fixtures moved
 * to reserved `.example` names, and a catalogue line kept the old `.ch` spelling because nothing read
 * the catalogues. So the names come from the corpus itself (every `<name>.example` host in
 * `getFixtures()`), and every string in the apps', the packages' and the root tests' tracked files is
 * read for one of them under a name that is not reserved (RFC 2606 / 6761: `.example`, `.invalid`,
 * `.test`, `.localhost`, or `example.com|net|org`). Parsed, not grepped: string literals, template
 * text, JSX text and JSON values; member access such as `wohnfalz.art` in code is not a host.
 *
 * Not read: `packages/fixtures/src`, the corpus, judged through `getFixtures()` below, and whose
 * naming registry spells the real namesakes a coined name was checked against, on purpose.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESERVED_TLD = new Set(["example", "invalid", "test", "localhost"]);
const RESERVED_DOMAIN = /(^|\.)example\.(com|net|org)$/;
const PARSED = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|snap)$/;
const TEXT = /\.(md|html|txt|eml|yml|yaml|toml|rs|kt|swift)$/;

function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

/** The registrable-position label of every `.example` host the demo world carries. */
function demoNames(): string[] {
  const names = new Set<string>();
  for (const s of stringsIn(getFixtures())) {
    for (const m of s.toLowerCase().matchAll(/([a-z0-9-]+)\.example(?![a-z0-9-])/g)) names.add(m[1]!);
  }
  return [...names].sort();
}

/** The string values a file carries, by its kind. */
function valuesOf(file: string, text: string): string[] {
  if (file.endsWith(".json")) {
    try {
      return stringsIn(JSON.parse(text));
    } catch {
      return [text];
    }
  }
  if (!PARSED.test(file)) return [text];
  const kind = /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : file.endsWith(".snap") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  const out: string[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n)) out.push(n.text);
    ts.forEachChild(n, walk);
  };
  walk(src);
  return out;
}

/** Every demo-world host in `values` that sits under a name nobody has reserved. */
function unreservedHosts(values: readonly string[], names: readonly string[]): string[] {
  const host = new RegExp(`(?<![a-z0-9-])(?:${names.map((n) => n.replace(/[-.]/g, "\\$&")).join("|")})(?:\\.[a-z0-9-]+)+`, "g");
  const hits: string[] = [];
  for (const v of values) {
    for (const [h] of v.toLowerCase().matchAll(host)) {
      const tld = h.slice(h.lastIndexOf(".") + 1);
      if (!RESERVED_TLD.has(tld) && !RESERVED_DOMAIN.test(h)) hits.push(h);
    }
  }
  return hits;
}

/** Every host a catalogue's placeholder or illustration line shows under a name nobody has reserved. */
function unreservedPlaceholderHosts(value: unknown, at = ""): string[] {
  if (typeof value === "string") {
    if (!/placeholder|illus/i.test(at)) return [];
    return [...value.toLowerCase().matchAll(/(?<![a-z0-9.-])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?![a-z0-9-])/g)]
      .map(([h]) => h)
      .filter((h) => !RESERVED_TLD.has(h.slice(h.lastIndexOf(".") + 1)) && !RESERVED_DOMAIN.test(h))
      .map((h) => `${at}: ${h}`);
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => unreservedPlaceholderHosts(v, at ? `${at}.${k}` : k));
}

const NAMES = demoNames();
const FILES = execFileSync("git", ["ls-files", "-z", "apps", "packages", "test"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter((f) => f !== "" && !f.startsWith("packages/fixtures/src/") && (PARSED.test(f) || TEXT.test(f) || f.endsWith(".json")));

describe("the demo world's domains are reserved names everywhere they are spelled", () => {
  it("reads the corpus's names and the trees that spell them", () => {
    expect(NAMES.length).toBeGreaterThan(20);
    expect(NAMES).toContain("atelier-eichspan");
    expect(NAMES).toContain("lichtgrat");
    expect(FILES).toEqual(expect.arrayContaining(["apps/webapp/messages/en.json", "apps/webapp/messages/de.json", "apps/mobile/src/copy.en.ts", "apps/mobile/src/copy.de.ts"]));
    expect(FILES.filter((f) => /\.test\.tsx?$/.test(f)).length).toBeGreaterThan(1000);
  });

  it("a registrable spelling is caught; a reserved one, a file name of code and member access are not", () => {
    const registrable = ["first mail · atelier-eichspan", "ch"].join(".");
    expect(unreservedHosts(valuesOf("apps/webapp/messages/xx.json", JSON.stringify({ ai: { meta: registrable } })), NAMES)).toEqual([["atelier-eichspan", "ch"].join(".")]);
    expect(unreservedHosts(valuesOf("a.test.ts", `const m = "Mail from anyone at lichtgrat${"."}de";`), NAMES)).toEqual([["lichtgrat", "de"].join(".")]);
    expect(unreservedHosts(valuesOf("a.test.ts", `expect(${"wohnfalz"}.art?.caption).toBe("lena@atelier-eichspan.example, cdn.lichtgrat.example.com");`), NAMES)).toEqual([]);
  });

  it("the corpus carries no demo-world host on a registrable name", () => {
    expect(unreservedHosts(stringsIn(getFixtures()), NAMES)).toEqual([]);
  });

  it("no tracked file of the apps, the packages or the tests spells one on a registrable name", () => {
    const hits: string[] = [];
    for (const f of FILES) {
      const text = readFileSync(path.join(ROOT, f), "utf8");
      const lower = text.toLowerCase();
      if (!NAMES.some((n) => lower.includes(n))) continue;
      for (const h of unreservedHosts(valuesOf(f, text), NAMES)) hits.push(`${f}: ${h}`);
    }
    expect(hits).toEqual([]);
  });

  it("an address or host a catalogue shows as a placeholder or illustration is a reserved name", () => {
    expect(unreservedPlaceholderHosts({ toPlaceholder: ["name@beispiel", "de, …"].join(".") })).toEqual([["toPlaceholder: beispiel", "de"].join(".")]);
    expect(unreservedPlaceholderHosts({ toPlaceholder: "name@example.com", hint: ["gmail", "com"].join(".") })).toEqual([]);
    const catalogues = { webEn, webDe, EN, DE };
    expect(unreservedPlaceholderHosts(catalogues)).toEqual([]);
  });
});
