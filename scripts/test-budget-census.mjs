#!/usr/bin/env node
/**
 * THE TEST BUDGET CENSUS: every test case's effective vitest timeout, read from the source, joined with
 * the times CI measured for it.
 *
 *   node scripts/test-budget-census.mjs [--root <dir>] --report <vitest.json>... [--log <job log>...]
 *     [--old-report <json>...] [--old-log <log>...] [--changed <test file>...]
 *     [--min-ms 2500] [--table | --tsv | --json] [--check]
 *
 * The budget is what vitest 2 would give the case (checked against real runs by
 * test/test-budget-census.test.ts): a number or `{ timeout }` as the second or third argument; a
 * describe's options, passed down to nested describes; `vi.setConfig({ testTimeout })` as it stands
 * when the test is collected (top-level statements run before any describe body, and a describe body
 * runs after the body that holds it); else the config's `testTimeout`, else vitest's 5000 ms. A
 * `vi.setConfig` in a hook or a test body changes nothing and is reported. The parse is the repo's own
 * `typescript` (an AST, no type checking), so a budget split over lines reads as one.
 *
 * Timings come from vitest JSON reports (`ci-sqlite-*.json` is the SQLite run) and from job logs
 * (raw, or `gh run view --log`; the ✓/× lines that end in `<n>ms`). `--old-*` inputs are runs from
 * before the tree under census: their samples of a `--changed` file are dropped. Offline: no network.
 *
 * List A: cases on the config's budget whose slowest sample is at or over --min-ms. List B: cases
 * with an explicit budget whose slowest sample is at or over half of it. `--check` exits 1 on any
 * list-A row, any explicit budget at or over 0.8 of its time, any unmatched timing at or over
 * --min-ms, or any `vi.setConfig` that has no effect; it warns at 0.5. Exit 2: unreadable input.
 * The budget belongs to the test, not to the host: this is advisory, never a required check.
 */
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** vitest's own `testTimeout` when no config sets one. */
export const VITEST_DEFAULT_MS = 5000;
const CONFIGS = { default: "vitest.config", sqlite: "vitest.sqlite.config" };
const CONFIG_EXTS = [".ts", ".mts", ".mjs", ".js"];
const TEST_FILE = /\.test\.tsx?$/;
const SUITE_NAMES = new Set(["describe", "suite"]);
const TEST_NAMES = new Set(["it", "test"]);
const HOOK_NAMES = new Set(["beforeEach", "afterEach", "beforeAll", "afterAll"]);
const SKIP_MODS = new Set(["skip", "todo"]);
const EACH_MODS = new Set(["each", "for"]);
const MAX_INLINE = 6;

class InputError extends Error {}

const tsCache = new Map();
function loadTs(root) {
  if (!tsCache.has(root)) {
    // The tree's own typescript, else this script's (a fixture tree installs nothing).
    for (const from of [join(root, "package.json"), fileURLToPath(import.meta.url)]) {
      try { tsCache.set(root, createRequire(from)("typescript")); break; } catch { /* the next one */ }
    }
    if (!tsCache.has(root)) throw new InputError(`no typescript package for ${root}`);
  }
  return tsCache.get(root);
}

// ── Modules and scopes ───────────────────────────────────────────────────────────────────────────

function parseModule(ctx, abs) {
  if (ctx.mods.has(abs)) return ctx.mods.get(abs);
  const ts = ctx.ts;
  const text = readFileSync(abs, "utf8");
  const kind = /x$/.test(abs) ? ts.ScriptKind.TSX : /\.m?js$/.test(abs) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, kind);
  const mod = { abs, rel: relative(ctx.root, abs).split("\\").join("/"), sf, imports: new Map(), reexports: [], scope: null };
  mod.scope = { vars: new Map(), parent: null, mod };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const nb = st.importClause.namedBindings;
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) mod.imports.set(el.name.text, { spec, name: (el.propertyName ?? el.name).text });
    }
    if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      if (st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) mod.imports.set(el.name.text, { spec, name: (el.propertyName ?? el.name).text });
      } else mod.reexports.push(spec);
    }
  }
  declareIn(ctx, mod.scope, sf.statements);
  ctx.mods.set(abs, mod);
  return mod;
}

/** Hoist a block's own declarations into its scope (nested blocks get their own). */
function declareIn(ctx, scope, statements) {
  const ts = ctx.ts;
  for (const st of statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) scope.vars.set(d.name.text, { node: d.initializer ?? null, scope });
        else bindPattern(ctx, scope, d.name);
      }
    } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) {
      scope.vars.set(st.name.text, { node: st, scope });
    }
  }
}

function bindPattern(ctx, scope, name) {
  const ts = ctx.ts;
  if (ts.isIdentifier(name)) { scope.vars.set(name.text, { node: null, scope }); return; }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindPattern(ctx, scope, el.name);
  }
}

function resolveSpec(fromAbs, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromAbs), spec);
  const stem = base.replace(/\.(m?js|cjs|tsx?|mts)$/, "");
  for (const p of [base, stem + ".ts", stem + ".tsx", stem + ".mts", stem + ".mjs", stem + ".js", join(stem, "index.ts")]) {
    if (/\.(tsx?|mts|m?js)$/.test(p) && existsSync(p)) return p;
  }
  return null;
}

/** A name as the scope chain, the module's imports and its star re-exports see it. */
function lookup(ctx, scope, name, depth = 0) {
  if (depth > 6) return null;
  for (let s = scope; s; s = s.parent) {
    if (s.vars.has(name)) return s.vars.get(name);
    if (!s.parent) {
      const imp = s.mod.imports.get(name);
      if (imp) {
        if (imp.spec === "vitest") return { vitest: imp.name };
        const abs = resolveSpec(s.mod.abs, imp.spec);
        if (!abs) return null;
        return lookup(ctx, parseModule(ctx, abs).scope, imp.name, depth + 1);
      }
      for (const spec of s.mod.reexports) {
        const abs = resolveSpec(s.mod.abs, spec);
        if (!abs) continue;
        const hit = lookup(ctx, parseModule(ctx, abs).scope, name, depth + 1);
        if (hit) return hit;
      }
    }
  }
  return null;
}

function unwrap(ctx, n) {
  const ts = ctx.ts;
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(n))
    || ts.isTypeAssertionExpression(n) || ts.isNonNullExpression(n))) n = n.expression;
  return n;
}

// ── Constants ────────────────────────────────────────────────────────────────────────────────────

/** A number, or null. `meta.conditional` is set when a branch or a fallback was chosen. */
function evalNum(ctx, node, scope, meta = {}, depth = 0) {
  const ts = ctx.ts;
  node = unwrap(ctx, node);
  if (!node || depth > 12) return null;
  if (ts.isNumericLiteral(node)) return Number(node.text.replace(/_/g, ""));
  if (ts.isPrefixUnaryExpression(node)) {
    const v = evalNum(ctx, node.operand, scope, meta, depth + 1);
    if (v == null) return null;
    return node.operator === ts.SyntaxKind.MinusToken ? -v : node.operator === ts.SyntaxKind.PlusToken ? v : null;
  }
  if (ts.isIdentifier(node)) {
    const hit = lookup(ctx, scope, node.text);
    if (!hit || !hit.node) return null;
    if (ts.isFunctionDeclaration(hit.node) || ts.isClassDeclaration(hit.node)) return null;
    return evalNum(ctx, hit.node, hit.scope, meta, depth + 1);
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
      const a = evalNum(ctx, node.left, scope, meta, depth + 1);
      if (a != null && op === ts.SyntaxKind.BarBarToken && a !== 0) return a;
      const b = evalNum(ctx, node.right, scope, meta, depth + 1);
      if (b != null) meta.conditional = true;
      return a != null && op === ts.SyntaxKind.QuestionQuestionToken ? a : b;
    }
    const a = evalNum(ctx, node.left, scope, meta, depth + 1);
    const b = evalNum(ctx, node.right, scope, meta, depth + 1);
    if (a == null || b == null) return null;
    switch (op) {
      case ts.SyntaxKind.PlusToken: return a + b;
      case ts.SyntaxKind.MinusToken: return a - b;
      case ts.SyntaxKind.AsteriskToken: return a * b;
      case ts.SyntaxKind.SlashToken: return a / b;
      default: return null;
    }
  }
  if (ts.isConditionalExpression(node)) {
    const a = evalNum(ctx, node.whenTrue, scope, meta, depth + 1);
    const b = evalNum(ctx, node.whenFalse, scope, meta, depth + 1);
    if (a == null || b == null) return null;
    meta.conditional = true;
    return Math.min(a, b);
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "Math"
      && (callee.name.text === "max" || callee.name.text === "min")) {
      const vs = node.arguments.map((x) => evalNum(ctx, x, scope, meta, depth + 1));
      return vs.length && vs.every((v) => v != null) ? Math[callee.name.text](...vs) : null;
    }
    if (ts.isIdentifier(callee) && (callee.text === "Number" || callee.text === "parseInt") && node.arguments[0]) {
      return evalNum(ctx, node.arguments[0], scope, meta, depth + 1);
    }
  }
  return null;
}

function evalStr(ctx, node, scope, depth = 0) {
  const ts = ctx.ts;
  node = unwrap(ctx, node);
  if (!node || depth > 8) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return String(Number(node.text.replace(/_/g, "")));
  if (ts.isIdentifier(node)) {
    const hit = lookup(ctx, scope, node.text);
    if (!hit || !hit.node) return null;
    return evalStr(ctx, hit.node, hit.scope, depth + 1);
  }
  if (ts.isTemplateExpression(node)) {
    let s = node.head.text;
    for (const span of node.templateSpans) {
      const v = evalStr(ctx, span.expression, scope, depth + 1);
      if (v == null) return null;
      s += v + span.literal.text;
    }
    return s;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const a = evalStr(ctx, node.left, scope, depth + 1);
    const b = evalStr(ctx, node.right, scope, depth + 1);
    return a != null && b != null ? a + b : null;
  }
  return null;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ANY = "(?:.*?)";

/** A name: `{ text }` when it is known, else `{ pattern }` (a regex source). */
function nameOf(ctx, node, scope, each) {
  const ts = ctx.ts;
  node = unwrap(ctx, node);
  const fixed = node ? evalStr(ctx, node, scope) : null;
  if (fixed != null) return each ? eachName(fixed) : { text: fixed };
  if (!node) return { pattern: ANY };
  if (ts.isIdentifier(node)) {
    const hit = lookup(ctx, scope, node.text);
    if (hit?.node && (ts.isFunctionDeclaration(hit.node) || ts.isClassDeclaration(hit.node))) return { text: node.text };
    return { pattern: ANY };
  }
  if (ts.isTemplateExpression(node)) {
    let re = esc(node.head.text);
    for (const span of node.templateSpans) {
      const v = evalStr(ctx, span.expression, scope);
      re += (v != null ? esc(v) : ANY) + esc(span.literal.text);
    }
    return { pattern: each ? eachPattern(re) : re };
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const a = nameOf(ctx, node.left, scope, false);
    const b = nameOf(ctx, node.right, scope, false);
    const re = (a.text != null ? esc(a.text) : a.pattern) + (b.text != null ? esc(b.text) : b.pattern);
    return { pattern: each ? eachPattern(re) : re };
  }
  return { pattern: ANY };
}

const PRINTF = /%[sdifjoO#$]/;
function eachName(s) {
  if (!PRINTF.test(s) && !/\$\w/.test(s)) return { text: s };
  return { pattern: eachPattern(esc(s)) };
}
/** `%s`-style and `$name` placeholders (already escaped) become wildcards; `%%` stays a percent sign. */
function eachPattern(re) {
  return re.replace(/%[sdifjoO#]|%\\\$/g, ANY).replace(/\\\$[A-Za-z_]\w*(?:\\\.\w+)*/g, ANY);
}

// ── Callees ──────────────────────────────────────────────────────────────────────────────────────

/** What a callee is: `{ kind: "suite"|"test"|"hook", name, skip, each }`, or null. */
function classify(ctx, expr, scope, depth = 0) {
  const ts = ctx.ts;
  expr = unwrap(ctx, expr);
  if (!expr || depth > 8) return null;
  if (ts.isIdentifier(expr)) {
    const hit = lookup(ctx, scope, expr.text);
    if (hit?.vitest) return base(hit.vitest);
    if (hit?.node) {
      if (ts.isFunctionDeclaration(hit.node) || ts.isClassDeclaration(hit.node)) return null;
      return classify(ctx, hit.node, hit.scope, depth + 1);
    }
    if (hit) return null; // a parameter or a destructured name
    return base(expr.text); // a global (`globals: true`)
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const inner = classify(ctx, expr.expression, scope, depth + 1);
    if (!inner) return null;
    const m = expr.name.text;
    if (m === "extend" || m === "scoped") return null; // a method, not a test: `test.extend(...)` is the test
    return { ...inner, skip: inner.skip || SKIP_MODS.has(m), each: inner.each || EACH_MODS.has(m) };
  }
  if (ts.isCallExpression(expr)) {
    const callee = unwrap(ctx, expr.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      const m = callee.name.text;
      const inner = classify(ctx, callee.expression, scope, depth + 1);
      if (!inner) return null;
      if (m === "extend") return { ...inner };
      if (EACH_MODS.has(m)) return { ...inner, each: true };
      if (m === "skipIf" || m === "runIf") return { ...inner, conditional: true };
    }
    return null;
  }
  if (ts.isTaggedTemplateExpression(expr)) {
    const inner = classify(ctx, expr.tag, scope, depth + 1);
    return inner && ts.isPropertyAccessExpression(unwrap(ctx, expr.tag)) && EACH_MODS.has(unwrap(ctx, expr.tag).name.text) ? { ...inner, each: true } : null;
  }
  if (ts.isConditionalExpression(expr)) {
    const a = classify(ctx, expr.whenTrue, scope, depth + 1);
    const b = classify(ctx, expr.whenFalse, scope, depth + 1);
    if (a && b && a.kind === b.kind) return { ...a, skip: a.skip && b.skip, each: a.each || b.each, conditional: true };
    return a && !b ? a : b && !a ? b : null;
  }
  return null;
  function base(name) {
    if (SUITE_NAMES.has(name)) return { kind: "suite", name, skip: false, each: false };
    if (TEST_NAMES.has(name)) return { kind: "test", name, skip: false, each: false };
    if (HOOK_NAMES.has(name)) return { kind: "hook", name, skip: false, each: false };
    return null;
  }
}

function isFnLike(ctx, n) {
  const ts = ctx.ts;
  return !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n));
}

/** "function" | "object" | "number" | "unknown" | "none", as vitest's parseArguments would see it. */
function argType(ctx, node, scope, depth = 0) {
  const ts = ctx.ts;
  node = unwrap(ctx, node);
  if (!node) return "none";
  if (isFnLike(ctx, node)) return "function";
  if (ts.isObjectLiteralExpression(node)) return "object";
  if (evalNum(ctx, node, scope) != null) return "number";
  if (ts.isIdentifier(node) && depth < 6) {
    const hit = lookup(ctx, scope, node.text);
    if (hit?.node) return isFnLike(ctx, hit.node) ? "function" : argType(ctx, hit.node, hit.scope, depth + 1);
  }
  return "unknown";
}

/** `undefined` when the options set no timeout, else `{ ms, expr, conditional }` (ms null: not resolved). */
function optionsTimeout(ctx, node, scope, asNumber, depth = 0) {
  const ts = ctx.ts;
  node = unwrap(ctx, node);
  if (!node || depth > 6) return undefined;
  const text = node.getText().replace(/\s+/g, " ").slice(0, 80);
  if (asNumber) {
    const meta = {};
    const ms = evalNum(ctx, node, scope, meta);
    return { ms, expr: text, conditional: !!meta.conditional };
  }
  if (ts.isIdentifier(node)) {
    const hit = lookup(ctx, scope, node.text);
    if (hit?.node) return optionsTimeout(ctx, hit.node, hit.scope, false, depth + 1);
    return { ms: null, expr: text, conditional: false };
  }
  if (!ts.isObjectLiteralExpression(node)) return { ms: null, expr: text, conditional: false };
  let found;
  for (const p of node.properties) {
    if (ts.isSpreadAssignment(p)) {
      const inner = optionsTimeout(ctx, p.expression, scope, false, depth + 1);
      if (inner && inner.ms != null) found = inner;
      continue;
    }
    const key = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
    if (key !== "timeout") continue;
    const meta = {};
    const value = ts.isShorthandPropertyAssignment(p) ? p.name : p.initializer;
    const ms = evalNum(ctx, value, scope, meta);
    found = { ms, expr: text, conditional: !!meta.conditional };
  }
  return found;
}

/** vitest's parseArguments over (name, a1, a2): the options' timeout and the body. */
function parseArgs(ctx, a1, a2, scope) {
  const t1 = argType(ctx, a1, scope);
  const t2 = argType(ctx, a2, scope);
  let timeout;
  if (t2 === "object") timeout = optionsTimeout(ctx, a2, scope, false);
  else if (t2 === "number") timeout = optionsTimeout(ctx, a2, scope, true);
  else if (t2 === "unknown") timeout = t1 === "object" ? optionsTimeout(ctx, a1, scope, false) : optionsTimeout(ctx, a2, scope, true);
  else if (t1 === "object") timeout = optionsTimeout(ctx, a1, scope, false);
  else if (t1 === "unknown" && t2 === "function") timeout = optionsTimeout(ctx, a1, scope, false);
  const body = [a1, a2].map((x) => unwrap(ctx, x)).find((x) => isFnLike(ctx, x)) ?? null;
  return { timeout, body };
}

// ── Collection ───────────────────────────────────────────────────────────────────────────────────

function lineOf(mod, node) { return mod.sf.getLineAndCharacterOfPosition(node.getStart(mod.sf)).line + 1; }

function collectFile(ctx, rel, config) {
  const ts = ctx.ts;
  const mod = parseModule(ctx, join(ctx.root, rel));
  const out = { cases: [], suites: [], findings: [] };
  const file = { cfg: { ms: config.ms, expr: config.expr, source: "config" } };
  const root = { chain: [], suite: undefined, hooks: [new Set()], scope: mod.scope, mod, via: "", children: [], inline: [] };

  const runBody = (statements, c) => {
    c.children = [];
    visitAll(statements, c);
    for (const child of c.children) child();
  };
  const visitAll = (statements, c) => { for (const st of statements) visit(st, c); };
  const blockScope = (c, statements) => {
    const scope = { vars: new Map(), parent: c.scope, mod: c.scope.mod };
    declareIn(ctx, scope, statements);
    return { ...c, scope };
  };
  const visit = (node, c) => {
    if (!node) return;
    if (ts.isExpressionStatement(node)) return visitExpr(node.expression, c);
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) if (d.initializer) visitExpr(d.initializer, c, true);
      return;
    }
    if (ts.isBlock(node)) { const b = blockScope(c, node.statements); return visitAll(node.statements, b); }
    if (ts.isIfStatement(node)) { visit(node.thenStatement, c); visit(node.elseStatement, c); return; }
    if (ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isForStatement(node)) {
      const scope = { vars: new Map(), parent: c.scope, mod: c.scope.mod };
      const init = node.initializer;
      if (init && ts.isVariableDeclarationList(init)) for (const d of init.declarations) bindPattern(ctx, scope, d.name);
      return visit(node.statement, { ...c, scope });
    }
    if (ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isLabeledStatement(node)) return visit(node.statement, c);
    if (ts.isTryStatement(node)) { visit(node.tryBlock, c); if (node.catchClause) visit(node.catchClause.block, c); visit(node.finallyBlock, c); }
  };

  const fnBody = (fn, c, args, argScope) => {
    const scope = { vars: new Map(), parent: fn.__scope ?? c.scope, mod: (fn.__scope ?? c.scope).mod };
    fn.parameters.forEach((p, i) => {
      if (ts.isIdentifier(p.name)) {
        const arg = args?.[i];
        scope.vars.set(p.name.text, arg ? { node: arg, scope: argScope } : { node: p.initializer ?? null, scope });
      } else bindPattern(ctx, scope, p.name);
    });
    if (ts.isBlock(fn.body)) {
      declareIn(ctx, scope, fn.body.statements);
      return { statements: fn.body.statements, c: { ...c, scope } };
    }
    return { expression: fn.body, c: { ...c, scope } };
  };
  const runFn = (fn, c, args, argScope) => {
    const b = fnBody(fn, c, args, argScope);
    if (b.statements) visitAll(b.statements, b.c);
    else visitExpr(b.expression, b.c);
  };

  const noEffect = (fn, where, c) => {
    if (!fn) return;
    const walk = (n) => {
      if (ts.isCallExpression(n) && isSetConfig(n)) {
        out.findings.push({ file: rel, line: lineOf(c.scope.mod, n), kind: "setConfig-no-effect",
          detail: `vi.setConfig in ${where} changes no budget: the tests are already collected` });
      }
      ts.forEachChild(n, walk);
    };
    walk(fn.body ?? fn);
  };
  const isSetConfig = (n) => {
    const e = unwrap(ctx, n.expression);
    return ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "vi" && e.name.text === "setConfig";
  };

  const visitExpr = (e, c, inDecl = false) => {
    e = unwrap(ctx, e);
    if (!e) return;
    if (ts.isAwaitExpression(e) || ts.isVoidExpression(e)) return visitExpr(e.expression, c, inDecl);
    if (!ts.isCallExpression(e)) return;
    if (e.expression.kind === ts.SyntaxKind.ImportKeyword) {
      // `await import("./other.test")` at collection: that file's tests are this file's.
      const spec = e.arguments[0] && ts.isStringLiteralLike(e.arguments[0]) ? e.arguments[0].text : null;
      const abs = spec ? resolveSpec(c.scope.mod.abs, spec) : null;
      if (!abs) return;
      const other = parseModule(ctx, abs);
      if (c.inline.includes(other.sf)) return;
      visitAll(other.sf.statements, { ...c, scope: other.scope, inline: [...c.inline, other.sf], via: c.via || "import",
        callLine: c.via ? c.callLine : lineOf(c.scope.mod, e) });
      return;
    }
    if (isSetConfig(e)) {
      const o = unwrap(ctx, e.arguments[0]);
      if (o && ts.isObjectLiteralExpression(o)) {
        for (const p of o.properties) {
          if (!ts.isPropertyAssignment(p) || !p.name || p.name.getText() !== "testTimeout") continue;
          const meta = {};
          const ms = evalNum(ctx, p.initializer, c.scope, meta);
          file.cfg = { ms, expr: e.getText().replace(/\s+/g, " ").slice(0, 80), source: "setConfig", conditional: !!meta.conditional };
        }
      }
      return;
    }
    const k = classify(ctx, e.expression, c.scope);
    if (k && inDecl && k.kind !== "hook") {
      // `const x = test.extend(...)` or `const t = describe(...)`: only the second one defines anything.
      const callee = unwrap(ctx, e.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "extend") return;
    }
    if (k?.kind === "hook") {
      const fn = e.arguments.map((x) => unwrap(ctx, x)).find((x) => isFnLike(ctx, x));
      if (k.name === "beforeEach" || k.name === "afterEach") c.hooks[c.hooks.length - 1].add(k.name);
      noEffect(fn, k.name, c);
      return;
    }
    if (k?.kind === "suite") {
      if (k.skip) return;
      const [a0, a1, a2] = e.arguments;
      const { timeout, body } = parseArgs(ctx, a1, a2, c.scope);
      const name = nameOf(ctx, a0, c.scope, k.each);
      const line = lineOf(c.scope.mod, e);
      const suite = timeout !== undefined
        ? { ms: timeout.ms, expr: timeout.expr, source: "describe", conditional: timeout.conditional }
        : c.suite;
      const child = { ...c, chain: [...c.chain, name], suite, hooks: [...c.hooks, new Set()], children: [] };
      c.children.push(() => {
        const eff = suite ?? file.cfg;
        out.suites.push({ file: rel, line, chain: child.chain, budgetMs: eff.ms, source: eff.source, expr: eff.expr });
        if (!body) return;
        const b = fnBody(body, child, null, null);
        if (b.statements) runBody(b.statements, b.c);
        else { b.c.children = []; visitExpr(b.expression, b.c); for (const ch of b.c.children) ch(); }
      });
      return;
    }
    if (k?.kind === "test") {
      if (k.skip) return;
      const [a0, a1, a2] = e.arguments;
      const { timeout, body } = parseArgs(ctx, a1, a2, c.scope);
      const eff = timeout !== undefined ? { ...timeout, source: "case" } : c.suite ?? file.cfg;
      const hooks = new Set();
      out.cases.push({
        file: rel,
        line: c.via ? c.callLine : lineOf(c.scope.mod, e),
        chain: [...c.chain, nameOf(ctx, a0, c.scope, k.each)],
        budgetMs: eff.ms,
        source: eff.source,
        expr: eff.expr,
        hooks: [],
        via: c.via ? `${c.scope.mod.rel}:${lineOf(c.scope.mod, e)}` : "",
        conditional: !!eff.conditional,
        _hooks: c.hooks,
        _set: hooks,
      });
      noEffect(body, "a test body", c);
      return;
    }
    // A helper that defines tests, run where it is called; a callback (forEach, a wrapper) likewise.
    const callee = unwrap(ctx, e.expression);
    if (ts.isIdentifier(callee)) {
      const hit = lookup(ctx, c.scope, callee.text);
      let fn = hit?.node ? unwrap(ctx, hit.node) : null;
      if (fn && isFnLike(ctx, fn) && c.inline.length < MAX_INLINE && !c.inline.includes(fn)) {
        fn.__scope = hit.scope;
        const next = { ...c, inline: [...c.inline, fn], via: c.via || "helper", callLine: c.via ? c.callLine : lineOf(c.scope.mod, e) };
        runFn(fn, next, e.arguments, c.scope);
        return;
      }
    }
    for (const arg of e.arguments) {
      const fn = unwrap(ctx, arg);
      if (isFnLike(ctx, fn) && c.inline.length < MAX_INLINE) runFn(fn, { ...c, inline: [...c.inline, fn] }, null, null);
    }
    if (ts.isPropertyAccessExpression(callee)) visitExpr(callee.expression, c);
  };

  runBody(mod.sf.statements, root);
  for (const cs of out.cases) {
    const seen = new Set();
    for (const h of cs._hooks) for (const n of h) seen.add(n);
    cs.hooks = ["beforeEach", "afterEach"].filter((n) => seen.has(n));
    delete cs._hooks; delete cs._set;
  }
  return out;
}

// ── Public API ───────────────────────────────────────────────────────────────────────────────────

/** Every file the default vitest project selects (packages/* /test, apps/* /test, test/). */
export function testFiles(root) {
  const out = [];
  const walk = (rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else if (TEST_FILE.test(e.name)) out.push(child);
    }
  };
  for (const top of ["apps", "packages"]) {
    if (!existsSync(join(root, top))) continue;
    for (const d of readdirSync(join(root, top), { withFileTypes: true })) if (d.isDirectory()) walk(`${top}/${d.name}/test`);
  }
  walk("test");
  return out.sort();
}

/** Each project's config budget: `{ default, sqlite }`, each `{ ms, expr, file }`. */
export function configBudgets(root) {
  const ctx = { ts: loadTs(root), root, mods: new Map() };
  const read = (stem) => {
    const ext = CONFIG_EXTS.find((x) => existsSync(join(root, stem + x)));
    if (!ext) return null;
    const mod = parseModule(ctx, join(root, stem + ext));
    let found = null;
    const walk = (n) => {
      if (ctx.ts.isPropertyAssignment(n) && n.name && n.name.getText() === "testTimeout") {
        found = { ms: evalNum(ctx, n.initializer, mod.scope), expr: `${stem + ext}: testTimeout ${n.initializer.getText()}`, file: stem + ext };
      }
      ctx.ts.forEachChild(n, walk);
    };
    walk(mod.sf);
    return found;
  };
  const def = read(CONFIGS.default) ?? { ms: VITEST_DEFAULT_MS, expr: `vitest default ${VITEST_DEFAULT_MS}`, file: null };
  const sqlite = read(CONFIGS.sqlite) ?? { ...def };
  return { default: def, sqlite };
}

/** The cases (and describes) of `files` (repo-relative), with each one's effective budget. */
export function caseBudgets(root, files = testFiles(root)) {
  const ctx = { ts: loadTs(root), root, mods: new Map() };
  const config = configBudgets(root).default;
  const cases = [];
  const suites = [];
  const findings = [];
  for (const rel of files) {
    let r;
    try { r = collectFile(ctx, rel, config); }
    catch (err) { findings.push({ file: rel, line: 0, kind: "parse-error", detail: String(err?.message ?? err) }); continue; }
    cases.push(...r.cases); suites.push(...r.suites); findings.push(...r.findings);
  }
  return { cases, suites, findings };
}

const TIMED_OUT = /Test timed out in \d+ms/;

/** A vitest JSON report's timings. `file` is the path as the report wrote it. */
export function readReport(path) {
  let r;
  try { r = JSON.parse(readFileSync(path, "utf8")); } catch (err) { throw new InputError(`${path}: ${err.message}`); }
  if (!r || !Array.isArray(r.testResults)) throw new InputError(`${path}: not a vitest JSON report`);
  const project = /^ci-sqlite/.test(basename(path)) ? "sqlite" : "default";
  const out = [];
  for (const f of r.testResults) {
    for (const a of f.assertionResults ?? []) {
      if (a.status !== "passed" && a.status !== "failed") continue;
      out.push({ file: f.name, project, chain: [...(a.ancestorTitles ?? []), a.title], ms: Math.round(a.duration ?? 0), status: a.status,
        timedOut: (a.failureMessages ?? []).some((m) => TIMED_OUT.test(m)), from: path });
    }
  }
  return out;
}

/** An escape sequence, raw or as `gh run view --log` prints it (`^[[32m`). */
const ANSI = /(?:\x1b|\^\[)\[[0-9;?]*[A-Za-z]/g;
const STAMP = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
/** A job log's per-test lines (raw, or `gh run view --log`): the file lines and the ✓/× lines that end in ms. */
export function readJobLog(path) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch (err) { throw new InputError(`${path}: ${err.message}`); }
  const out = [];
  let file = null;
  let last = null;
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(ANSI, "");
    const tabbed = /^[^\t]*\t[^\t]*\t(.*)$/.exec(line);
    if (tabbed && STAMP.test(tabbed[1])) line = tabbed[1];
    line = line.replace(STAMP, "");
    const f = /^\s*[✓×❯↓]\s+(\S+\.test\.tsx?)\s+\(\d+ tests?[^)]*\)/.exec(line);
    if (f) { file = f[1]; last = null; continue; }
    const t = /^\s+([✓×])\s+(.+?)\s+(\d+(?:\.\d+)?)ms\s*$/.exec(line);
    if (t && file) {
      last = { file, project: "default", chain: t[2].split(" > "), ms: Math.round(Number(t[3])), status: t[1] === "✓" ? "passed" : "failed",
        timedOut: false, from: path };
      out.push(last);
      continue;
    }
    if (last && /^\s+→\s/.test(line) && TIMED_OUT.test(line)) last.timedOut = true;
  }
  return out;
}

/** The repo file a report path names: the longest suffix of it that is a test file in `files`. */
export function repoFileOf(path, files) {
  const parts = String(path).split(/[\\/]/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const cand = parts.slice(i).join("/");
    if (files.has(cand)) return cand;
  }
  return null;
}

function matcher(chain) {
  if (chain.every((x) => x.text != null)) return { exact: chain.map((x) => x.text).join(" > ") };
  return { re: new RegExp("^" + chain.map((x) => (x.text != null ? esc(x.text) : x.pattern)).join(" > ") + "$", "s") };
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };

/**
 * One row per (case, measured name): Case plus `{ name, project, samples, maxMs, medianMs, ratio, matched,
 * timedOut }`. `opts.files`: the tree's test files (default: the cases' files); `opts.drop`:
 * `{ from: Set<path>, files: Set<repo file> }`, the samples to leave out; `opts.config`: configBudgets.
 */
export function joinTimings(cases, timings, opts = {}) {
  const files = opts.files ?? new Set(cases.map((c) => c.file));
  const config = opts.config;
  const suites = opts.suites ?? [];
  const byFile = new Map();
  for (const c of cases) {
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file).push({ c, m: matcher(c.chain) });
  }
  const suitesByFile = new Map();
  for (const s of suites) {
    if (!suitesByFile.has(s.file)) suitesByFile.set(s.file, []);
    suitesByFile.get(s.file).push({ s, m: matcher(s.chain) });
  }
  const groups = new Map();
  for (const t of timings) {
    const file = repoFileOf(t.file, files);
    if (opts.drop && file && opts.drop.from.has(t.from) && opts.drop.files.has(file)) continue;
    const name = t.chain.join(" > ");
    const key = `${file ?? t.file}\u0000${t.project}\u0000${name}`;
    if (!groups.has(key)) groups.set(key, { file: file ?? t.file, known: !!file, project: t.project, name, ms: [], timedOut: 0, failed: 0 });
    const g = groups.get(key);
    g.ms.push(t.ms);
    if (t.timedOut) g.timedOut++;
    if (t.status === "failed") g.failed++;
  }
  const rows = [];
  for (const g of groups.values()) {
    const cands = byFile.get(g.file) ?? [];
    let hit = cands.find(({ m }) => m.exact === g.name);
    let matched = hit ? "exact" : "none";
    if (!hit) { hit = cands.find(({ m }) => m.re && m.re.test(g.name)); if (hit) matched = "pattern"; }
    let base = hit?.c;
    if (!base) {
      // The nearest describe this name sits in.
      const ss = (suitesByFile.get(g.file) ?? [])
        .filter(({ m }) => m.exact != null ? g.name.startsWith(m.exact + " > ") : false)
        .sort((a, b) => b.s.chain.length - a.s.chain.length);
      if (ss[0]) {
        matched = "describe";
        base = { file: g.file, line: ss[0].s.line, chain: ss[0].s.chain, budgetMs: ss[0].s.budgetMs, source: ss[0].s.source, expr: ss[0].s.expr, hooks: [], via: "", conditional: false };
      }
    }
    base ??= { file: g.file, line: 0, chain: [{ text: g.name }], budgetMs: null, source: null, expr: "", hooks: [], via: "", conditional: false };
    let budgetMs = base.budgetMs;
    if (base.source === "config" && config && g.project === "sqlite") budgetMs = config.sqlite.ms;
    const maxMs = Math.max(...g.ms);
    rows.push({ ...base, budgetMs, name: g.name, project: g.project, samples: g.ms.length, maxMs, medianMs: median(g.ms),
      ratio: budgetMs ? maxMs / budgetMs : null, matched, timedOut: g.timedOut, failed: g.failed, inTree: g.known });
  }
  return rows.sort((a, b) => b.maxMs - a.maxMs || a.file.localeCompare(b.file) || a.line - b.line);
}

/** The lists and what `--check` refuses. */
export function verdict(rows, opts = {}) {
  const explicitRatio = opts.explicitRatio ?? 0.8;
  const warnRatio = opts.warnRatio ?? 0.5;
  const minMs = opts.minMs ?? 2500;
  const findings = opts.findings ?? [];
  const known = rows.filter((r) => r.matched !== "none");
  const listA = known.filter((r) => r.source === "config" && r.maxMs >= minMs);
  const explicit = known.filter((r) => r.source !== "config" && r.budgetMs != null);
  const listB = explicit.filter((r) => r.ratio >= warnRatio);
  const over = explicit.filter((r) => r.ratio >= explicitRatio);
  const unmatched = rows.filter((r) => r.matched === "none" && r.inTree !== false && r.maxMs >= minMs);
  const unresolved = known.filter((r) => r.source !== "config" && r.budgetMs == null && r.maxMs >= minMs);
  const noEffect = findings.filter((f) => f.kind === "setConfig-no-effect" || f.kind === "parse-error");
  const fail = [
    ...listA.map((r) => `LIST_A ${r.file}:${r.line} ${r.maxMs}ms on the ${r.budgetMs}ms default: ${r.name}`),
    ...over.map((r) => `NEAR_BUDGET ${r.file}:${r.line} ${r.maxMs}ms of ${r.budgetMs}ms (${Math.round(r.ratio * 100)}%): ${r.name}`),
    ...unmatched.map((r) => `UNMATCHED ${r.file} ${r.maxMs}ms: ${r.name}`),
    ...noEffect.map((f) => `${f.kind === "parse-error" ? "PARSE_ERROR" : "NO_EFFECT"} ${f.file}:${f.line} ${f.detail}`),
  ];
  const warn = listB.filter((r) => r.ratio < explicitRatio)
    .map((r) => `WARN ${r.file}:${r.line} ${r.maxMs}ms of ${r.budgetMs}ms (${Math.round(r.ratio * 100)}%): ${r.name}`);
  return { listA, listB, unmatched, unresolved, fail, warn };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ");
const budgetCell = (r) => r.budgetMs == null ? `unresolved (${r.source}: ${r.expr})` : `${r.budgetMs} ms (${r.source}${r.source === "config" ? "" : `: ${r.expr}`})`;
function table(v, totals, findings, minMs) {
  const head = "| file:line | test | VM max / median (n) | budget (source) | hooks |\n|---|---|---|---|---|";
  const line = (r) => `| ${cell(`${r.file}:${r.line}`)}${r.via ? ` (via ${cell(r.via)})` : ""} | ${cell(r.name)} | ${r.maxMs} / ${r.medianMs} ms (${r.samples}) | ${cell(budgetCell(r))} | ${r.hooks.join(", ")} |`;
  const out = [];
  out.push(`### List A: on the config's budget, slowest sample at or over ${minMs} ms (${v.listA.length})`, "", head, ...v.listA.map(line), "");
  out.push(`### List B: explicit budget, slowest sample at or over half of it (${v.listB.length})`, "", head, ...v.listB.map(line), "");
  out.push(`### Unmatched timings at or over ${minMs} ms (${v.unmatched.length})`, "", head, ...v.unmatched.map(line), "");
  if (v.unresolved.length) out.push(`### Explicit budgets that could not be resolved (${v.unresolved.length})`, "", head, ...v.unresolved.map(line), "");
  out.push(`### Findings (${findings.length})`, "", ...findings.map((f) => `- ${f.kind} ${f.file}:${f.line} ${f.detail}`), "");
  out.push(`Totals: ${totals.files} files, ${totals.cases} cases, ${totals.rows} timing rows from ${totals.samples} samples, ${totals.unmatched} unmatched.`);
  return out.join("\n");
}

function parseCli(argv) {
  const a = { root: null, report: [], log: [], oldReport: [], oldLog: [], changed: [], minMs: 2500, out: "table", check: false };
  const lists = { "--report": "report", "--log": "log", "--old-report": "oldReport", "--old-log": "oldLog", "--changed": "changed" };
  let cur = null;
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (lists[x]) { cur = lists[x]; continue; }
    if (x === "--root") { a.root = argv[++i]; cur = null; continue; }
    if (x === "--min-ms") { a.minMs = Number(argv[++i]); cur = null; continue; }
    if (x === "--table" || x === "--tsv" || x === "--json") { a.out = x.slice(2); cur = null; continue; }
    if (x === "--check") { a.check = true; cur = null; continue; }
    if (x.startsWith("--")) throw new InputError(`unknown option ${x}`);
    if (!cur) throw new InputError(`a value with no option: ${x}`);
    a[cur].push(x);
  }
  if (!Number.isFinite(a.minMs)) throw new InputError("--min-ms takes a number");
  return a;
}

export function main(argv) {
  const a = parseCli(argv);
  const root = resolve(a.root ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  if (!existsSync(root)) throw new InputError(`no root ${root}`);
  const config = configBudgets(root);
  const files = testFiles(root);
  const { cases, suites, findings } = caseBudgets(root, files);
  const timings = [];
  for (const p of [...a.report, ...a.oldReport]) timings.push(...readReport(p));
  for (const p of [...a.log, ...a.oldLog]) timings.push(...readJobLog(p));
  if (!timings.length) throw new InputError("no timings: pass --report or --log");
  const drop = { from: new Set([...a.oldReport, ...a.oldLog]), files: new Set(a.changed) };
  const rows = joinTimings(cases, timings, { files: new Set(files), suites, config, drop });
  const v = verdict(rows, { minMs: a.minMs, findings });
  const totals = { files: files.length, cases: cases.length, rows: rows.length, samples: rows.reduce((n, r) => n + r.samples, 0),
    unmatched: rows.filter((r) => r.matched === "none").length };
  if (a.out === "json") process.stdout.write(JSON.stringify({ config, totals, listA: v.listA, listB: v.listB, unmatched: v.unmatched, findings, rows }, null, 1) + "\n");
  else if (a.out === "tsv") {
    process.stdout.write(["file", "line", "name", "project", "budgetMs", "source", "expr", "maxMs", "medianMs", "samples", "ratio", "matched", "hooks", "via"].join("\t") + "\n");
    for (const r of rows) process.stdout.write([r.file, r.line, cell(r.name), r.project, r.budgetMs ?? "", r.source ?? "", cell(r.expr), r.maxMs, r.medianMs, r.samples, r.ratio == null ? "" : r.ratio.toFixed(3), r.matched, r.hooks.join(","), r.via].join("\t") + "\n");
  } else process.stdout.write(table(v, totals, findings, a.minMs) + "\n");
  if (!a.check) return 0;
  for (const w of v.warn) process.stderr.write(w + "\n");
  for (const f of v.fail) process.stderr.write(f + "\n");
  process.stderr.write(v.fail.length ? `CENSUS_CHECK FAIL ${v.fail.length}\n` : "CENSUS_CHECK OK\n");
  return v.fail.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let code;
  try { code = main(process.argv.slice(2)); }
  catch (err) {
    if (!(err instanceof InputError)) throw err;
    process.stderr.write(`CENSUS_INPUT ${err.message}\n`);
    code = 2;
  }
  process.exitCode = code;
}
