import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * A CLIENT LADDER WRITES ONCE PER KEY (H1). The server converges a key onto
 * the row a PATCH names and a DELETE takes every row under its key, so a `rule_update` or
 * `rule_delete` built per element of a list sends a second write naming a row already gone, and
 * the press reads as refused while the rule already files the sender. Every such write built inside
 * a loop (a `.map`/`.flatMap`/`.forEach`/`.reduce` callback, a `for…of`, `for…in` or index `for`
 * body), directly or by calling a function that builds one, iterates `oneRowPerKey(…)`, or is named
 * below with why its list is one row per key already.
 */
const ROOT = resolve(import.meta.dirname ?? ".", "../../..");
const ROOTS = ["packages/client-engine/src", "apps/webapp/app", "apps/mobile/src", "apps/desktop/src"];

const NAMED: Readonly<Record<string, string>> = {
  "apps/mobile/src/state/live.ts:routingReversal":
    "undoes the writes a ladder made, one per key already; and deletes the rows its creates made, one per create",
};

const WRITE_KINDS = new Set(["rule_update", "rule_delete"]);
const ITERATORS = new Set(["map", "flatMap", "forEach", "reduce", "reduceRight"]);

const isFunctionLike = (p: ts.Node): boolean => ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)
  || ts.isArrowFunction(p) || ts.isFunctionExpression(p);

function fnName(n: ts.Node): string {
  for (let p: ts.Node | undefined = n; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name && ts.isIdentifier(p.name)) return p.name.text;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && p.initializer
      && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) return p.name.text;
  }
  return "<top level>";
}

/** The name a function-like node is called by: its own, or the variable or property it is assigned to. */
function calledAs(fn: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const host = fn.parent;
  if (host && (ts.isVariableDeclaration(host) || ts.isPropertyAssignment(host)) && ts.isIdentifier(host.name)) return host.name.text;
  return null;
}

const isWrite = (n: ts.Node): boolean => ts.isObjectLiteralExpression(n) && n.properties.some((p) => ts.isPropertyAssignment(p)
  && ts.isIdentifier(p.name) && p.name.text === "kind" && ts.isStringLiteral(p.initializer) && WRITE_KINDS.has(p.initializer.text));

/**
 * The builder an expression names, if any: one declared in this file by its own name (or as `this.x`),
 * or one declared elsewhere only through THIS file's import of it (a named or a namespace import), so a
 * callback prop that happens to share a builder's name is not one.
 */
function builderNamer(sf: ts.SourceFile, here: ReadonlySet<string>, elsewhere: ReadonlySet<string>): (e: ts.Expression) => string | null {
  const named = new Map<string, string>();
  const spaces = new Set<string>();
  for (const st of sf.statements) {
    const b = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : undefined;
    if (b && ts.isNamedImports(b)) for (const el of b.elements) named.set(el.name.text, (el.propertyName ?? el.name).text);
    if (b && ts.isNamespaceImport(b)) spaces.add(b.name.text);
  }
  return (e) => {
    if (ts.isIdentifier(e)) {
      const imported = named.get(e.text);
      return imported !== undefined ? (elsewhere.has(imported) ? imported : null) : here.has(e.text) ? e.text : null;
    }
    if (ts.isPropertyAccessExpression(e)) {
      const via = e.expression;
      if (via.kind === ts.SyntaxKind.ThisKeyword && here.has(e.name.text)) return e.name.text;
      if (ts.isIdentifier(via) && spaces.has(via.text) && elsewhere.has(e.name.text)) return e.name.text;
    }
    return null;
  };
}

/** The loop `n` is built per element of, as the text its elements come from; null when it is in none. */
function loopOf(n: ts.Node, sf: ts.SourceFile): string | null {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) return null;
    const inBody = (s: ts.Statement): boolean => s.pos <= n.pos && n.end <= s.end;
    if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && inBody(p.statement)) return p.expression.getText(sf);
    if (ts.isForStatement(p) && inBody(p.statement)) return `${p.initializer?.getText(sf) ?? ""};${p.condition?.getText(sf) ?? ""}`;
    if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && ITERATORS.has(p.expression.name.text)
      && p.arguments.some((a) => a.pos <= n.pos && n.end <= a.end)) return p.expression.expression.getText(sf);
  }
  return null;
}

const parse = (file: string, text: string): ts.SourceFile =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** Functions that build ONE rule write per call: the write is in their own body, under no loop. */
function writeBuilders(file: string, text: string): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (isWrite(n) && loopOf(n, n.getSourceFile()) === null) {
      let fn: ts.Node | undefined = n.parent;
      while (fn && !isFunctionLike(fn)) fn = fn.parent;
      const name = fn ? calledAs(fn) : null;
      if (name) out.push(name);
    }
    n.forEachChild(visit);
  };
  visit(parse(file, text));
  return out;
}

/** The rule writes built per element of a list whose iterable is not `oneRowPerKey(…)`. */
function perElementWrites(file: string, text: string, builders: ReadonlySet<string> = new Set()): string[] {
  const sf = parse(file, text);
  const builderOf = builderNamer(sf, new Set(writeBuilders(file, text)), builders);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    const site = isWrite(n) || (ts.isCallExpression(n) && builderOf(n.expression) !== null);
    // A builder handed to an iterator by reference (`own.map(retarget)`) is called once per element.
    const byRef = ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ITERATORS.has(n.expression.name.text)
      && n.arguments.some((a) => builderOf(a) !== null);
    const iterable = site ? loopOf(n, sf)
      : byRef ? ((n as ts.CallExpression).expression as ts.PropertyAccessExpression).expression.getText(sf) : null;
    if (iterable !== null && !/\boneRowPerKey\s*\(/.test(iterable)) out.push(`${file}:${fnName(n)}`);
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

function sources(): string[] {
  const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...ROOTS], { cwd: ROOT, encoding: "utf8" });
  return listed.split("\n").filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".d.ts"));
}

describe("every client rule write over a list is one per key", () => {
  const texts = sources().map((f) => [f, readFileSync(resolve(ROOT, f), "utf8")] as const);
  const builders = new Set(texts.flatMap(([f, text]) => (/rule_(update|delete)/.test(text) ? writeBuilders(f, text) : [])));
  const found = texts.flatMap(([f, text]) => perElementWrites(f, text, builders));

  it("reads the tree (positive control: the client roots are listed, and a builder is found)", () => {
    expect(sources().length).toBeGreaterThan(300);
    expect(builders.size).toBeGreaterThan(0);
  });

  it("no per-element rule write outside oneRowPerKey and the named list", () => {
    expect([...new Set(found)].filter((k) => !(k in NAMED)), "iterate oneRowPerKey(…) or name the site with its reason").toEqual([]);
  });

  it("the import arm reads the tree: a builder declared in one file is called through another's import", () => {
    const viaImport = texts.filter(([f, text]) => {
      const sf = parse(f, text);
      const here = new Set(writeBuilders(f, text));
      const builderOf = builderNamer(sf, here, builders);
      let hit = false;
      const v = (n: ts.Node): void => {
        const b = ts.isCallExpression(n) ? builderOf(n.expression) : null;
        if (b !== null && !here.has(b)) hit = true;
        n.forEachChild(v);
      };
      v(sf);
      return hit;
    });
    expect(viaImport.length).toBeGreaterThan(0);
    // A parse of the engine's import tree, no wait of its own: 1.4 s as a rule, up to 2.7 s on a loaded
    // CI VM, 43 s under 10% of a CPU.
  }, 90_000);

  it("no named entry without a site", () => {
    expect(Object.keys(NAMED).filter((k) => !found.includes(k))).toEqual([]);
  });

  it("the planted shapes: a map and a for…of over twins are refused, oneRowPerKey is admitted", () => {
    expect(perElementWrites("x.ts", "function f(own) { return own.map((r) => ({ kind: \"rule_update\", ruleId: r.id })); }")).toEqual(["x.ts:f"]);
    expect(perElementWrites("x.ts", "function g(h) { const w = []; for (const r of h) w.push({ kind: \"rule_delete\", ruleId: r.id }); return w; }")).toEqual(["x.ts:g"]);
    expect(perElementWrites("x.ts", "function k(own) { return oneRowPerKey(own).map((r) => ({ kind: \"rule_update\", ruleId: r.id })); }")).toEqual([]);
    expect(perElementWrites("x.ts", "function one(r) { return { kind: \"rule_update\", ruleId: r.id }; }")).toEqual([]);
  });

  it("the planted shapes the first census missed: a helper (called or passed), an index for and a reduce over twins are refused", () => {
    const helper = "function retarget(id) { return { kind: \"rule_update\", ruleId: id }; }";
    expect(perElementWrites("x.ts", `${helper} function f(own) { return own.map((r) => retarget(r.id)); }`)).toEqual(["x.ts:f"]);
    expect(perElementWrites("x.ts", "import { retarget } from \"./h\"; function f(own) { return own.map((r) => retarget(r.id)); }", new Set(["retarget"]))).toEqual(["x.ts:f"]);
    expect(perElementWrites("x.ts", "import * as m from \"./h\"; function f(own) { return own.map((r) => m.retarget(r.id)); }", new Set(["retarget"]))).toEqual(["x.ts:f"]);
    expect(perElementWrites("x.ts", "function g(h) { const w = []; for (let i = 0; i < h.length; i++) w.push({ kind: \"rule_delete\", ruleId: h[i].id }); return w; }")).toEqual(["x.ts:g"]);
    expect(perElementWrites("x.ts", "function r(own) { return own.reduce((w, x) => [...w, { kind: \"rule_update\", ruleId: x.id }], []); }")).toEqual(["x.ts:r"]);
    expect(perElementWrites("x.ts", `${helper} function f(own) { return own.map(retarget); }`)).toEqual(["x.ts:f"]);
    // Controls: each shape over oneRowPerKey(…) is admitted, and a helper called once is no loop.
    expect(perElementWrites("x.ts", `${helper} function f(own) { return oneRowPerKey(own).map((r) => retarget(r.id)); }`)).toEqual([]);
    expect(perElementWrites("x.ts", "function g(h) { const w = []; for (let i = 0, one = oneRowPerKey(h); i < one.length; i++) w.push({ kind: \"rule_delete\", ruleId: one[i].id }); return w; }")).toEqual([]);
    expect(perElementWrites("x.ts", "function r(own) { return oneRowPerKey(own).reduce((w, x) => [...w, { kind: \"rule_update\", ruleId: x.id }], []); }")).toEqual([]);
    expect(perElementWrites("x.ts", `${helper} function f(r) { return [retarget(r.id)]; }`)).toEqual([]);
    expect(perElementWrites("x.ts", `${helper} function f(own) { return oneRowPerKey(own).map(retarget); }`)).toEqual([]);
    // A callback prop that shares a builder's name elsewhere, and is not imported, is not that builder.
    expect(perElementWrites("x.ts", "function f(own, onAction) { return own.map((r) => onAction(r)); }", new Set(["onAction"]))).toEqual([]);
  });
});
