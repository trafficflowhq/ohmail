/**
 * EVERY SEND RECORD LEAVES BY ONE DOOR. Three review rounds
 * found a HIGH on the send record's lifetime, each through a different site that deleted a record
 * while its send could still end. The predicate is `mayDrop` behind `dropSendLocks` in
 * `send-lock.ts`, and the only reading it may be handed is `sendLockOwed` from `mail-send.ts`. This
 * census parses for CALLS and references, so a deleting site has to come through the door. Each
 * shape it refuses is planted into a copy of the real file and refused by name; the real tree is
 * admitted.
 */
/* @reads: apps/webapp/app/shell/send-lock.ts apps/desktop/src/window-sweep.ts */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const SEND_LOCK = resolve(ROOT, "apps/webapp/app/shell/send-lock.ts");
const JAR_PREFIX = "ohmail.send.locks";

/**
 * THE THIRD DOOR TO THE JAR'S PREFIX (ruled 2026-11-04), beside the web's sign-out and the host door's pairing end:
 * the desktop window's sweep of an ERASED account, in that one function. The engine discards the window's outbox with
 * an erased account, so no send is owed and nothing else would ever prune its lanes. Sign out and a revoke keep them
 * (the outbox replays at the next sign-in and the record still guards against a second send), so anywhere else in the
 * file the prefix is refused; the desktop gate's behaviour tests pin that only the erasure calls it.
 */
const ERASURE_DOOR = { path: "apps/desktop/src/window-sweep.ts", fn: "forgetErasedWindowScopes" };

/** The only functions that may call `save`: the door, the decoder's retirement, two same-length rewrites. */
const SAVERS = new Set(["dropSendLocks", "load", "attachSendLockDraft", "markSendLockUnverified"]);
/** Writers that must not shorten a list on the way: a filter there is a deletion outside the door. */
const NO_FILTER = new Set(["claimSendLock", "attachSendLockDraft", "markSendLockUnverified"]);
/** Each function that can delete a record, and where its `owed` argument sits. */
const OWED_AT = new Map<string, number>([
  ["dropSendLocks", 1], ["claimSendLock", 1], ["releaseSendLock", 2], ["readSendLock", 3], ["resumeSendLock", 3],
  ["allSendLocks", 1], ["releaseSendLockForRow", 3],
]);

const parse = (src: string, file: string): ts.SourceFile =>
  ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

function enclosingFn(n: ts.Node): ts.FunctionLikeDeclaration | null {
  for (let p: ts.Node | undefined = n.parent; p !== undefined; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p;
  }
  return null;
}
const fnName = (n: ts.Node): string => {
  const f = enclosingFn(n);
  return f?.name && ts.isIdentifier(f.name) ? f.name.text : "<module>";
};
const calleeName = (c: ts.CallExpression): string =>
  ts.isIdentifier(c.expression) ? c.expression.text
    : ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : "";
const isParamOf = (fn: ts.FunctionLikeDeclaration | null, name: string): boolean =>
  fn !== null && fn.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name);

function walk(sf: ts.SourceFile, visit: (n: ts.Node) => void): void {
  const go = (n: ts.Node): void => { visit(n); ts.forEachChild(n, go); };
  go(sf);
}

/** A string or template fragment spelling the jar's prefix, outside its one declaration. */
function prefixLiterals(sf: ts.SourceFile): ts.Node[] {
  const out: ts.Node[] = [];
  walk(sf, (n) => {
    const text = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n)
      || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) ? n.text : null;
    if (text === null || !text.includes(JAR_PREFIX)) return;
    const decl = n.parent;
    if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && decl.name.text === "SEND_LOCKS_PREFIX") return;
    out.push(n);
  });
  return out;
}

/** The refusals over `send-lock.ts`'s own text. Empty = admitted. */
function censusOfSendLock(src: string): string[] {
  const sf = parse(src, "send-lock.ts");
  const refusals: string[] = [];
  let doorLoads = false;
  walk(sf, (n) => {
    if (ts.isIdentifier(n) && n.text === "save") {
      const p = n.parent;
      const declared = ts.isFunctionDeclaration(p) && p.name === n;
      const called = ts.isCallExpression(p) && p.expression === n;
      if (!declared && !called) refusals.push(`save referenced without a call, in ${fnName(n)}`);
      if (called && !SAVERS.has(fnName(n))) refusals.push(`save() outside the door, in ${fnName(n)}`);
    }
    if (!ts.isCallExpression(n)) return;
    const name = calleeName(n);
    const fn = fnName(n);
    if ((name === "durableSet" || name === "durableRemove") && fn !== "save") refusals.push(`${name}() outside save, in ${fn}`);
    if ((name === "setItem" || name === "removeItem") && ts.isPropertyAccessExpression(n.expression)) {
      refusals.push(`a storage ${name}() in ${fn}`);
    }
    if (name === "filter" && NO_FILTER.has(fn)) refusals.push(`.filter() in the writer ${fn}`);
    if (fn === "dropSendLocks" && name === "loadOrEmpty") doorLoads = true;
    const at = OWED_AT.get(name);
    if (at !== undefined && ts.isIdentifier(n.expression)) {
      const arg = n.arguments[at];
      if (arg === undefined || !ts.isIdentifier(arg) || arg.text !== "owed" || !isParamOf(enclosingFn(n), "owed")) {
        refusals.push(`${name} in ${fn} is handed an owed that is not its caller's own owed parameter`);
      }
    }
  });
  if (!doorLoads) refusals.push("dropSendLocks does not read the jar itself");
  for (const lit of prefixLiterals(sf)) refusals.push(`the jar's prefix spelled as a literal, in ${fnName(lit)}`);
  return refusals;
}

/** `sendLockOwed(engine)` — the one reading, over the engine the surrounding hook or helper holds. */
const isOwedCall = (e: ts.Expression): boolean =>
  ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "sendLockOwed"
  && e.arguments.length === 1 && ts.isIdentifier(e.arguments[0]!) && e.arguments[0]!.text === "engine";

/** The declaration a name resolves to at `at`: the NEAREST enclosing block or function that binds it. */
function nearestBinding(name: string, at: ts.Node): ts.Node | null {
  for (let p: ts.Node | undefined = at.parent; p !== undefined; p = p.parent) {
    if (ts.isBlock(p) || ts.isSourceFile(p) || ts.isModuleBlock(p) || ts.isCaseClause(p) || ts.isDefaultClause(p)) {
      for (const st of p.statements) {
        if (ts.isVariableStatement(st)) {
          for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return d;
        }
        if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st;
      }
    }
    if (ts.isFunctionLike(p)) {
      for (const prm of p.parameters) if (ts.isIdentifier(prm.name) && prm.name.text === name) return prm;
    }
  }
  return null;
}

/** Is `arg` the one reading — `sendLockOwed(engine)`, or a name whose nearest binding is a const of it? */
function isOwedReading(arg: ts.Expression, at: ts.Node): boolean {
  if (isOwedCall(arg)) return true;
  if (!ts.isIdentifier(arg)) return false;
  const d = nearestBinding(arg.text, at);
  return d !== null && ts.isVariableDeclaration(d) && (d.parent.flags & ts.NodeFlags.Const) !== 0
    && d.initializer !== undefined && isOwedCall(d.initializer);
}

/** The refusals over the product sources that reach the jar. */
function censusOfCallers(files: Array<{ path: string; src: string }>): string[] {
  const refusals: string[] = [];
  for (const { path, src } of files) {
    if (path.endsWith("shell/send-lock.ts")) continue;
    const sf = parse(src, path);
    walk(sf, (n) => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && /send-lock(\.js)?$/.test(n.moduleSpecifier.text)) {
        const b = n.importClause?.namedBindings;
        if (b !== undefined && ts.isNamespaceImport(b)) refusals.push(`${path}: a namespace import of send-lock`);
        if (b !== undefined && ts.isNamedImports(b)) {
          for (const el of b.elements) if (el.propertyName !== undefined) refusals.push(`${path}: an aliased import of ${el.propertyName.text}`);
        }
      }
      if (ts.isIdentifier(n) && n.text === "SEND_LOCKS_PREFIX" && !/(^|\/)(sign-out\.ts|HostGate\.tsx)$/.test(path)) {
        if (path !== ERASURE_DOOR.path) refusals.push(`${path}: names the jar's prefix`);
        else if (!ts.isImportSpecifier(n.parent) && fnName(n) !== ERASURE_DOOR.fn) {
          refusals.push(`${path}: names the jar's prefix outside ${ERASURE_DOOR.fn}`);
        }
      }
      if (!ts.isCallExpression(n)) return;
      const name = calleeName(n);
      if (name === "sendLocksKey") refusals.push(`${path}: names the jar's key`);
      if (name === "sendUnsettledFromLastSession" && ts.isIdentifier(n.expression)) {
        const standing = n.arguments[5];
        if (standing === undefined || !ts.isCallExpression(standing) || calleeName(standing) !== "standingOf") {
          refusals.push(`${path}: sendUnsettledFromLastSession handed a standing that is not standingOf(…)`);
        }
      }
      const at = OWED_AT.get(name);
      if (at === undefined) return;
      const arg = n.arguments[at];
      // Inside the hold's own read, the one admitted pass-through: its `standing` is checked at its callers.
      const passThrough = arg !== undefined && fnName(n) === "sendUnsettledFromLastSession"
        && ts.isPropertyAccessExpression(arg) && ts.isIdentifier(arg.expression) && arg.expression.text === "standing"
        && arg.name.text === "owed" && isParamOf(enclosingFn(n), "standing");
      if (arg === undefined) refusals.push(`${path}: ${name} with no owed argument`);
      else if (!passThrough && !isOwedReading(arg, n)) refusals.push(`${path}: ${name} handed an owed that is not sendLockOwed(…)`);
    });
    for (const lit of prefixLiterals(sf)) refusals.push(`${path}: the jar's prefix spelled as a literal, in ${fnName(lit)}`);
  }
  return refusals;
}

function productFiles(): Array<{ path: string; src: string }> {
  const out: Array<{ path: string; src: string }> = [];
  const go = (dir: string): void => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (n === "node_modules" || n.startsWith(".")) continue;
      if (statSync(p).isDirectory()) go(p);
      else if (/\.(ts|tsx)$/.test(n)) out.push({ path: relative(ROOT, p), src: readFileSync(p, "utf8") });
    }
  };
  go(resolve(ROOT, "apps/webapp/app"));
  go(resolve(ROOT, "packages/app-logic/src"));
  go(resolve(ROOT, "apps/desktop/src"));
  return out;
}

describe("a send record leaves the jar by one door", () => {
  const real = readFileSync(SEND_LOCK, "utf8");

  it("the real send-lock.ts is admitted (the positive control)", () => {
    expect(censusOfSendLock(real)).toEqual([]);
  });

  const lockPlants: Array<[string, string, string]> = [
    ["a prune that saves a filtered list",
      "export function pruneOld(nowMs: number): void {\n  const rows = loadOrEmpty(null);\n  save(rows.filter((r) => nowMs - r.at < 1), null);\n}",
      "save() outside the door, in pruneOld"],
    ["an aliased save",
      "export function pruneA(nowMs: number): void {\n  const s = save; const rows = loadOrEmpty(null);\n  s(rows.filter((r) => nowMs - r.at < 1), null);\n}",
      "save referenced without a call, in pruneA"],
    ["save.call",
      "export function pruneB(nowMs: number): void {\n  const rows = loadOrEmpty(null);\n  save.call(null, rows.filter((r) => nowMs - r.at < 1), null);\n}",
      "save referenced without a call, in pruneB"],
    ["a direct durableSet of the jar",
      "export function pruneC(nowMs: number): void {\n  const rows = loadOrEmpty(null);\n  durableSet(sendLocksKey(null), JSON.stringify(rows.filter((r) => nowMs - r.at < 1)), \"send.locks\");\n}",
      "durableSet() outside save, in pruneC"],
    ["a direct localStorage.setItem of the jar",
      "export function pruneD(): void {\n  window.localStorage.setItem(sendLocksKey(null), \"[]\");\n}",
      "a storage setItem() in pruneD"],
    ["a named never-owed handed to the door",
      "export function pruneE(nowMs: number): void {\n  const never = (_r: SendLock): boolean => false;\n  dropSendLocks(() => \"ended\", never, nowMs, null);\n}",
      "dropSendLocks in pruneE is handed an owed that is not its caller's own owed parameter"],
    ["the jar's prefix as a literal",
      "export function pruneF(): void {\n  window.localStorage.removeItem(`ohmail.send.locks.${\"local\"}`);\n}",
      "the jar's prefix spelled as a literal, in pruneF"],
  ];
  for (const [what, code, refusal] of lockPlants) {
    it(`send-lock.ts: ${what} is refused by name`, () => {
      expect(censusOfSendLock(`${real}\n${code}\n`)).toContain(refusal);
    });
  }

  it("a filter planted in claimSendLock is refused by name", () => {
    const anchor = "export function claimSendLock(lock: SendLock, owed: SendLockOwed, owner: string | null = storageOwner()): void {";
    expect(real.includes(anchor), "the anchor moved").toBe(true);
    const planted = real.replace(anchor, `${anchor}\n  void loadOrEmpty(owner).filter((r) => r.lane !== lock.lane);`);
    expect(censusOfSendLock(planted)).toEqual([".filter() in the writer claimSendLock"]);
  });

  it("every product caller hands the deleting functions sendLockOwed, and nothing else reaches the jar", () => {
    const files = productFiles();
    expect(files.length, "the walk read nothing").toBeGreaterThan(100);
    const reached = files
      .filter((f) => !f.path.endsWith("shell/send-lock.ts"))
      .filter((f) => { let hit = false; walk(parse(f.src, f.path), (n) => { if (ts.isCallExpression(n) && OWED_AT.has(calleeName(n))) hit = true; }); return hit; })
      .map((f) => f.path).sort();
    expect(reached, "the callers this census reads").toEqual([
      "apps/webapp/app/shell/compose-autosave.ts", "apps/webapp/app/shell/mail-send.ts", "apps/webapp/app/shell/shell-compose.ts",
    ]);
    expect(censusOfCallers(files)).toEqual([]);
  });

  const callerPlants: Array<[string, string, string]> = [
    ["a literal never-owed", "releaseSendLock(lane, fp, () => false, owner);\n",
      "apps/webapp/app/shell/planted.ts: releaseSendLock handed an owed that is not sendLockOwed(…)"],
    ["a named never-owed", "const never = () => false;\nreleaseSendLock(lane, fp, never, owner);\n",
      "apps/webapp/app/shell/planted.ts: releaseSendLock handed an owed that is not sendLockOwed(…)"],
    ["the jar's prefix as a literal", "window.localStorage.setItem(`ohmail.send.locks..${o}`, '[]');\n",
      "apps/webapp/app/shell/planted.ts: the jar's prefix spelled as a literal, in <module>"],
    ["an aliased import", "import { releaseSendLock as r } from './send-lock';\nr(lane, fp, () => false, owner);\n",
      "apps/webapp/app/shell/planted.ts: an aliased import of releaseSendLock"],
    ["a namespace call", "import * as SL from './send-lock';\nSL.releaseSendLock(lane, fp, () => false, owner);\n",
      "apps/webapp/app/shell/planted.ts: a namespace import of send-lock"],
    ["a hand-made standing for the hold", "sendUnsettledFromLastSession(l, latch, keys, false, o, { settled: () => true, owed: () => false });\n",
      "apps/webapp/app/shell/planted.ts: sendUnsettledFromLastSession handed a standing that is not standingOf(…)"],
    ["a never-owed const shadowing the bound one in an inner block",
      "function f(engine) {\n  const owed = sendLockOwed(engine);\n  if (lane) {\n    const owed = () => false;\n    releaseSendLock(lane, fp, owed, owner);\n  }\n}\n",
      "apps/webapp/app/shell/planted.ts: releaseSendLock handed an owed that is not sendLockOwed(…)"],
    ["sendLockOwed over a hand-made engine",
      "function f(engine) {\n  releaseSendLock(lane, fp, sendLockOwed({ outboxKnown: () => true } as never), owner);\n}\n",
      "apps/webapp/app/shell/planted.ts: releaseSendLock handed an owed that is not sendLockOwed(…)"],
  ];
  for (const [what, src, refusal] of callerPlants) {
    it(`a caller: ${what} is refused by name`, () => {
      expect(censusOfCallers([{ path: "apps/webapp/app/shell/planted.ts", src }])).toContain(refusal);
    });
  }

  it("a caller handing a const bound to sendLockOwed is admitted (the callers' positive control)", () => {
    const src = "function f(engine) {\n  const owed = sendLockOwed(engine);\n  releaseSendLock(lane, fp, owed, owner);\n  claimSendLock(lock, sendLockOwed(engine), owner);\n}\n";
    expect(censusOfCallers([{ path: "apps/webapp/app/shell/planted.ts", src }])).toEqual([]);
  });

  const sweep = readFileSync(resolve(ROOT, ERASURE_DOOR.path), "utf8");
  const outside = `${ERASURE_DOOR.path}: names the jar's prefix outside ${ERASURE_DOOR.fn}`;

  it("window-sweep.ts is admitted, naming the jar's prefix in the erasure's sweep alone", () => {
    expect(censusOfCallers([{ path: ERASURE_DOOR.path, src: sweep }])).toEqual([]);
    const renamed = sweep.replace(`export function ${ERASURE_DOOR.fn}(`, "export function forgetEveryWindowScope(");
    expect(renamed, "the anchor moved").not.toBe(sweep);
    expect(censusOfCallers([{ path: ERASURE_DOOR.path, src: renamed }])).toContain(outside);
  });

  const sweepPlants: Array<[string, string, string]> = [
    ["the send lanes in the list every end sweeps", "export const WINDOW_SCOPED_PREFIXES: readonly string[] = [", "SEND_LOCKS_PREFIX, "],
    ["a send-lane sweep in Sign out's and a revoke's sweep",
      "export function forgetWindowScopes(scopes: readonly (string | null | undefined)[]): LocalSweep | null {",
      "\n  dropLocalStorageKeysWhere((k) => k.startsWith(SEND_LOCKS_PREFIX));"],
  ];
  for (const [what, anchor, plant] of sweepPlants) {
    it(`window-sweep.ts: ${what} is refused by name`, () => {
      expect(sweep.includes(anchor), "the anchor moved").toBe(true);
      expect(censusOfCallers([{ path: ERASURE_DOOR.path, src: sweep.replace(anchor, `${anchor}${plant}`) }])).toEqual([outside]);
    });
  }

  it("the erasure's sweep in another file is refused by name: the door is one file", () => {
    const src = "export function forgetErasedWindowScopes(s: string[]) {\n  return dropLocalStorageKeysWhere((k) => s.some((x) => k === `${SEND_LOCKS_PREFIX}${x}`));\n}\n";
    expect(censusOfCallers([{ path: "apps/desktop/src/planted.ts", src }])).toEqual(["apps/desktop/src/planted.ts: names the jar's prefix"]);
  });
});
