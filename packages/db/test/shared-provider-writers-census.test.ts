import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * EVERY WRITER OF A `rules` ROW ASKS THE ONE QUESTION (mail 0148's doors): an `insert` into the rules
 * table sits in a function that CALLS `sharedProviderAllowRefusal` — the core predicate or its pinned
 * db twin — or `applicableProfileRule`, whose own body is held to call it. Parsed for the CALL by
 * TypeScript's parser over comment-blanked source, so a predicate named in prose satisfies nothing.
 * Two writers are exempt by name, each asserted: the consent seed writes sender rules only, and the
 * Cloud mirror stores the server's rows as they stand. A planted writer without the call reads red.
 * The four-field key census (`rules-writers-census.test.ts`) asks the other question of the same set.
 */
const ROOT = resolve(import.meta.dirname ?? ".", "../../..");
const ASKS = new Set(["sharedProviderAllowRefusal", "applicableProfileRule"]);

/** Writers that never ask, by `file#function`, each with why and a fact the census checks. */
const EXEMPT: Readonly<Record<string, { why: string; mustSay: RegExp }>> = {
  "packages/services/src/consent-seed.ts#confirmSeed": {
    why: "the Sent-mail seed writes SENDER rules only, which name one address and admit nobody else",
    mustSay: /kind:\s*"sender"/,
  },
  "apps/sidecar/src/cloud-mirror.ts#applyAccountUpsert": {
    why: "a replica of the server's rows, which its own doors already asked about",
    mustSay: /insert\(rules\)/,
  },
};

/** The key census's own set: every product source, tracked or not yet committed. */
function sourceFiles(): string[] {
  const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "packages/*/src/**", "apps/*/src/**"], { cwd: ROOT, encoding: "utf8" });
  return listed.split("\n").filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".d.ts"));
}

const calleeName = (n: ts.CallExpression): string =>
  ts.isIdentifier(n.expression) ? n.expression.text
    : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : "";

const enclosingFunction = (n: ts.Node): ts.Node | null => {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
      // An arrow inside a named function is that function's body for this question.
      const outer = enclosingFunction(p);
      return ts.isArrowFunction(p) || ts.isFunctionExpression(p) ? outer ?? p : p;
    }
  }
  return null;
};

const nameOf = (fn: ts.Node | null): string => {
  if (fn === null) return "<module>";
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) return fn.name.getText();
  if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
  return "<anonymous>";
};

const calls = (fn: ts.Node, names: ReadonlySet<string>): boolean => {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n) && names.has(calleeName(n))) { found = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return found;
};

/** Every `insert(<rules table>)` in a source text, by `file#function`, and whether its function asks. */
export function rulesWriters(file: string, text: string): Array<{ at: string; asks: boolean; body: string }> {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, withoutComments(text), ts.ScriptTarget.Latest, true, kind);
  const out: Array<{ at: string; asks: boolean; body: string }> = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && calleeName(n) === "insert" && n.arguments.length === 1) {
      const arg = n.arguments[0]!.getText();
      if (arg === "rules" || arg === "rulesTbl" || arg === "schema.rules") {
        const fn = enclosingFunction(n);
        out.push({ at: `${file}#${nameOf(fn)}`, asks: fn !== null && calls(fn, ASKS), body: (fn ?? sf).getText() });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe("every rules writer asks whether the rule would let everyone at a shared provider through", () => {
  const files = sourceFiles();
  const found = files.flatMap((f) => {
    const text = readFileSync(resolve(ROOT, f), "utf8");
    return /\.insert\(\s*(rules|rulesTbl|schema\.rules)\s*\)/.test(text) ? rulesWriters(f, text) : [];
  });

  it("finds the writers it exists to watch", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(found.length, "no insert into the rules table was found: the census measures nothing").toBeGreaterThanOrEqual(5);
    expect(found.map((w) => w.at)).toContain("packages/db/src/request-apply.ts#reconcileRuleCreate");
  });

  it("refuses a writer that does not call the predicate, and names each exemption's fact", () => {
    const unasked = found.filter((w) => !w.asks && EXEMPT[w.at] === undefined).map((w) => w.at);
    expect(unasked, "a rules writer that never asks `sharedProviderAllowRefusal`").toEqual([]);
    for (const [at, e] of Object.entries(EXEMPT)) {
      const w = found.find((x) => x.at === at);
      expect(w, `exemption ${at} names no writer any more — remove it`).toBeDefined();
      expect(e.mustSay.test(w!.body), `${at}: ${e.why} — and its body no longer says so`).toBe(true);
    }
  });

  it("holds `applicableProfileRule` to the predicate it stands in for", () => {
    const text = readFileSync(resolve(ROOT, "packages/core/src/adapters/organizer-profile.ts"), "utf8");
    const sf = ts.createSourceFile("p.ts", withoutComments(text), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let asks = false;
    const visit = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === "applicableProfileRule") {
        asks = calls(n, new Set(["sharedProviderAllowRefusal"]));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(asks).toBe(true);
  });

  it("CONTROL: a planted writer without the call reads red, and with it reads green", () => {
    const planted = `async function plant(tx) { await tx.insert(rulesTbl).values({ kind: "domain", match: "gmail.com" }); }`;
    expect(rulesWriters("plant.ts", planted)).toEqual([expect.objectContaining({ at: "plant.ts#plant", asks: false })]);
    const asked = `async function plant(tx, r) { if (sharedProviderAllowRefusal(r)) return; await tx.insert(rulesTbl).values(r); }`;
    expect(rulesWriters("plant.ts", asked)[0]!.asks).toBe(true);
    // A predicate named only in a comment asks nothing.
    const prose = `async function plant(tx) { /* sharedProviderAllowRefusal(r) */ await tx.insert(rules).values({}); }`;
    expect(rulesWriters("plant.ts", prose)[0]!.asks).toBe(false);
  });
});

/** Every CALL of the SQL twin in a source text, by `file:line`, and whether it hands over the destination. */
export function twinCalls(file: string, text: string): Array<{ at: string; destination: boolean }> {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, withoutComments(text), ts.ScriptTarget.Latest, true, kind);
  const out: Array<{ at: string; destination: boolean }> = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && calleeName(n) === "ruleNamesSenderSql") {
      const rule = n.arguments[1];
      const destination = rule !== undefined && ts.isObjectLiteralExpression(rule)
        && rule.properties.some((p) => p.name !== undefined && p.name.getText() === "destination");
      out.push({ at: `${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`, destination });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe("every SQL reader of a rule's sender asks with the rule's destination", () => {
  const found = sourceFiles().flatMap((f) => {
    const text = readFileSync(resolve(ROOT, f), "utf8");
    return text.includes("ruleNamesSenderSql(") ? twinCalls(f, text) : [];
  });

  it("ten callers, each destination-aware — a new caller is a reading this census is told about", () => {
    expect(found.filter((c) => !c.destination).map((c) => c.at)).toEqual([]);
    expect(found.length, found.map((c) => c.at).join("\n")).toBe(10);
  });

  it("CONTROL: a call without the destination reads red, the definition is no call", () => {
    const bare = "const x = sql`${ruleNamesSenderSql(d, { kind: sql`r.kind`, match: sql`r.match` }, s)}`;";
    expect(twinCalls("p.ts", bare)).toEqual([{ at: "p.ts:1", destination: false }]);
    expect(twinCalls("p.ts", "export function ruleNamesSenderSql(d, rule, sender) { return rule; }")).toEqual([]);
  });
});
