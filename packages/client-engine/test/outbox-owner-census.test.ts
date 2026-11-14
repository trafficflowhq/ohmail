/**
 * TWO PINS ON ONE OWNER PER WAITING SEND, parsed for calls:
 * 1. every write transaction of the two shared-disk stores (`idb.ts`, the paired page's) tells the
 *    other windows once it has committed: a write nobody hears of is a send a window cannot see;
 * 2. `restoreEntry` (the one door into the queue for a stored row) has exactly two callers, both
 *    owner-aware: the boot restore skips another engine's row, and adoption queues only what its
 *    compare-and-set took. Each refusal is planted into a copy of the real file; the tree is admitted.
 */
/* @reads: packages/client-engine/src/idb.ts */
/* @reads: packages/client-engine/src/engine.ts packages/client-engine/src/engine (the classes the engine is built from) */
/* @reads: apps/desktop/src/host-client/outbox-store.ts */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { engineSource } from "./helpers/engine-source.js";

const ROOT = process.cwd();
const IDB = resolve(ROOT, "packages/client-engine/src/idb.ts");
const HOST = resolve(ROOT, "apps/desktop/src/host-client/outbox-store.ts");

const parse = (src: string): ts.SourceFile => ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true);
function walk(n: ts.Node, visit: (n: ts.Node) => void): void {
  visit(n);
  ts.forEachChild(n, (c) => walk(c, visit));
}
/** `a.b.c(` as "a.b.c", `f(` as "f"; optional chains read the same. */
function calleeText(c: ts.CallExpression): string {
  const e = c.expression;
  return ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) ? e.getText().replace(/\?\./g, ".") : "";
}
function methodsOf(sf: ts.SourceFile, className: string | RegExp): ts.MethodDeclaration[] {
  const out: ts.MethodDeclaration[] = [];
  const named = (name: string): boolean => (typeof className === "string" ? name === className : className.test(name));
  walk(sf, (n) => {
    if (ts.isClassDeclaration(n) && n.name !== undefined && named(n.name.text)) {
      for (const m of n.members) if (ts.isMethodDeclaration(m) && m.body) out.push(m);
    }
  });
  return out;
}
const nameOf = (m: ts.MethodDeclaration): string => (ts.isIdentifier(m.name) ? m.name.text : m.name.getText());

/**
 * The methods whose LAST committing call (`commit`) is not followed by a notice call (`notice`).
 * Position order inside the method body: the notice is said after the commit, never before it.
 */
function unheardWrites(src: string, className: string, commit: string, notice: RegExp): string[] {
  const out: string[] = [];
  for (const m of methodsOf(parse(src), className)) {
    const calls: ts.CallExpression[] = [];
    walk(m.body!, (n) => { if (ts.isCallExpression(n)) calls.push(n); });
    const commits = calls.filter((c) => calleeText(c) === commit);
    if (commits.length === 0) continue;
    const last = Math.max(...commits.map((c) => c.getStart()));
    if (!calls.some((c) => notice.test(calleeText(c)) && c.getStart() > last)) out.push(nameOf(m));
  }
  return out;
}

const IDB_NOTICE = /^this\.(noticeOutbox|bus\.post)$/;
const HOST_NOTICE = /^this\.bus\.(changed|post)$/;

describe("every committed write of a shared outbox disk tells the other windows", () => {
  it("the IndexedDB mirror: every method that commits a write transaction posts afterwards", () => {
    const src = readFileSync(IDB, "utf8");
    const committing = methodsOf(parse(src), "IndexedDbMirrorStore").filter((m) => m.body!.getText().includes("commitWrite("));
    expect(committing.map(nameOf).sort(), "the write sites this census reads").toEqual(
      ["adoptOrphans", "bindOwner", "decideOnDisk", "persist", "purge", "transact", "wipe"],
    );
    expect(unheardWrites(src, "IndexedDbMirrorStore", "commitWrite", IDB_NOTICE)).toEqual([]);
  });

  it("the paired page's store: every committed write posts afterwards", () => {
    const src = readFileSync(HOST, "utf8");
    const committing = methodsOf(parse(src), "HostOutboxStore").filter((m) => m.body!.getText().includes("committed("));
    expect(committing.map(nameOf).sort(), "the write sites this census reads").toEqual(["adoptOrphans", "decideOnDisk", "write"]);
    expect(unheardWrites(src, "HostOutboxStore", "committed", HOST_NOTICE)).toEqual([]);
  });

  it("controls: a write whose notice is removed, or said before the commit, is refused by name", () => {
    const src = readFileSync(IDB, "utf8");
    const dropped = src.replace("    await commitWrite(tx);\n    this.noticeOutbox(keys);", "    await commitWrite(tx);");
    expect(dropped, "the planted shape exists in the real file").not.toBe(src);
    expect(unheardWrites(dropped, "IndexedDbMirrorStore", "commitWrite", IDB_NOTICE)).toEqual(["purge"]);
    const early = src.replace("    await commitWrite(tx);\n    this.noticeOutbox(keys);", "    this.noticeOutbox(keys);\n    await commitWrite(tx);");
    expect(unheardWrites(early, "IndexedDbMirrorStore", "commitWrite", IDB_NOTICE)).toEqual(["purge"]);
  });
});

/** The engine and the classes it is built from, one per file of `src/engine/`. */
const ENGINE_CLASSES = /^(OhmailEngine|Engine[A-Z]\w*)$/;

/** Each `this.restoreEntry(` call by the method it sits in, with the method's node. */
function restoreCallers(src: string): Array<{ method: string; call: ts.CallExpression; body: ts.Block }> {
  const out: Array<{ method: string; call: ts.CallExpression; body: ts.Block }> = [];
  for (const m of methodsOf(parse(src), ENGINE_CLASSES)) {
    walk(m.body!, (n) => {
      if (ts.isCallExpression(n) && calleeText(n) === "this.restoreEntry") out.push({ method: nameOf(m), call: n, body: m.body! });
    });
  }
  return out;
}

/** The boot restore's loop skips another engine's row before the call: `owner` compared with `this.ownerName`, then `continue`. */
function skipsForeignRows(body: ts.Block, call: ts.CallExpression): boolean {
  let loop: ts.Node | undefined = call.parent;
  while (loop !== undefined && !ts.isForOfStatement(loop)) loop = loop.parent;
  if (loop === undefined || !ts.isForOfStatement(loop) || !ts.isBlock(loop.statement)) return false;
  return loop.statement.statements.some((st) => ts.isIfStatement(st) && st.getStart() < call.getStart()
    && /\.owner\b/.test(st.expression.getText()) && st.expression.getText().includes("this.ownerName")
    && ts.isContinueStatement(st.thenStatement)) && body.getText().includes("this.ownershipOn()");
}

/** Adoption queues only rows its compare-and-set took: the argument's source is `this.store.adoptOrphanedOutbox(...)`. */
function queuesOnlyTaken(body: ts.Block, call: ts.CallExpression): boolean {
  let loop: ts.Node | undefined = call.parent;
  while (loop !== undefined && !ts.isForOfStatement(loop)) loop = loop.parent;
  if (loop === undefined || !ts.isForOfStatement(loop) || !ts.isIdentifier(loop.expression)) return false;
  const name = loop.expression.text;
  let fromCas = false;
  walk(body, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer
      && /this\.store\.adoptOrphanedOutbox\(/.test(n.initializer.getText())) fromCas = true;
  });
  return fromCas;
}

describe("restoreEntry has two callers, and both read the entry's owner", () => {
  const verdict = (src: string): string[] => restoreCallers(src).map(({ method, call, body }) =>
    method === "restoreOutboxOnce" ? `${method}:${skipsForeignRows(body, call) ? "owner-aware" : "BLIND"}`
      : method === "adoptOrphanedOutbox" ? `${method}:${queuesOnlyTaken(body, call) ? "owner-aware" : "BLIND"}`
        : `${method}:UNNAMED`);

  it("the real engine", () => {
    expect(verdict(engineSource()).sort()).toEqual(["adoptOrphanedOutbox:owner-aware", "restoreOutboxOnce:owner-aware"]);
  });

  it("controls: the ownership filter removed, a third caller, adoption over another list", () => {
    const src = engineSource();
    const filter = "      if (ownership && typeof e.owner === \"string\" && e.owner !== this.ownerName) continue;\n";
    expect(src.includes(filter), "the planted shape exists in the real file").toBe(true);
    expect(verdict(src.replace(filter, "")).sort()).toEqual(["adoptOrphanedOutbox:owner-aware", "restoreOutboxOnce:BLIND"]);
    const third = src.replace("  protected repaintRestored(): boolean {\n", "  protected replayAll(e: PersistedOutboxEntry): void { this.restoreEntry(e); }\n\n  protected repaintRestored(): boolean {\n");
    expect(third).not.toBe(src);
    expect(verdict(third).sort()).toEqual(["adoptOrphanedOutbox:owner-aware", "replayAll:UNNAMED", "restoreOutboxOnce:owner-aware"]);
    const other = src.replace("for (const e of taken) if (isPersistedOutboxEntry(e) && this.restoreEntry(e))", "for (const e of this.store.entries(OUTBOX_TYPE)) if (isPersistedOutboxEntry(e) && this.restoreEntry(e))");
    expect(other).not.toBe(src);
    expect(verdict(other).sort()).toEqual(["adoptOrphanedOutbox:BLIND", "restoreOutboxOnce:owner-aware"]);
  });
});
