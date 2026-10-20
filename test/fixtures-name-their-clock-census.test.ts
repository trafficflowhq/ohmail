import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * A TEST HANDS EVERY WALL-CLOCK-DEFAULTING SELECTOR AN INSTANT.
 *
 * A selector or partition whose `now` defaults to the wall clock, read over fixtures dated by a
 * fixed clock, is a time bomb: `away-reply-warm-mirror.test.ts` went red at FIXED_NOW + 60 days
 * (2026-09-26T12:00Z), when the Sent cutline filed its seeded reply in History. Parsed, not
 * grepped. Not followed: a value held in a variable, parameter or loop binding (an options literal
 * in a same-scope const is), and a wall clock read inside a rendered component. Run by name.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = "packages/client-engine/src";
const TEST_ROOTS = ["packages/services/test", "packages/client-engine/test", "apps/webapp/test", "apps/sidecar/test"];

type Slot = { kind: "positional" | "options"; index: number };
type Source = { name: string; text: string };

function parse(s: Source): ts.SourceFile {
  const kind = s.name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(s.name, s.text, ts.ScriptTarget.Latest, true, kind);
}

/** `new Date()`, `Date.now()`, `new Date(Date.now())`, or any `x ?? <one of those>`. */
function isWallClock(n: ts.Node): boolean {
  if (ts.isParenthesizedExpression(n)) return isWallClock(n.expression);
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    return isWallClock(n.right);
  }
  if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Date") {
    const args = n.arguments ?? [];
    return args.length === 0 || (args.length === 1 && isWallClock(args[0]!));
  }
  return ts.isCallExpression(n) && n.arguments.length === 0
    && ts.isPropertyAccessExpression(n.expression) && n.expression.getText() === "Date.now";
}

type Fn = { name: string; exported: boolean; params: readonly ts.ParameterDeclaration[]; body: ts.Node };

function functionsOf(sf: ts.SourceFile): Fn[] {
  const out: Fn[] = [];
  const exported = (n: ts.Node) =>
    ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) {
      out.push({ name: n.name.text, exported: exported(n), params: n.parameters, body: n.body });
    }
    if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        const init = d.initializer;
        if (ts.isIdentifier(d.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          out.push({ name: d.name.text, exported: exported(n), params: init.parameters, body: init.body });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function descendants(n: ts.Node, pick: (x: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (x: ts.Node) => { if (pick(x)) out.push(x); ts.forEachChild(x, visit); };
  visit(n);
  return out;
}

const calleeName = (c: ts.CallExpression): string | null =>
  ts.isIdentifier(c.expression) ? c.expression.text
    : ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : null;

/**
 * THE REGISTRY, DERIVED. A parameter defaulting to the wall clock is a positional slot; a
 * parameter read as `<p>.now ?? <wall clock>` is an options slot; a function handing its own
 * parameter to a registered options slot inherits it (`consentPartition` through `cutlineFor`).
 * Only exported functions are kept: they are what a test can call.
 */
export function wallClockDefaults(sources: readonly Source[]): Map<string, Slot> {
  const fns = sources.flatMap((s) => functionsOf(parse(s)));
  const found = new Map<Fn, Slot>();
  for (const f of fns) {
    f.params.forEach((p, index) => {
      if (p.initializer && isWallClock(p.initializer)) found.set(f, { kind: "positional", index });
      if (!ts.isIdentifier(p.name)) return;
      const name = p.name.text;
      const read = descendants(f.body, (x) => ts.isBinaryExpression(x)
        && x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && isWallClock(x.right)
        && ts.isPropertyAccessExpression(x.left) && x.left.name.text === "now"
        && ts.isIdentifier(x.left.expression) && x.left.expression.text === name);
      if (read.length > 0) found.set(f, { kind: "options", index });
    });
  }
  for (let grew = true; grew;) {
    grew = false;
    const byName = new Map([...found].map(([f, s]) => [f.name, s]));
    for (const f of fns) {
      if (found.has(f)) continue;
      for (const c of descendants(f.body, ts.isCallExpression) as ts.CallExpression[]) {
        const slot = byName.get(calleeName(c) ?? "");
        const arg = slot?.kind === "options" ? c.arguments[slot.index] : undefined;
        const index = arg && ts.isIdentifier(arg)
          ? f.params.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === arg.text) : -1;
        if (index >= 0) { found.set(f, { kind: "options", index }); grew = true; break; }
      }
    }
  }
  return new Map([...found].filter(([f]) => f.exported).map(([f, s]) => [f.name, s]));
}

/** The nearest same-scope `const <name> = …` initializer, or null (a parameter or loop binding). */
function resolveConst(from: ts.Node, name: string): ts.Expression | null {
  for (let cur = from.parent; cur; cur = cur.parent) {
    if (ts.isFunctionLike(cur) && cur.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name)) {
      return null;
    }
    if (!ts.isBlock(cur) && !ts.isSourceFile(cur)) continue;
    for (const st of cur.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name) return d.initializer ?? null;
      }
    }
  }
  return null;
}

function optionsVerdict(o: ts.Expression): string | null {
  if (!ts.isObjectLiteralExpression(o)) return null;
  if (o.properties.some(ts.isSpreadAssignment)) return null;
  const now = o.properties.find((p) => p.name?.getText() === "now");
  if (!now) return "options without `now`";
  return ts.isPropertyAssignment(now) && isWallClock(now.initializer) ? "the wall clock" : null;
}

/** Every call in `file` that hands a registered function no instant, or the wall clock. */
export function wallClockReads(file: Source, registry: ReadonlyMap<string, Slot>): { findings: string[]; calls: number } {
  const sf = parse(file);
  const ownNames = new Set(functionsOf(sf).map((f) => f.name));
  const findings: string[] = [];
  let calls = 0;
  for (const c of descendants(sf, ts.isCallExpression) as ts.CallExpression[]) {
    const name = calleeName(c);
    const slot = name ? registry.get(name) : undefined;
    if (!name || !slot || (ts.isIdentifier(c.expression) && ownNames.has(name))) continue;
    calls++;
    const arg = c.arguments[slot.index];
    let why: string | null = null;
    if (!arg) why = c.arguments.some(ts.isSpreadElement) ? null : "no instant";
    else if (isWallClock(arg)) why = "the wall clock";
    else if (slot.kind === "options") {
      const lit = ts.isIdentifier(arg) ? resolveConst(c, arg.text) : arg;
      why = lit ? optionsVerdict(lit) : null;
    }
    if (why) findings.push(`${file.name}:${sf.getLineAndCharacterOfPosition(c.getStart(sf)).line + 1} ${name}: ${why}`);
  }
  return { findings, calls };
}

function walk(root: string): Source[] {
  const out: Source[] = [];
  const visit = (dir: string) => {
    for (const e of readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== "node_modules") visit(rel); continue; }
      if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) {
        out.push({ name: rel, text: readFileSync(path.join(REPO, rel), "utf8") });
      }
    }
  };
  visit(root);
  return out;
}

describe("a test names the clock its fixtures are dated by", () => {
  const registry = wallClockDefaults(walk(SOURCE_ROOT));

  it("derives the wall-clock-defaulting functions from the engine's source", () => {
    expect(registry.get("consentPartition")).toEqual({ kind: "options", index: 1 });
    expect(registry.get("cutlineFor")).toEqual({ kind: "options", index: 0 });
    expect(registry.get("screenerSegments")).toEqual({ kind: "positional", index: 1 });
    expect(registry.get("draftsList")).toEqual({ kind: "positional", index: 1 });
  });

  it("every call from the four test roots hands its selector an instant", () => {
    let calls = 0;
    const findings: string[] = [];
    for (const root of TEST_ROOTS) {
      for (const file of walk(root)) {
        const r = wallClockReads(file, registry);
        calls += r.calls;
        findings.push(...r.findings);
      }
    }
    // A census that reads no calls measured nothing; 200+ exist across the four roots today.
    expect(calls, "the scan reached no registered call").toBeGreaterThan(100);
    expect(findings, "pass the clock the fixtures are dated by (the world's, FIXED_NOW, DEMO_NOW)").toEqual([]);
    // A parse of every file in the four test roots, no wait of its own: up to 2.9 s on the CI VMs, 116 s
    // under 10% of a CPU.
  }, 180_000);
});

describe("the census, driven over planted sources", () => {
  const registry = wallClockDefaults([{
    name: "planted.ts",
    text: [
      "export function consentPartition(r, opts = {}) { return cutlineFor(opts); }",
      "export function cutlineFor(opts) { const now = opts.now ?? new Date(); return now; }",
      "export function screenerSegments(r, now: Date = new Date()) { return now; }",
      "function hidden(r, now = Date.now()) { return now; }",
      "export function stamped(r, now: Date) { return now; }",
    ].join("\n"),
  }]);

  it("derives each slot shape, forwarding included, and keeps only exported functions", () => {
    expect(registry.get("cutlineFor")).toEqual({ kind: "options", index: 0 });
    expect(registry.get("consentPartition")).toEqual({ kind: "options", index: 1 });
    expect(registry.get("screenerSegments")).toEqual({ kind: "positional", index: 1 });
    expect(registry.has("hidden")).toBe(false);
    expect(registry.has("stamped")).toBe(false);
  });

  const read = (text: string) => wallClockReads({ name: "t.test.ts", text }, registry).findings;

  it("refuses the exact line that went red on 2026-09-26, by name", () => {
    expect(read("const part = consentPartition(store, { now: new Date(), ownAddresses: [ownAddress] });"))
      .toEqual(["t.test.ts:1 consentPartition: the wall clock"]);
  });

  it("refuses every other wall-clock shape", () => {
    expect(read("screenerSegments(r);")).toEqual(["t.test.ts:1 screenerSegments: no instant"]);
    expect(read("screenerSegments(r, new Date(Date.now()));")).toEqual(["t.test.ts:1 screenerSegments: the wall clock"]);
    expect(read("screenerSegments(r, at ?? new Date());")).toEqual(["t.test.ts:1 screenerSegments: the wall clock"]);
    expect(read("consentPartition(s);")).toEqual(["t.test.ts:1 consentPartition: no instant"]);
    expect(read("const opts = { ownAddresses: [] };\nconsentPartition(s, opts);"))
      .toEqual(["t.test.ts:2 consentPartition: options without `now`"]);
  });

  it("admits an instant, a spread, a forwarded value and a local function of the same name", () => {
    expect(read("consentPartition(w.store, { now: w.clock.now(), ownAddresses: [w.ownAddress] });")).toEqual([]);
    expect(read("screenerSegments(r, DEMO_NOW);")).toEqual([]);
    expect(read("consentPartition(s, { ...base });")).toEqual([]);
    expect(read("function f(opts) { return consentPartition(s, opts); }")).toEqual([]);
    expect(read("actual.consentPartition(...args);")).toEqual([]);
    expect(read("function screenerSegments(x) { return x; }\nscreenerSegments(r);")).toEqual([]);
  });
});
