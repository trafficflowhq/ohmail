import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { bracketSpan, lineOf, withoutComments, withoutCommentsAndLiterals } from "../scripts/lib/source-scan.mjs";
import { assertIdentifierKeys } from "../packages/services/src/dto/materialize.js";
import { PASS_ROSTERS } from "../packages/db/src/row-security/policies.js";

/**
 * EVERY DRIZZLE IDENTIFIER IS CODE-CHOSEN. drizzle-orm 0.36.4 wraps an identifier in quotes without
 * doubling a quote inside it (GHSA-gpj5-g38j-94v9), and the allowlist row admits it because nothing a
 * request carries becomes one. This census holds that: every `sql.identifier(`, `.as(`, `$with(` and
 * `alias(` in product source and `scripts/` takes a literal, a schema `<column>.name`, a query (the
 * CTE body, named by its `$with` literal), or a site in REGISTRY with the guard that bounds it. A site
 * of any other class is refused, and so is a registry entry whose site is gone. Tests are skipped.
 */
const CODE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const SCANNED = /^(?:(?:apps|packages)\/[^/]+\/src\/|scripts\/)/;
const SITE = /\bsql\.identifier\s*\(|\.as\s*\(|\$with\s*\(|\balias\s*\(/g;

/** The non-literal sites, each with what bounds its value. Keyed by file and argument text. */
const REGISTRY: ReadonlyArray<{ file: string; arg: string; bound: string }> = [
  { file: "packages/services/src/dto/materialize.ts", arg: "k", bound: "a MaterializeSource key: assertIdentifierKeys refuses a non-identifier" },
  { file: "packages/services/src/dto/materialize.ts", arg: "`p_${k}`", bound: "the same key, the same guard" },
  { file: "packages/services/src/dto/materialize.ts", arg: "`${prefix}_${column.name}`", bound: "prefixed(): a literal prefix (checked below) and a schema column" },
  { file: "packages/services/src/message-service.ts", arg: "from", bound: "ownedMessages's parameter, typed as a literal union (checked below)" },
  { file: "packages/db/src/roster-db.ts", arg: "table", bound: "passRosterFor's table is a key of PASS_ROSTERS" },
  { file: "packages/db/src/roster-db.ts", arg: "roster.account", bound: "the account column in the selected PASS_ROSTERS entry" },
  { file: "packages/db/src/roster-db.ts", arg: "roster.id", bound: "the row ID column in the selected PASS_ROSTERS entry" },
];

export type SiteClass = "literal" | "column.name" | "query" | "registry" | "unclassified";
export interface IdentifierSite { file: string; line: number; call: string; arg: string; cls: SiteClass }

export function identifierSites(file: string, src: string): IdentifierSite[] {
  const code = withoutCommentsAndLiterals(src);
  const kept = withoutComments(src);
  const out: IdentifierSite[] = [];
  for (const m of code.matchAll(SITE)) {
    const call = m[0].replace(/\s/g, "");
    const span = bracketSpan(code, m.index! + m[0].length - 1);
    // alias(table, name): the name is the second argument.
    let arg = kept.slice(span.start, span.end).trim();
    if (call === "alias(") arg = arg.slice(arg.indexOf(",") + 1).trim();
    const literal = /^(["'])[^"'\\]*\1$/.test(arg) || /^`[^`$]*`$/.test(arg);
    const cls: SiteClass = literal ? "literal"
      : /^[\w$]+(?:\.[\w$]+)*\.name$/.test(arg) ? "column.name"
      : call === ".as(" && /^[\w$.]+\s*\.\s*(?:select|selectDistinct|selectDistinctOn)\s*\(/.test(arg) ? "query"
      : REGISTRY.some((r) => r.file === file && r.arg === arg) ? "registry" : "unclassified";
    out.push({ file, line: lineOf(src, m.index!), call, arg: arg.replace(/\s+/g, " ").slice(0, 60), cls });
  }
  return out;
}

describe("every drizzle identifier is code-chosen", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0").filter((f) => f !== "" && CODE.test(f) && SCANNED.test(f) && !/(^|\/)(test|tests|__tests__)\/|\.test\.|\.spec\./.test(f));
  const sites = files.flatMap((f) => identifierSites(f, readFileSync(f, "utf8")));

  it("reads the source and finds the identifier sites", () => {
    expect(files.length).toBeGreaterThan(900);
    expect(sites.filter((s) => s.cls === "literal").length).toBeGreaterThan(10);
    expect(sites.filter((s) => s.cls === "column.name").length).toBeGreaterThanOrEqual(3);
  });

  it("classifies every site", () => {
    expect(sites.filter((s) => s.cls === "unclassified")).toEqual([]);
  });

  it("names no registry site that is gone", () => {
    const gone = REGISTRY.filter((r) => !sites.some((s) => s.cls === "registry" && s.file === r.file && s.arg === r.arg.slice(0, 60)));
    expect(gone).toEqual([]);
  });

  it("holds the registry's bounds", () => {
    const ms = readFileSync("packages/services/src/message-service.ts", "utf8");
    expect(ms).toMatch(/export function ownedMessages\(accountId: string, from: "messages" \| "n" \| "m" = "messages"\)/);
    const mat = withoutCommentsAndLiterals(readFileSync("packages/services/src/dto/materialize.ts", "utf8"));
    const keptMat = withoutComments(readFileSync("packages/services/src/dto/materialize.ts", "utf8"));
    const calls = [...mat.matchAll(/\bprefixed\s*\(/g)].map((m) => {
      const sp = bracketSpan(mat, m.index! + m[0].length - 1);
      return keptMat.slice(sp.start, sp.end);
    }).filter((a) => a.includes(","));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((a) => !/,\s*"[a-z_]+"\s*$/.test(a))).toEqual([]);
    expect(() => assertIdentifierKeys(["score", "t", "n0", "sn1", "k"])).not.toThrow();
    expect(() => assertIdentifierKeys(['score" from x; --'])).toThrow(/not an identifier/);
    expect(() => assertIdentifierKeys(["Score"])).toThrow(/not an identifier/);

    const rosterDb = withoutCommentsAndLiterals(readFileSync("packages/db/src/roster-db.ts", "utf8"));
    const policies = withoutCommentsAndLiterals(readFileSync("packages/db/src/row-security/policies.ts", "utf8"));
    expect(rosterDb).toMatch(/function passRosterFor\(db: object, table: PassRosterTable\)/);
    expect(rosterDb).toMatch(/const roster = PASS_ROSTERS\[table\]/);
    expect(policies).toMatch(/type PassRosterTable = keyof typeof PASS_ROSTERS/);
    assertIdentifierKeys(Object.entries(PASS_ROSTERS).flatMap(([table, { account, id }]) => [table, account, id]));
  });

  it("refuses a request value as an identifier; admits the code-chosen forms", () => {
    const cls = (src: string) => identifierSites("planted.ts", src).map((s) => s.cls);
    expect(cls("db.select().from(users).orderBy(sql.identifier(req.query.sort));")).toEqual(["unclassified"]);
    expect(cls("sql`${x}`.as(name);")).toEqual(["unclassified"]);
    expect(cls("db.$with(cteName).as(db.select().from(t));")).toEqual(["unclassified", "query"]);
    expect(cls("alias(users, input);")).toEqual(["unclassified"]);
    expect(cls("sql`${x}`.as(\"m_flag\"); sql.identifier(users.id.name); alias(users, \"u2\");")).toEqual(["literal", "column.name", "literal"]);
    expect(cls("// sql.identifier(req.query.sort)\nconst s = \"x.as(y)\";")).toEqual([]);
  });
});
