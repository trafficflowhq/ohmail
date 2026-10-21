import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * THE ORDER every writer under a sender's key keeps, first take of each, in one transaction: the
 * account row; the thread-structure lock; account_settings; the rule-key lock; the profile import's
 * lock; a mailbox row FOR UPDATE; contacts; held folder_state rows; the change-log counter; the
 * graduation row. One exception: a writer holding the rule-key lock takes the counter at its delta
 * write, and never once it holds a graduation row. A class may be taken again once held; every
 * `rules` write follows the rule-key lock. The writers are DERIVED by parse (an opener whose
 * closure reaches a rules or graduations write, the counter or a learning door), read from the
 * outermost transaction, every path, helpers followed; a shape the walk cannot read is refused.
 */
const ROOT = resolve(import.meta.dirname ?? ".", "../../..");

const CHAIN = [
  "the account row", "the thread-structure lock", "account_settings", "the rule-key lock",
  "the profile import lock", "a mailbox row FOR UPDATE", "contacts", "held folder_state rows",
  "the change-log counter", "the graduation row",
] as const;
const ACCOUNT = 0, THREAD = 1, SETTINGS = 2, RULE_KEY = 3, IMPORT = 4, MAILBOX_X = 5, CONTACTS = 6,
  FOLDER_STATE = 7, COUNTER = 8, GRADUATION = 9;

type Ev =
  | { kind: "class"; cls: number; label: string }
  | { kind: "share"; label: string }
  | { kind: "rules"; label: string }
  | { kind: "unread"; label: string };

function walkAll(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((c) => walkAll(c, visit));
}

/* ── sources, declarations, and the imports a call is followed through ─────────────────── */

const parsed = new Map<string, ts.SourceFile>();
function sourceOf(file: string, text?: string): ts.SourceFile {
  let sf = parsed.get(file);
  if (!sf) {
    sf = ts.createSourceFile(file, text ?? readFileSync(resolve(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true);
    parsed.set(file, sf);
  }
  return sf;
}
const fileExists = (f: string): boolean => parsed.has(f) || existsSync(resolve(ROOT, f));

type Decl = ts.FunctionLikeDeclaration;
const declCache = new Map<string, Map<string, Decl>>();
/** Functions and methods by name; an arrow held by a `const` only where no function has the name. */
function declsOf(file: string): Map<string, Decl> {
  let out = declCache.get(file);
  if (out) return out;
  const fns = new Map<string, Decl>();
  const arrows = new Map<string, Decl>();
  walkAll(sourceOf(file), (n) => {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && ts.isIdentifier(n.name) && n.body && !fns.has(n.name.text)) fns.set(n.name.text, n);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
      && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) && !arrows.has(n.name.text)) arrows.set(n.name.text, n.initializer);
  });
  out = new Map([...arrows, ...fns]);
  declCache.set(file, out);
  return out;
}

/** The workspace aliases vitest resolves (`find: "<spec>", replacement: r("./<path>")`), exact strings only. */
const ALIASES: ReadonlyMap<string, string> = (() => {
  const text = readFileSync(resolve(ROOT, "vitest.config.ts"), "utf8");
  const out = new Map<string, string>();
  for (const m of text.matchAll(/find:\s*"([^"]+)",\s*replacement:\s*r\("\.\/([^"]+)"\)/g)) out.set(m[1]!, m[2]!);
  return out;
})();

function resolveModule(spec: string, from: string): string | null {
  if (spec.startsWith(".")) {
    const base = normalize(join(dirname(from), spec.replace(/\.js$/, "")));
    for (const f of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) if (fileExists(f)) return f;
    return null;
  }
  const hit = ALIASES.get(spec);
  return hit !== undefined && fileExists(hit) ? hit : null;
}

/** Where `name` exported by `file` is declared, through re-exports. */
function findExport(name: string, file: string, depth = 0): { file: string; decl: Decl } | null {
  if (depth > 6) return null;
  const own = declsOf(file).get(name);
  if (own) return { file, decl: own };
  for (const st of sourceOf(file).statements) {
    if (!ts.isExportDeclaration(st) || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const target = resolveModule(st.moduleSpecifier.text, file);
    if (target === null) continue;
    if (!st.exportClause) {
      const hit = findExport(name, target, depth + 1);
      if (hit) return hit;
    } else if (ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        if (el.name.text === name) return findExport((el.propertyName ?? el.name).text, target, depth + 1);
      }
    }
  }
  const imported = importOf(name, file);
  return imported ? findExport(imported.name, imported.file, depth + 1) : null;
}

/** The file and exported name a local `name` is imported from, or null. */
function importOf(name: string, file: string): { file: string; name: string } | null {
  for (const st of sourceOf(file).statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const bindings = st.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      if (el.name.text !== name) continue;
      const target = resolveModule(st.moduleSpecifier.text, file);
      return target === null ? null : { file: target, name: (el.propertyName ?? el.name).text };
    }
  }
  return null;
}

/** A call's helper: one declared in the caller's file, else the one its import names. */
function resolveCall(name: string, file: string): { file: string; decl: Decl } | null {
  const own = declsOf(file).get(name);
  if (own) return { file, decl: own };
  const imported = importOf(name, file);
  return imported ? findExport(imported.name, imported.file) : null;
}

/* ── what one call takes ─────────────────────────────────────────────────────────────────── */

const callName = (c: ts.CallExpression): string => ts.isIdentifier(c.expression) ? c.expression.text
  : ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : "";
const bare = (e: ts.Expression | undefined): ts.Expression | undefined => {
  let x = e;
  while (x && (ts.isAsExpression(x) || ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x))) x = x.expression;
  return x;
};
/** A property of an object-literal argument: its string literal, `true`, or `present`. */
function prop(arg: ts.Expression | undefined, name: string): string | undefined {
  const o = bare(arg);
  if (!o || !ts.isObjectLiteralExpression(o)) return undefined;
  for (const p of o.properties) {
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return "present";
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name) {
      const v = bare(p.initializer);
      return v && ts.isStringLiteral(v) ? v.text : v?.kind === ts.SyntaxKind.TrueKeyword ? "true" : "present";
    }
  }
  return undefined;
}
const strong = (mode: string | undefined): boolean => mode === "update" || mode === "no key update";
function fromTable(node: ts.Node): string | null {
  let found: string | null = null;
  walkAll(node, (n) => {
    if (found === null && ts.isCallExpression(n) && callName(n) === "from") {
      const a = n.arguments[0];
      if (a && ts.isIdentifier(a)) found = a.text;
    }
  });
  return found;
}
const ev = (cls: number, label: string): Ev => ({ kind: "class", cls, label });
const COUNTER_CALLS = new Set(["recordChange", "recordChanges", "recordRuleDelta", "allocateSeq", "allocateSeqRange"]);

/** A primitive's events, or `null` when the call is not one (then it may be followed). */
function primitive(c: ts.CallExpression): Ev[] | null {
  const name = callName(c);
  const a = c.arguments;
  const table = (t: string | null, mode: "share" | "strong", label: string): Ev[] => {
    switch (t) {
      case "accountSettings": return [ev(SETTINGS, label)];
      case "contacts": return [ev(CONTACTS, label)];
      case "folderState": return [ev(FOLDER_STATE, label)];
      case "accountSyncState": return [ev(COUNTER, label)];
      case "accounts": return [ev(ACCOUNT, label)];
      case "mailboxes": case "mailboxesTbl": return mode === "strong" ? [ev(MAILBOX_X, label)] : [{ kind: "share", label }];
      case "rules": case "rulesTbl": return [{ kind: "rules", label }];
      case "graduations": return [ev(GRADUATION, label)];
      default: return [];
    }
  };
  if (COUNTER_CALLS.has(name)) return [ev(COUNTER, name)];
  switch (name) {
    case "withAccountTx": case "fencedAccountWrite": case "transaction": return [];
    case "fenceErased": {
      const out: Ev[] = [ev(ACCOUNT, "fenceErased")];
      if (prop(a[2], "mailboxId") !== undefined) {
        out.push(strong(prop(a[2], "mailboxLock") ?? prop(a[2], "lock"))
          ? ev(MAILBOX_X, "fenceErased's mailbox arm") : { kind: "share", label: "fenceErased's mailbox arm" });
      }
      return out;
    }
    case "fenceErasedAccount": case "readAccountErasedAt": return [ev(ACCOUNT, name)];
    case "fenceErasedMailbox": case "readMailboxErasedAt": {
      const m = bare(a[3]);
      return strong(m && ts.isStringLiteral(m) ? m.text : undefined) ? [ev(MAILBOX_X, name)] : [{ kind: "share", label: name }];
    }
    case "readOrganizerRole": return a.some((x) => prop(x, "lock") === "true") ? [{ kind: "share", label: name }] : [];
    case "assertOrganizerRole": return [{ kind: "share", label: name }];
    case "lockAccountRuleKeys": return [ev(RULE_KEY, name)];
    // The key's writers take its lock, write `rules` and record their deltas, in that order.
    case "convergeRuleKey": case "writeRuleUnderKey": return [ev(RULE_KEY, name), { kind: "rules", label: name }, ev(COUNTER, name)];
    case "advisoryLock": {
      const cls = a.map((x) => bare(x)).find((x) => x && ts.isIdentifier(x) && /_LOCK_CLASS$/.test(x.text)) as ts.Identifier | undefined;
      if (cls?.text === "ACCOUNT_RULE_KEY_LOCK_CLASS") return [ev(RULE_KEY, "advisoryLock(rule key)")];
      if (cls?.text === "PROFILE_IMPORT_LOCK_CLASS") return [ev(IMPORT, "advisoryLock(profile import)")];
      if (cls?.text === "ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS") return [ev(THREAD, "advisoryLock(thread structure)")];
      return [];
    }
    case "upsertDesired": return [ev(FOLDER_STATE, name)];
    case "execute": case "exec": return rawStatement(c);
    case "insert": case "update": case "delete": {
      const t = bare(a[0]);
      if (!t || !ts.isIdentifier(t)) return null;
      if ((t.text === "mailboxes" || t.text === "mailboxesTbl") && name === "insert") return [];
      return table(t.text, "strong", `.${name}(${t.text})`);
    }
    case "forUpdate": {
      const q = a[0];
      return q ? table(fromTable(q), prop(a[1], "mode") === "share" ? "share" : "strong", `forUpdate(${fromTable(q) ?? "?"})`) : [];
    }
    case "for": {
      const m = bare(a[0]);
      return table(fromTable(c.expression), m && ts.isStringLiteral(m) && m.text === "share" ? "share" : "strong", `.for(${fromTable(c.expression) ?? "?"})`);
    }
    default: return null;
  }
}

/** The text of a raw statement argument (`sql\`…\``, `sql.raw("…")`), or null when there is none. */
function rawText(c: ts.CallExpression): string | null {
  for (const a of c.arguments) {
    const x = bare(a);
    if (!x) continue;
    if (ts.isTaggedTemplateExpression(x)) {
      const t = x.template;
      return ts.isNoSubstitutionTemplateLiteral(t) ? t.text : [t.head.text, ...t.templateSpans.map((sp) => sp.literal.text)].join(" ? ");
    }
    if (ts.isCallExpression(x) && callName(x) === "raw" && x.arguments[0] && ts.isStringLiteralLike(x.arguments[0])) return x.arguments[0].text;
  }
  return null;
}

/**
 * A RAW STATEMENT, classified by the table it names: a rules write or row lock is a rules event, a
 * graduations write the graduation row, an account_sync_state write or lock the counter, a plain
 * read nothing. One it cannot classify is refused by name rather than read as nothing.
 */
const RAW_TABLES = ["rules", "graduations", "account_sync_state"] as const;
function rawStatement(c: ts.CallExpression): Ev[] | null {
  const text = rawText(c);
  if (text === null) return null;
  const named = RAW_TABLES.filter((t) => new RegExp(`\\b${t}\\b`, "i").test(text));
  if (named.length === 0) return [];
  const verb = /^\s*(\w+)/.exec(text)?.[1]?.toLowerCase() ?? "";
  const locks = verb === "select" && /\bfor\s+(update|no\s+key\s+update|share|key\s+share)\b/i.test(text);
  const label = `raw ${verb || "?"} on ${named.join("/")}`;
  if (named.length > 1 || !["insert", "update", "delete", "select"].includes(verb)) return [{ kind: "unread", label }];
  if (verb === "select" && !locks) return [];
  const t = named[0]!;
  return t === "rules" ? [{ kind: "rules", label }] : [ev(t === "graduations" ? GRADUATION : COUNTER, label)];
}

/* ── the walk: every path, as a set of lock states ───────────────────────────────────────── */

interface St { held: readonly number[]; top: number; shared: boolean }
type States = Map<string, St>;
const keyOf = (s: St): string => `${s.held.join(",")}|${s.top}|${s.shared ? 1 : 0}`;
const single = (s: St): States => new Map([[keyOf(s), s]]);
const union = (...xs: States[]): States => {
  const m: States = new Map();
  for (const x of xs) for (const [k, v] of x) m.set(k, v);
  return m;
};
const EMPTY: States = new Map();

interface Ctx {
  file: string; stack: readonly string[]; off: ReadonlySet<string>; out: Set<string>; seen: Set<number>;
  /** Every lock-taking event's label, for the callback refusal; set by `step`. */
  took?: string[];
  /** Whether the closure reached what makes it a writer; set by `step` and `expr`. */
  reach?: { hit: boolean };
}

/** One event on every state; what it breaks goes to `out`, by name. */
function step(states: States, e: Ev, cx: Ctx): States {
  cx.took?.push(e.label);
  if (cx.reach && (e.kind === "rules" || (e.kind === "class" && REACH_CLASSES.has(e.cls)))) cx.reach.hit = true;
  if (e.kind === "unread") {
    cx.out.add(`a raw statement the census cannot classify (${e.label})`);
    return states;
  }
  const next: States = new Map();
  for (const s of states.values()) {
    let t: St = s;
    if (e.kind === "share") {
      t = { ...s, shared: true };
    } else if (e.kind === "rules") {
      if (!s.held.includes(RULE_KEY)) cx.out.add(`a rules write (${e.label}) before the rule-key lock`);
    } else if (!s.held.includes(e.cls)) {
      cx.seen.add(e.cls);
      if (e.cls === MAILBOX_X && s.shared) cx.out.add(`a mailbox row taken shared and then exclusively (${e.label})`);
      if (e.cls === RULE_KEY && s.shared) cx.out.add(`the rule-key lock (${e.label}) taken after a shared mailbox lock`);
      // The counter's early take under the rule-key lock ends at the graduation row.
      const excepted = e.cls === COUNTER && s.held.includes(RULE_KEY) && s.top < GRADUATION;
      if (!excepted && e.cls < s.top) cx.out.add(`${CHAIN[e.cls]} (${e.label}) taken after ${CHAIN[s.top]}`);
      t = { held: [...s.held, e.cls].sort((x, y) => x - y), top: excepted ? s.top : Math.max(s.top, e.cls), shared: s.shared };
    }
    next.set(keyOf(t), t);
  }
  return next;
}

/** A literal-`false` argument property: the helper's `if (<that name>)` block never runs. */
function falseFlags(c: ts.CallExpression): Set<string> {
  const out = new Set<string>();
  for (const a of c.arguments) {
    const o = bare(a);
    if (!o || !ts.isObjectLiteralExpression(o)) continue;
    for (const p of o.properties) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.initializer.kind === ts.SyntaxKind.FalseKeyword) out.add(p.name.text);
    }
  }
  return out;
}

/** An expression, in evaluation order; a conditional part is a branch. */
/**
 * THE RUNNERS a callback may take a lock inside: each calls it exactly once on every path, so the
 * walk reads the callback where it is passed. Any other callee may skip it or run it twice.
 */
const RUNNERS = new Set(["withAccountTx", "fencedAccountWrite", "transaction"]);
/** The classes that make a closure a writer: the counter, the key's own locks, contacts, the graduation row. */
const REACH_CLASSES: ReadonlySet<number> = new Set([RULE_KEY, IMPORT, CONTACTS, COUNTER, GRADUATION]);
/** Calls that make a closure a writer although the walk sees no table: the learning doors. */
const learningDoor = (name: string): boolean => name.startsWith("endGraduation")
  || ["clearGraduation", "recordLearningSignal", "recordRouteOverride", "demoteRoute"].includes(name);

/** A callback handed to a callee outside {@link RUNNERS}: a lock inside it is refused by name. */
function callbackLocks(n: ts.CallExpression, states: States, cx: Ctx): void {
  const name = callName(n) || "an unnamed callee";
  if (RUNNERS.has(name)) return;
  const callbacks: ts.Node[] = [];
  for (const a of n.arguments) {
    const x = bare(a);
    if (x && (ts.isArrowFunction(x) || ts.isFunctionExpression(x))) callbacks.push(x);
    if (x && ts.isObjectLiteralExpression(x)) {
      for (const p of x.properties) {
        if (ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) callbacks.push(p.initializer);
        if (ts.isMethodDeclaration(p)) callbacks.push(p);
      }
    }
  }
  for (const cb of callbacks) {
    const took: string[] = [];
    const body = (cb as ts.FunctionLikeDeclaration).body;
    if (body) fn(body, states, { ...cx, out: new Set(), seen: new Set(), took, reach: { hit: false } });
    if (took.length > 0) cx.out.add(`a lock (${took[0]}) inside a callback passed to ${name}, which may skip it or run it twice`);
  }
}

function expr(n: ts.Node, states: States, cx: Ctx): States {
  if (states.size === 0) return states;
  if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return fn(n.body, states, cx);
  if (ts.isConditionalExpression(n)) {
    const c = expr(n.condition, states, cx);
    return union(expr(n.whenTrue, c, cx), expr(n.whenFalse, c, cx));
  }
  if (ts.isBinaryExpression(n) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(n.operatorToken.kind)) {
    const l = expr(n.left, states, cx);
    return union(l, expr(n.right, l, cx));
  }
  if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const spec = n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) ? n.arguments[0].text : "a computed module";
    cx.out.add(`a dynamic import (${spec}) inside a writer's closure: the walk cannot follow it`);
    return states;
  }
  if (ts.isCallExpression(n)) {
    const prim = primitive(n);
    if (cx.reach && learningDoor(callName(n))) cx.reach.hit = true;
    callbackLocks(n, states, cx);
    let s = states;
    n.forEachChild((c) => { s = expr(c, s, cx); });
    if (prim !== null) {
      for (const e of prim) s = step(s, e, cx);
      return s;
    }
    const name = callName(n);
    const hit = name ? resolveCall(name, cx.file) : null;
    if (hit?.decl.body && !cx.stack.includes(name) && cx.stack.length < 10) {
      return fn(hit.decl.body, s, { ...cx, file: hit.file, stack: [...cx.stack, name], off: falseFlags(n) });
    }
    return s;
  }
  let s = states;
  n.forEachChild((c) => { s = expr(c, s, cx); });
  return s;
}

interface Flow { fall: States; ret: States }
/** A function body: its `return` ends its own paths, which the caller continues from. */
function fn(body: ts.Node, states: States, cx: Ctx): States {
  if (!ts.isBlock(body)) return expr(body, states, cx);
  const f = stmt(body, states, cx);
  return union(f.fall, f.ret);
}

function stmt(n: ts.Node, states: States, cx: Ctx): Flow {
  if (states.size === 0) return { fall: EMPTY, ret: EMPTY };
  if (ts.isBlock(n)) {
    let fall = states;
    let ret: States = EMPTY;
    for (const st of n.statements) {
      const f = stmt(st, fall, cx);
      fall = f.fall;
      ret = union(ret, f.ret);
      if (fall.size === 0) break;
    }
    return { fall, ret };
  }
  if (ts.isReturnStatement(n)) return { fall: EMPTY, ret: n.expression ? expr(n.expression, states, cx) : states };
  if (ts.isThrowStatement(n)) { expr(n.expression, states, cx); return { fall: EMPTY, ret: EMPTY }; }
  if (ts.isIfStatement(n)) {
    if (ts.isIdentifier(n.expression) && cx.off.has(n.expression.text)) {
      return n.elseStatement ? stmt(n.elseStatement, states, cx) : { fall: states, ret: EMPTY };
    }
    const c = expr(n.expression, states, cx);
    const t = stmt(n.thenStatement, c, cx);
    const e = n.elseStatement ? stmt(n.elseStatement, c, cx) : { fall: c, ret: EMPTY };
    return { fall: union(t.fall, e.fall), ret: union(t.ret, e.ret) };
  }
  if (ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)) {
    let s = states;
    if (ts.isForStatement(n)) { if (n.initializer) s = expr(n.initializer, s, cx); if (n.condition) s = expr(n.condition, s, cx); }
    else if (ts.isForOfStatement(n) || ts.isForInStatement(n)) s = expr(n.expression, s, cx);
    else s = expr(n.expression, s, cx);
    const b = stmt(n.statement, s, cx);
    return { fall: ts.isDoStatement(n) ? b.fall : union(s, b.fall), ret: b.ret };
  }
  if (ts.isTryStatement(n)) {
    const t = stmt(n.tryBlock, states, cx);
    const c = n.catchClause ? stmt(n.catchClause.block, union(states, t.fall), cx) : { fall: EMPTY, ret: EMPTY };
    const fall = union(t.fall, c.fall);
    const fin = n.finallyBlock ? stmt(n.finallyBlock, fall, cx) : { fall, ret: EMPTY };
    return { fall: fin.fall, ret: union(t.ret, c.ret, fin.ret) };
  }
  if (ts.isSwitchStatement(n)) {
    const c = expr(n.expression, states, cx);
    let fall: States = n.caseBlock.clauses.some((cl) => ts.isDefaultClause(cl)) ? EMPTY : c;
    let ret: States = EMPTY;
    for (const cl of n.caseBlock.clauses) {
      const f = stmt(ts.factory.createBlock([...cl.statements]), c, cx);
      fall = union(fall, f.fall);
      ret = union(ret, f.ret);
    }
    return { fall, ret };
  }
  if (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) return { fall: states, ret: EMPTY };
  if (ts.isVariableStatement(n)) {
    let s = states;
    for (const d of n.declarationList.declarations) {
      // An arrow held by a `const` runs where it is called, and is followed there.
      if (d.initializer && !ts.isArrowFunction(d.initializer) && !ts.isFunctionExpression(d.initializer)) s = expr(d.initializer, s, cx);
    }
    return { fall: s, ret: EMPTY };
  }
  return { fall: expr(n, states, cx), ret: EMPTY };
}

/* ── the writers, their openers, and the verdict ─────────────────────────────────────────── */

const start = (held: readonly number[]): St => ({ held, top: held.length ? Math.max(...held) : -1, shared: false });

/** An opener call with its callback inline, and how its transaction starts. */
function openerOf(n: ts.Node): { call: ts.CallExpression; name: string; body: ts.ArrowFunction | ts.FunctionExpression } | null {
  if (!ts.isCallExpression(n)) return null;
  const name = callName(n);
  if (!RUNNERS.has(name)) return null;
  const body = n.arguments.find((x) => ts.isArrowFunction(x) || ts.isFunctionExpression(x)) as ts.ArrowFunction | ts.FunctionExpression | undefined;
  return body ? { call: n, name, body } : null;
}

/** The state an opener's callback starts in: its own fence and mailbox arm, taken first. */
function openingState(o: NonNullable<ReturnType<typeof openerOf>>, cx: Ctx): States {
  if (o.name === "transaction") return single(start([]));
  cx.seen.add(ACCOUNT);
  let s = single(start([ACCOUNT]));
  const scope = o.name === "withAccountTx" ? o.call.arguments[2] : o.call.arguments[1];
  if (prop(scope, "mailboxId") !== undefined) {
    s = step(s, strong(prop(scope, "mailboxLock") ?? prop(scope, "lock"))
      ? ev(MAILBOX_X, `${o.name}'s mailbox arm`) : { kind: "share", label: `${o.name}'s mailbox arm` }, cx);
  }
  return s;
}

/** Each transaction `node` opens: its opener's own fence and mailbox arm first, then every path. */
function readingOf(file: string, node: ts.Node, label: string): { opened: number; out: string[]; seen: Set<number> } {
  const out = new Set<string>();
  const seen = new Set<number>();
  let opened = 0;
  walkAll(node, (n) => {
    const o = openerOf(n);
    if (!o) return;
    opened++;
    const cx: Ctx = { file, stack: [label], off: new Set(), out, seen };
    fn(o.body.body, openingState(o, cx), cx);
  });
  return { opened, out: [...out].sort(), seen };
}

function openerReading(file: string, fnName: string): { opened: number; out: string[]; seen: Set<number> } {
  const fnDecl = declsOf(file).get(fnName);
  expect(fnDecl, `${file}: ${fnName} is gone`).toBeDefined();
  return readingOf(file, fnDecl!, fnName);
}

/* ── the writers, derived ────────────────────────────────────────────────────────────────── */

/** Where writers live. `apps/sidecar/src` is the device door's composition over these packages. */
const SCANNED_ROOTS = [
  "packages/db/src", "packages/services/src", "packages/api/src", "packages/core/src", "apps/worker/src", "apps/sidecar/src",
] as const;

function sourcesUnder(root: string): string[] {
  const out: string[] = [];
  const visit = (rel: string): void => {
    for (const e of readdirSync(resolve(ROOT, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) visit(r);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(r);
    }
  };
  visit(root);
  return out;
}

/** The nearest name a reader can find a node under: a function, a method, a const or a property. */
function enclosingName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))) return n.name.text;
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) return n.parent.name.text;
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isPropertyAssignment(n.parent) && (ts.isIdentifier(n.parent.name) || ts.isStringLiteral(n.parent.name))) return n.parent.name.text;
  }
  return "<module>";
}

interface Writer { file: string; name: string; node: ts.Node }

/** Whether `node` opens a transaction anywhere inside it. */
function walkAllHasOpener(node: ts.Node): boolean {
  let found = false;
  walkAll(node, (n) => { if (!found && openerOf(n)) found = true; });
  return found;
}

/** Every function in `files` opening a transaction whose closure reaches what makes it a writer. */
function deriveWriters(files: readonly string[]): Writer[] {
  const out = new Map<string, Writer>();
  for (const file of files) {
    walkAll(sourceOf(file), (n) => {
      const o = openerOf(n);
      if (!o) return;
      const reach = { hit: false };
      const cx: Ctx = { file, stack: ["<derive>"], off: new Set(), out: new Set(), seen: new Set(), reach };
      fn(o.body.body, openingState(o, cx), cx);
      if (!reach.hit) return;
      let owner: ts.Node = o.call;
      for (let p: ts.Node | undefined = o.call.parent; p; p = p.parent) {
        if (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)
          || ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && (ts.isVariableDeclaration(p.parent) || ts.isPropertyAssignment(p.parent)))) { owner = p; break; }
      }
      const name = enclosingName(o.call);
      out.set(`${file}#${name}`, { file, name, node: owner });
    });
  }
  return [...out.values()].sort((a, b) => `${a.file}#${a.name}`.localeCompare(`${b.file}#${b.name}`));
}

/** The transactions the drain hands a request to: each `async (tx) => …` inside `within`, fenced first. */
function closureReading(file: string, within: string): { opened: number; out: string[]; seen: Set<number> } {
  let root: ts.Node | undefined = declsOf(file).get(within);
  walkAll(sourceOf(file), (n) => {
    if (!root && ts.isPropertyAssignment(n) && ts.isStringLiteral(n.name) && n.name.text === within) root = n.initializer;
  });
  expect(root, `${file}: ${within} is gone`).toBeDefined();
  const out = new Set<string>();
  const seen = new Set<number>();
  let opened = 0;
  walkAll(root!, (n) => {
    if (!ts.isArrowFunction(n) || n.parameters.length !== 1 || n.parameters[0]!.name.getText() !== "tx") return;
    opened++;
    seen.add(ACCOUNT);
    fn(n.body, single(start([ACCOUNT])), { file, stack: [within], off: new Set(), out, seen });
  });
  return { opened, out: [...out].sort(), seen };
}

/**
 * The writers named before the derivation, each with the classes its transactions must be seen to
 * take: every `fn` entry must be among the DERIVED writers (a subset, never the list itself), and
 * the drain's closures, handed their transaction by `runApply`, are read where they are written.
 */
const EXPECTED: ReadonlyArray<{ file: string; fn?: string; closure?: string; takes: readonly number[] }> = [
  { file: "packages/api/src/junk-window.ts", fn: "rescueJunk", takes: [ACCOUNT, RULE_KEY, MAILBOX_X, CONTACTS, COUNTER] },
  { file: "apps/worker/src/screener-auto-act.ts", fn: "screenerAutoActPass", takes: [ACCOUNT, SETTINGS, RULE_KEY, CONTACTS, FOLDER_STATE, COUNTER] },
  { file: "apps/worker/src/screener-correspondent-retro.ts", fn: "screenerCorrespondentRetroPass", takes: [ACCOUNT, CONTACTS] },
  { file: "apps/worker/src/screener-correspondent-retro.ts", fn: "release", takes: [ACCOUNT, RULE_KEY, CONTACTS, FOLDER_STATE, COUNTER] },
  { file: "apps/worker/src/screener-correspondent-retro.ts", fn: "retireAutoActRules", takes: [ACCOUNT, RULE_KEY, COUNTER] },
  { file: "packages/services/src/learning-service.ts", fn: "promoteOrDemote", takes: [ACCOUNT, RULE_KEY, COUNTER] },
  { file: "packages/services/src/consent-seed.ts", fn: "confirmSeed", takes: [ACCOUNT, SETTINGS, RULE_KEY, CONTACTS, COUNTER] },
  { file: "packages/services/src/consent-reset.ts", fn: "resetScreeningState", takes: [ACCOUNT, SETTINGS, RULE_KEY, CONTACTS, COUNTER] },
  // The decision at its own door, inside the held-mail release, and in the organizer's drain.
  { file: "packages/services/src/screener-service.ts", fn: "applyAsOrganizer", takes: [ACCOUNT, SETTINGS, RULE_KEY, CONTACTS, FOLDER_STATE, COUNTER] },
  { file: "packages/services/src/held-release-service.ts", fn: "releaseHeld", takes: [ACCOUNT, RULE_KEY, CONTACTS, FOLDER_STATE, COUNTER] },
  { file: "apps/worker/src/request-drain.ts", closure: "screener.decide", takes: [ACCOUNT, RULE_KEY, CONTACTS, FOLDER_STATE, COUNTER] },
  // A rule press, on its own install and applied by the organizer.
  { file: "packages/services/src/rules-service.ts", fn: "create", takes: [ACCOUNT, RULE_KEY, COUNTER] },
  { file: "packages/services/src/rules-service.ts", fn: "update", takes: [ACCOUNT, RULE_KEY, COUNTER] },
  { file: "packages/services/src/rules-service.ts", fn: "remove", takes: [ACCOUNT, RULE_KEY, COUNTER] },
  { file: "apps/worker/src/request-drain.ts", closure: "ruleHandler", takes: [ACCOUNT, RULE_KEY, COUNTER] },
  // The profile import at both doors, and the HEY import.
  { file: "packages/services/src/profile-import-service.ts", fn: "apply", takes: [ACCOUNT, RULE_KEY, IMPORT, MAILBOX_X, CONTACTS, FOLDER_STATE, COUNTER] },
  { file: "apps/worker/src/profile.ts", fn: "answerImportAsk", takes: [ACCOUNT, RULE_KEY, IMPORT, MAILBOX_X, CONTACTS, FOLDER_STATE, COUNTER] },
  { file: "packages/services/src/hey-migration.ts", fn: "migrateFromObservations", takes: [ACCOUNT, RULE_KEY, COUNTER] },
  { file: "packages/services/src/hey-migration.ts", fn: "undoMigration", takes: [ACCOUNT, RULE_KEY, COUNTER] },
  // The demotions' one door, an approval, a move and the ingest's override: the graduation row last.
  { file: "packages/db/src/learning-signal.ts", fn: "demoteRoute", takes: [ACCOUNT, RULE_KEY, COUNTER, GRADUATION] },
  { file: "packages/services/src/approval-service.ts", fn: "decide", takes: [ACCOUNT, RULE_KEY, FOLDER_STATE, COUNTER, GRADUATION] },
  { file: "packages/services/src/message-service.ts", fn: "move", takes: [ACCOUNT, FOLDER_STATE, COUNTER, GRADUATION] },
];

const DERIVED = deriveWriters(SCANNED_ROOTS.flatMap(sourcesUnder));

/**
 * THE READINGS NAMED BEFORE THE DERIVATION: writers outside this census's subject (the device
 * mirror, erasure, the backlog walks, writers that read the account after the counter), each
 * group with its gap row. A ratchet: a new reading is refused, and a gone one must leave.
 */
const KNOWN_READINGS: ReadonlySet<string> = new Set<string>([
  // The device mirror applying the Cloud's deltas: its order is its own and unmeasured here (DEVICE-MIRROR-ORDER-UNMEASURED).
  "apps/sidecar/src/cloud-mirror.ts#applyPage: a lock (readAccountErasedAt) inside a callback passed to guarded, which may skip it or run it twice",
  "apps/sidecar/src/cloud-mirror.ts#applyPage: a lock (recordChanges) inside a callback passed to guarded, which may skip it or run it twice",
  "apps/sidecar/src/cloud-mirror.ts#applyPage: a rules write (.delete(rules)) before the rule-key lock",
  "apps/sidecar/src/cloud-mirror.ts#applyPage: a rules write (.insert(rules)) before the rule-key lock",
  "apps/sidecar/src/cloud-mirror.ts#applyPage: account_settings (.insert(accountSettings)) taken after held folder_state rows",
  "apps/sidecar/src/cloud-mirror.ts#applyPage: account_settings (.insert(accountSettings)) taken after the change-log counter",
  "apps/sidecar/src/cloud-mirror.ts#applyPage: held folder_state rows (.delete(folderState)) taken after the change-log counter",
  "apps/sidecar/src/cloud-mirror.ts#applyPage: the account row (fenceErased) taken after held folder_state rows",
  "apps/sidecar/src/cloud-mirror.ts#applyPage: the account row (readAccountErasedAt) taken after held folder_state rows",
  "apps/sidecar/src/cloud-mirror.ts#applyPage: the account row (readAccountErasedAt) taken after the change-log counter",
  "apps/sidecar/src/cloud-mirror.ts#applyTagBackfill: a rules write (.insert(rules)) before the rule-key lock",
  "apps/sidecar/src/cloud-mirror.ts#applyTagBackfill: the account row (fenceErased) taken after held folder_state rows",
  "apps/sidecar/src/cloud-mirror.ts#repairProfiles: a rules write (.insert(rules)) before the rule-key lock",
  "apps/sidecar/src/cloud-mirror.ts#repairProfiles: the account row (fenceErased) taken after held folder_state rows",
  "apps/sidecar/src/cloud-mirror.ts#repairRuleInstants: a rules write (.insert(rules)) before the rule-key lock",
  "apps/sidecar/src/cloud-mirror.ts#repairRuleInstants: the account row (fenceErased) taken after held folder_state rows",
  "apps/sidecar/src/cloud-mirror.ts#repairStaleFolders: a rules write (.insert(rules)) before the rule-key lock",
  "apps/sidecar/src/cloud-mirror.ts#repairStaleFolders: account_settings (.insert(accountSettings)) taken after held folder_state rows",
  "apps/sidecar/src/cloud-mirror.ts#repairStaleFolders: account_settings (.insert(accountSettings)) taken after the change-log counter",
  "apps/sidecar/src/cloud-mirror.ts#repairStaleFolders: the account row (fenceErased) taken after held folder_state rows",
  "apps/sidecar/src/cloud-mirror.ts#repairStaleFolders: the account row (readAccountErasedAt) taken after held folder_state rows",
  "apps/sidecar/src/cloud-mirror.ts#repairStaleFolders: the account row (readAccountErasedAt) taken after the change-log counter",
  "apps/sidecar/src/cloud-mirror.ts#sweepPhantoms: a rules write (.delete(rules)) before the rule-key lock",
  "apps/sidecar/src/cloud-mirror.ts#sweepPhantoms: account_settings (.insert(accountSettings)) taken after held folder_state rows",
  "apps/sidecar/src/cloud-mirror.ts#sweepPhantoms: account_settings (.insert(accountSettings)) taken after the change-log counter",
  "apps/sidecar/src/cloud-mirror.ts#sweepPhantoms: held folder_state rows (.delete(folderState)) taken after the change-log counter",
  "apps/sidecar/src/cloud-mirror.ts#sweepPhantoms: the account row (readAccountErasedAt) taken after held folder_state rows",
  "apps/sidecar/src/cloud-mirror.ts#sweepPhantoms: the account row (readAccountErasedAt) taken after the change-log counter",
  // The device's organize claim: the mailbox row before the account fence (DEVICE-MIRROR-ORDER-UNMEASURED).
  "apps/sidecar/src/engine.ts#mayOrganize: the account row (fenceErased) taken after a mailbox row FOR UPDATE",
  // The backlog walks lock their own rule row, without the rule-key lock (BACKLOG-WALKS-SKIP-THE-RULE-KEY-LOCK).
  "apps/worker/src/rule-retro.ts#ruleRetroPass: a rules write (.update(rulesTbl)) before the rule-key lock",
  "apps/worker/src/rule-retro.ts#ruleRetroPass: a rules write (forUpdate(rulesTbl)) before the rule-key lock",
  "apps/worker/src/rule-retro.ts#stampRetroDone: a rules write (.update(rulesTbl)) before the rule-key lock",
  // The backlog walks lock their own rule row, without the rule-key lock (BACKLOG-WALKS-SKIP-THE-RULE-KEY-LOCK).
  "apps/worker/src/gate-release.ts#gateReleasePass: a rules write (.update(rulesTbl)) before the rule-key lock",
  "apps/worker/src/gate-release.ts#gateReleasePass: held folder_state rows (.for(folderState)) taken after the change-log counter",
  // A one-time repair of an inferred press's provenance, no rule-key lock (BACKLOG-WALKS-SKIP-THE-RULE-KEY-LOCK).
  "packages/db/src/inferred-press-repair.ts#applyInferredPressRepair: a rules write (.update(rules)) before the rule-key lock",
  // Account erasure: it holds the account row first and empties every table in its own order.
  "packages/services/src/account-deletion-service.ts#deleteAccount: a rules write (.delete(rules)) before the rule-key lock",
  "packages/services/src/account-deletion-service.ts#deleteAccount: contacts (.delete(contacts)) taken after held folder_state rows",
  "packages/services/src/account-deletion-service.ts#deleteAccount: the change-log counter (.delete(accountSyncState)) taken after the graduation row",
  // Mailbox erasure: the same, for one mailbox.
  "packages/db/src/mailbox-erasure.ts#eraseOwedMailbox: held folder_state rows (.delete(folderState)) taken after the change-log counter",
  // The account read after the counter, the in-app move's old shape (WRITERS-READ-THE-ACCOUNT-AFTER-THE-COUNTER).
  "packages/services/src/message-service.ts#delete: the account row (fenceErased) taken after the change-log counter",
  "packages/services/src/message-service.ts#restore: the account row (fenceErased) taken after the change-log counter",
  // The account read after the counter (WRITERS-READ-THE-ACCOUNT-AFTER-THE-COUNTER).
  "packages/services/src/folder-ops-service.ts#create: the account row (fenceErased) taken after the change-log counter",
  "packages/services/src/folder-ops-service.ts#dismiss: the account row (fenceErased) taken after the change-log counter",
  "packages/services/src/folder-ops-service.ts#remove: the account row (fenceErased) taken after the change-log counter",
  "packages/services/src/folder-ops-service.ts#rename: the account row (fenceErased) taken after the change-log counter",
  // The account read after the counter (WRITERS-READ-THE-ACCOUNT-AFTER-THE-COUNTER).
  "packages/services/src/thread-service.ts#merge: the account row (fenceErased) taken after the change-log counter",
  // The account read after the counter (WRITERS-READ-THE-ACCOUNT-AFTER-THE-COUNTER).
  "packages/services/src/triage-service.ts#setState: the account row (fenceErased) taken after the change-log counter",
  // A mailbox row taken exclusively after the counter (WRITERS-READ-THE-ACCOUNT-AFTER-THE-COUNTER).
  "packages/api/src/routes/consent.ts#applyConsentSettings: a mailbox row FOR UPDATE (.update(mailboxes)) taken after the change-log counter",
  "packages/api/src/routes/consent.ts#applyConsentSettings: a mailbox row taken shared and then exclusively (.update(mailboxes))",
  // A mailbox row taken exclusively after contacts (WRITERS-READ-THE-ACCOUNT-AFTER-THE-COUNTER).
  "packages/services/src/send-service.ts#finalizeSent: a mailbox row FOR UPDATE (.update(mailboxes)) taken after contacts",
]);

describe("every writer under a sender's key takes one lock order", () => {
  it("the writers are derived, and every named one is among them", () => {
    console.log(`rule-lock-order census: ${DERIVED.length} writers derived by parse`);
    const derived = new Set(DERIVED.map((w) => `${w.file}#${w.name}`));
    const named = EXPECTED.filter((w) => w.fn !== undefined).map((w) => `${w.file}#${w.fn}`);
    expect(named.filter((k) => !derived.has(k)), "a named writer the derivation no longer finds").toEqual([]);
    expect(DERIVED.length).toBeGreaterThan(named.length);
  });

  it("every derived writer keeps the order, but for the readings named before the derivation", () => {
    const red = DERIVED.flatMap((w) => readingOf(w.file, w.node, w.name).out.map((o) => `${w.file}#${w.name}: ${o}`));
    expect(red.filter((r) => !KNOWN_READINGS.has(r)), "a writer out of order").toEqual([]);
    expect([...KNOWN_READINGS].filter((r) => !red.includes(r)), "a named reading that is gone: remove it").toEqual([]);
  });

  for (const w of EXPECTED) {
    it(`${w.fn ?? w.closure} (${w.file})`, () => {
      const r = w.fn !== undefined ? openerReading(w.file, w.fn) : closureReading(w.file, w.closure!);
      expect(r.opened, `${w.fn ?? w.closure} opens no transaction the census can read`).toBeGreaterThan(0);
      for (const cls of w.takes) expect([...r.seen], `the census no longer sees ${CHAIN[cls]}`).toContain(cls);
      expect(r.out).toEqual([]);
    });
  }

  it("the in-app move and the ingest's override write no rule: the demotion runs after their commit", () => {
    const rulesIn = (file: string, node: ts.Node): string[] => {
      const took: string[] = [];
      const cx: Ctx = { file, stack: ["<rules>"], off: new Set(), out: new Set(), seen: new Set(), took };
      walkAll(node, (n) => { const o = openerOf(n); if (o) fn(o.body.body, openingState(o, cx), cx); });
      if (openerOf(node) === null && !walkAllHasOpener(node)) fn((node as ts.FunctionLikeDeclaration).body!, single(start([ACCOUNT])), cx);
      return took.filter((l) => /rules|rulesTbl/.test(l));
    };
    expect(rulesIn("packages/services/src/message-service.ts", declsOf("packages/services/src/message-service.ts").get("move")!)).toEqual([]);
    expect(rulesIn("packages/core/src/adapters/drizzle-repo.ts", declsOf("packages/core/src/adapters/drizzle-repo.ts").get("recordExternalOverride")!)).toEqual([]);
    expect(rulesIn("packages/db/src/learning-signal.ts", declsOf("packages/db/src/learning-signal.ts").get("recordRouteOverride")!)).toEqual([]);
  });

  it("the drain hands a request its transaction after the fence", () => {
    const src = sourceOf("apps/worker/src/request-drain.ts").getFullText();
    const fence = src.indexOf("readAccountErasedAt(tx, dialect(tx), rt.accountId)");
    expect(fence, "the drain's fence is gone").toBeGreaterThan(0);
    expect(src.indexOf("runApply(tx)"), "the drain runs a request before its fence").toBeGreaterThan(fence);
  });

  it("the decision's own body keeps the order wherever it is called", () => {
    const decl = declsOf("packages/db/src/screener-apply.ts").get("applyScreenerDecision")!;
    const out = new Set<string>();
    const seen = new Set<number>();
    fn(decl.body!, single(start([ACCOUNT])), { file: "packages/db/src/screener-apply.ts", stack: ["applyScreenerDecision"], off: new Set(), out, seen });
    expect([...seen]).toEqual(expect.arrayContaining([SETTINGS, RULE_KEY, CONTACTS, FOLDER_STATE, COUNTER]));
    expect([...out]).toEqual([]);
  });

  /* THE ACT'S FILINGS WITHOUT A RULE (unconfirmed letters, and the one letter advice that may not stand
     was about) write nothing standing: no rule, no contact, no settings row, the decision's own order
     for what they do take. Helpers followed, as for the writers. */
  for (const door of ["rerouteUnconfirmedHeld", "rerouteAdvisedLetter"]) {
    it(`the act's filing without a rule (${door}) keeps the order and writes no rule, contact or setting`, () => {
      const decl = declsOf("packages/db/src/screener-apply.ts").get(door);
      expect(decl, `${door} is gone`).toBeDefined();
      const out = new Set<string>();
      const seen = new Set<number>();
      const took: string[] = [];
      fn(decl!.body!, single(start([ACCOUNT])), {
        file: "packages/db/src/screener-apply.ts", stack: [door], off: new Set(), out, seen, took,
      });
      expect([...out]).toEqual([]);
      expect([...seen]).toEqual(expect.arrayContaining([RULE_KEY, FOLDER_STATE, COUNTER]));
      expect([...seen].filter((c) => c === CONTACTS || c === SETTINGS || c === GRADUATION).map((c) => CHAIN[c])).toEqual([]);
      expect(took.filter((l) => /\brules\b|rulesTbl|writeRuleUnderKey|convergeRuleKey/.test(l)), "it writes a rule").toEqual([]);
    });
  }
});

describe("the census's own controls", () => {
  let n = 0;
  const plant = (src: string, more: Record<string, string> = {}): string[] => {
    for (const [f, s] of Object.entries(more)) sourceOf(f, s);
    const file = `planted/opener-${n++}.ts`;
    sourceOf(file, src);
    return openerReading(file, "f").out;
  };

  it("the admitted shape, with the counter last", () => {
    expect(plant(`async function f(db) { return fencedAccountWrite(db, { accountId }, async (tx) => {
      await dialect(tx).forUpdate(tx.select({}).from(accountSettings));
      await lockAccountRuleKeys(tx, a);
      await fenceErased(tx, d, { accountId, mailboxId: m, mailboxLock: "update" });
      await tx.insert(contacts).values({});
      await tx.update(rulesTbl).set({});
      await upsertDesired(tx, r, "INBOX", now);
      await readOrganizerRole(tx, d, a, m2, { lock: true });
      await recordChanges(tx, c);
      await tx.update(mailboxes).set({});
    }); }`)).toEqual([]);
  });

  it("settings before the fence (the auto-act pass's old opener) is refused", () => {
    expect(plant(`async function f(db) { return db.transaction(async (tx) => {
      await dialect(tx).forUpdate(tx.select({}).from(accountSettings));
      await readAccountErasedAt(tx, d, a);
    }); }`)).toEqual(["the account row (readAccountErasedAt) taken after account_settings"]);
  });

  it("folder_state before contacts (the release's old order) is refused, in the writer and in its own helper", () => {
    expect(plant(`async function f(db) { return fencedAccountWrite(db, { accountId }, async (tx) => {
      await dialect(tx).forUpdate(tx.select({}).from(folderState));
      await tx.insert(contacts).values({});
    }); }`)).toEqual(["contacts (.insert(contacts)) taken after held folder_state rows"]);
    expect(plant(`async function teach(tx) { await tx.insert(contacts).values({}); }
      async function f(ctx) { return withAccountTx(ctx, async (tx) => { await upsertDesired(tx, r, "INBOX", now); await teach(tx); }); }`))
      .toEqual(["contacts (.insert(contacts)) taken after held folder_state rows"]);
  });

  it("a mailbox row shared and then updated (the rescue's old doorbell) is refused", () => {
    expect(plant(`async function f(ctx) { return withAccountTx(ctx, async (tx) => {
      await fenceErased(tx, d, { accountId, mailboxId: m });
      await tx.update(mailboxes).set({});
    }); }`)).toEqual(["a mailbox row taken shared and then exclusively (.update(mailboxes))"]);
  });

  it("the rule-key lock after the mailbox row, and the import lock after it (the worker door's old order), are refused", () => {
    expect(plant(`async function f(ctx) { return withAccountTx(ctx, async (tx) => {
      await fenceErasedMailbox(tx, d, m, "update");
      await lockAccountRuleKeys(tx, a);
    }); }`)).toEqual(["the rule-key lock (lockAccountRuleKeys) taken after a mailbox row FOR UPDATE"]);
    expect(plant(`async function f(db) { return fencedAccountWrite(db, { accountId }, async (tx) => {
      await lockAccountRuleKeys(tx, a);
      await fenceErasedMailbox(tx, d, m, "update");
      await dialect(tx).advisoryLock(tx, PROFILE_IMPORT_LOCK_CLASS, a);
    }); }`)).toEqual(["the profile import lock (advisoryLock(profile import)) taken after a mailbox row FOR UPDATE"]);
  });

  it("a rules write with no rule-key lock before it (the reset's and the learning door's old writes) is refused", () => {
    expect(plant(`async function f(ctx) { return withAccountTx(ctx, async (tx) => {
      await tx.insert(rulesTbl).values({});
    }); }`)).toEqual(["a rules write (.insert(rulesTbl)) before the rule-key lock"]);
  });

  it("a lock taken in an arm that returns does not cover the code after it", () => {
    expect(plant(`async function f(ctx) { return withAccountTx(ctx, async (tx) => {
      if (promote) { await lockAccountRuleKeys(tx, a); await tx.insert(rulesTbl).values({}); return; }
      await tx.update(rulesTbl).set({});
    }); }`)).toEqual(["a rules write (.update(rulesTbl)) before the rule-key lock"]);
  });

  it("a helper's flag-guarded write is read unless the call passes that flag as a literal false", () => {
    const helper = `async function decide(tx, input) { const { stamp = true } = input;
      if (stamp) { await tx.insert(accountSettings).values({}); } }`;
    const call = (arg: string) => plant(`${helper} async function f(ctx) { return withAccountTx(ctx, async (tx) => {
      await lockAccountRuleKeys(tx, a); await decide(tx, ${arg}); }); }`);
    expect(call("{ stamp: false }")).toEqual([]);
    expect(call("{ stamp: true }")).toEqual(["account_settings (.insert(accountSettings)) taken after the rule-key lock"]);
    expect(call("{}")).toEqual(["account_settings (.insert(accountSettings)) taken after the rule-key lock"]);
  });

  // The review's planted shapes, each refused, with the shapes the order admits.
  it("a lock taken under a condition that does not exit covers nothing after it", () => {
    expect(plant(`async function f(ctx) { return withAccountTx(ctx, async (tx) => {
      if (allowing) await lockAccountRuleKeys(tx, a);
      await tx.insert(rulesTbl).values({});
    }); }`)).toEqual(["a rules write (.insert(rulesTbl)) before the rule-key lock"]);
    expect(plant(`async function f(ctx) { return withAccountTx(ctx, async (tx) => {
      if (allowing) { await lockAccountRuleKeys(tx, a); await tx.insert(rulesTbl).values({}); }
      else { await lockAccountRuleKeys(tx, a); }
      await tx.update(rulesTbl).set({});
    }); }`), "a lock taken on every path covers what follows").toEqual([]);
  });

  it("a helper defined in another file is followed through its import", () => {
    expect(plant(`import { teach } from "./other-p2"; async function f(ctx) { return withAccountTx(ctx, async (tx) => {
      await upsertDesired(tx, r, "INBOX", now);
      await teach(tx);
    }); }`, { "planted/other-p2.ts": `export async function teach(tx) { await tx.insert(contacts).values({}); }` }))
      .toEqual(["contacts (.insert(contacts)) taken after held folder_state rows"]);
    expect(plant(`import { stepOne } from "./other-p4"; async function f(ctx) { return withAccountTx(ctx, async (tx) => {
      await stepOne(tx);
      await lockAccountRuleKeys(tx, a);
      await tx.update(rulesTbl).set({});
    }); }`, { "planted/other-p4.ts": `export async function stepOne(tx) { await tx.insert(contacts).values({}); await fenceErasedMailbox(tx, d, m, "update"); }` }))
      .toEqual([
        "a mailbox row FOR UPDATE (fenceErasedMailbox) taken after contacts",
        "the rule-key lock (lockAccountRuleKeys) taken after contacts",
      ]);
  });

  it("the counter is in the chain; only a writer holding the rule-key lock takes it early", () => {
    expect(plant(`async function f(ctx) { return withAccountTx(ctx, async (tx) => {
      await recordChange(tx, c); await tx.insert(contacts).values({});
    }); }`)).toEqual(["contacts (.insert(contacts)) taken after the change-log counter"]);
    expect(plant(`async function f(ctx) { return withAccountTx(ctx, async (tx) => {
      await recordRuleDelta(tx, a, ids, "update"); await upsertDesired(tx, r, "INBOX", now);
    }); }`)).toEqual(["held folder_state rows (upsertDesired) taken after the change-log counter"]);
    // The reviewer's two shapes, admitted by the order as written: the exception, and the chain itself.
    expect(plant(`async function f(ctx) { return withAccountTx(ctx, async (tx) => {
      await lockAccountRuleKeys(tx, a); await recordRuleDelta(tx, a, ids, "create");
      await tx.insert(contacts).values({}); await upsertDesired(tx, r, "INBOX", now);
    }); }`)).toEqual([]);
    expect(plant(`async function f(ctx) { return withAccountTx(ctx, async (tx) => {
      await upsertDesired(tx, r, "INBOX", now); await recordChange(tx, c);
    }); }`)).toEqual([]);
  });
});

/* ── rules and graduations statements outside the two door files ──────────────────────────── */

/** The doors: every key-wide rules write converges in one, every graduation read and write in the other. */
const DOOR_FILES = new Set(["packages/db/src/rule-key.ts", "packages/db/src/learning-signal.ts"]);

/**
 * THE RULES WRITES OUTSIDE THE DOORS, by file and function, each with its reason. A ratchet that may
 * only shrink: a new site is refused by name, a stale entry is refused too.
 */
const RULES_WRITES_OUTSIDE: Readonly<Record<string, string>> = {
  "packages/db/src/request-apply.ts#reconcileRuleCreate": "a travelled create, after the key's converge",
  "packages/db/src/request-apply.ts#applyRuleRequest": "a travelled edit or removal, under the rule-key lock",
  "packages/db/src/inferred-press-repair.ts#applyInferredPressRepair": "the one-time repair of an inferred press's provenance",
  "packages/services/src/rules-service.ts#update": "the person's edit of the row they pressed, after the key's converge",
  "packages/services/src/rules-service.ts#remove": "the person's removal of every row under the key",
  "packages/services/src/consent-seed.ts#confirmSeed": "People you write to, inserted after the key check under the lock",
  "packages/services/src/held-release-service.ts#releaseHeld": "the held-release stamp on the pressed rule",
  "packages/services/src/account-deletion-service.ts#deleteAccount": "account erasure",
  "packages/services/src/consent-reset.ts#resetScreeningState": "resetting screening removes the account's rules",
  "packages/services/src/hey-migration.ts#undoMigration": "the import's undo of the rows it still owns",
  "packages/api/src/junk-window.ts#allowSender": "the spam rules a Not junk press switches off",
  "apps/worker/src/rule-retro.ts#ruleRetroPass": "the backlog walk's cursor and counter",
  "apps/worker/src/rule-retro.ts#stampRetroDone": "the backlog walk's finished stamp",
  "apps/worker/src/mailboxes.ts#clearOwedRetroFences": "an owed walk's cursor, cleared at a promotion",
  "apps/worker/src/screener-correspondent-retro.ts#retireAutoActRules": "the act's own spam rule retired over a correspondent",
  "apps/worker/src/gate-release.ts#gateReleasePass": "the gate release's stamp on its rule",
  "packages/core/src/adapters/organizer-profile-store.ts#applyOrganizerProfile": "the profile import's merge by natural key",
  "apps/sidecar/src/cloud-mirror.ts#applyAccountUpsert": "the device mirror applying a rule the Cloud already wrote",
  "apps/sidecar/src/cloud-mirror.ts#applyDelete": "the device mirror applying a removal the Cloud already wrote",
};
/** Graduation statements outside `learning-signal.ts`: erasure's delete, and no read at all. */
const GRADUATIONS_OUTSIDE: Readonly<Record<string, string>> = {
  "packages/services/src/account-deletion-service.ts#deleteAccount": "account erasure deletes the account's counters",
};

/** Every `rules`/`graduations` statement outside the door files, as `file#fn` with its verb. */
function statementsOutsideDoors(files: readonly string[]): { rules: string[]; graduations: string[] } {
  const rules = new Set<string>();
  const grads = new Set<string>();
  for (const file of files) {
    if (DOOR_FILES.has(file)) continue;
    walkAll(sourceOf(file), (n) => {
      if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
      const verb = n.expression.name.text;
      const t = bare(n.arguments[0]);
      if (!t || !ts.isIdentifier(t)) return;
      const at = `${file}#${enclosingName(n)}`;
      if (["insert", "update", "delete"].includes(verb) && (t.text === "rules" || t.text === "rulesTbl")) rules.add(at);
      if (["insert", "update", "delete", "from"].includes(verb) && t.text === "graduations") grads.add(`${at} (${verb})`);
    });
  }
  return { rules: [...rules].sort(), graduations: [...grads].sort() };
}

describe("rules and graduations statements stay in their door files", () => {
  const found = statementsOutsideDoors(SCANNED_ROOTS.flatMap(sourcesUnder));

  it("a rules write outside the doors is named, and no name is stale", () => {
    expect(found.rules.filter((k) => RULES_WRITES_OUTSIDE[k] === undefined), "a new rules write outside the doors").toEqual([]);
    expect(Object.keys(RULES_WRITES_OUTSIDE).filter((k) => !found.rules.includes(k)), "a stale entry").toEqual([]);
  });

  it("no graduation is read outside learning-signal.ts, and only erasure writes one", () => {
    const named = Object.keys(GRADUATIONS_OUTSIDE).map((k) => `${k} (delete)`);
    expect(found.graduations).toEqual(named);
  });

  it("CONTROL: a planted graduation read and a planted rules write are both found", () => {
    sourceOf("planted/outside-doors.ts", `async function peek(tx) { return tx.select().from(graduations); }
      async function poke(tx) { await tx.update(rulesTbl).set({}); }`);
    const planted = statementsOutsideDoors(["planted/outside-doors.ts"]);
    expect(planted).toEqual({ rules: ["planted/outside-doors.ts#poke"], graduations: ["planted/outside-doors.ts#peek (from)"] });
  });
});

describe("the derivation's and the new refusals' own controls", () => {
  let n = 0;
  const plant = (src: string, more: Record<string, string> = {}): string[] => {
    for (const [f, t] of Object.entries(more)) sourceOf(f, t);
    const file = `planted/derived-${n++}.ts`;
    sourceOf(file, src);
    return readingOf(file, declsOf(file).get("f")!, "f").out;
  };

  it("a planted opener with a rules write is DERIVED with no list edit, and one with no write is not", () => {
    sourceOf("planted/derive-yes.ts", `async function f(ctx) { return withAccountTx(ctx, async (tx) => { await lockAccountRuleKeys(tx, a); await tx.update(rulesTbl).set({}); }); }`);
    sourceOf("planted/derive-no.ts", `async function g(ctx) { return withAccountTx(ctx, async (tx) => { await tx.select().from(rulesTbl); }); }`);
    expect(deriveWriters(["planted/derive-yes.ts", "planted/derive-no.ts"]).map((w) => `${w.file}#${w.name}`))
      .toEqual(["planted/derive-yes.ts#f"]);
  });

  it("a lock inside a callback a helper may skip is refused by name", () => {
    expect(plant(`async function under(tx, cb) { if (fast) return; await cb(); }
      async function f(ctx) { return withAccountTx(ctx, async (tx) => { await under(tx, async () => { await lockAccountRuleKeys(tx, a); }); await tx.insert(rulesTbl).values({}); }); }`))
      .toEqual(["a lock (lockAccountRuleKeys) inside a callback passed to under, which may skip it or run it twice"]);
  });

  it("a dynamic import inside a writer's closure is refused by name", () => {
    expect(plant(`async function f(ctx) { return withAccountTx(ctx, async (tx) => { await upsertDesired(tx, r, "INBOX", now); const m = await ${"import"}("./v026-dyn"); await m.teach(tx); }); }`,
      { "planted/v026-dyn.ts": `export async function teach(tx) { await tx.insert(contacts).values({}); }` }))
      .toEqual(["a dynamic import (./v026-dyn) inside a writer's closure: the walk cannot follow it"]);
  });

  it("a raw rules write is read as one, and a raw statement it cannot classify is refused", () => {
    expect(plant(`async function f(ctx) { return withAccountTx(ctx, async (tx) => { await tx.execute(sql\`update rules set enabled = false where account_id = \${a}\`); }); }`))
      .toEqual(["a rules write (raw update on rules) before the rule-key lock"]);
    expect(plant(`async function f(ctx) { return withAccountTx(ctx, async (tx) => { await tx.execute(sql\`with x as (delete from graduations) select 1\`); }); }`))
      .toEqual(["a raw statement the census cannot classify (raw with on graduations)"]);
    expect(plant(`async function f(ctx) { return withAccountTx(ctx, async (tx) => { await tx.execute(sql\`select count(*) from rules where account_id = \${a}\`); }); }`),
      "a plain read is admitted").toEqual([]);
  });

  it("the graduation row before the counter (the lifetime demotion's old shape) is refused", () => {
    expect(plant(`async function f(ctx) { return withAccountTx(ctx, async (tx) => { await lockAccountRuleKeys(tx, a); await tx.update(rulesTbl).set({}); await tx.update(graduations).set({}); await recordRuleDelta(tx, a, ids, "update"); }); }`))
      .toEqual(["the change-log counter (recordRuleDelta) taken after the graduation row"]);
    expect(plant(`async function f(ctx) { return withAccountTx(ctx, async (tx) => { await lockAccountRuleKeys(tx, a); await tx.update(rulesTbl).set({}); await recordRuleDelta(tx, a, ids, "update"); await tx.update(graduations).set({}); }); }`),
      "the door's order is admitted").toEqual([]);
  });

  it("held folder_state after a graduation row is refused", () => {
    expect(plant(`async function f(ctx) { return withAccountTx(ctx, async (tx) => { await tx.update(graduations).set({}); await upsertDesired(tx, r, "INBOX", now); }); }`))
      .toEqual(["held folder_state rows (upsertDesired) taken after the graduation row"]);
  });
});
